const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const os = require("os");
const path = require("path");
const tls = require("tls");
const zlib = require("zlib");

const VERSION = "1.0.0";
const PLUGIN_NAME = "antigravity-cli-wakatime";
const GITHUB_DOWNLOAD_URL = "https://github.com/wakatime/wakatime-cli/releases/latest/download";
const GITHUB_RELEASES_URL = "https://api.github.com/repos/wakatime/wakatime-cli/releases/latest";

const BACKFILL_STATE_FILE = "antigravity-history-backfill.json";

const DEFAULT_BACKFILL_DAYS = 42;
const DEFAULT_BACKFILL_BATCH_SIZE = 500;
const BACKFILL_BUCKET_MS = 2 * 60 * 1000;

const HISTORY_APP_DIRS = ["antigravity-cli", "antigravity", "antigravity-ide"];

const ENABLE_CONSOLE_LOG =
  process.argv.includes("--backfill-history") || process.argv.includes("--verbose-log") || String(process.env.ANTIGRAVITY_WAKATIME_CONSOLE_LOG || "").toLowerCase() === "true";

main().catch((error) => {
  logException("ERROR", error);
  process.exit(0);
});

async function main() {
  // console.log(getHomeDirectory());
  // console.log(getWakatimeDir());
  // console.log(getConfigFile());

  // console.log(architecture());
  // console.log(osName());
  // console.log(os.platform());

  // console.log(getCliLocation());
  // console.log(cliDownloadUrl());

  // console.log(await getAntigravityVersion());

  if (process.argv.includes("--backfill-history")) {
    log("DEBUG", "Running in manual backfill mode.");
    // In manual mode stdin is usually a terminal; reading from fd 0 would block forever.
    const input = {};
    const forceBackfill = process.argv.includes("--force-backfill");
    const cliPath = await ensureWakatimeCli({ checkLatest: true });
    if (forceBackfill) {
      await syncTranscriptLineBackfill(cliPath);
    }
    await syncHistoricalHeartbeats(cliPath, input, { force: forceBackfill });
    return;
  }

  if (process.argv.includes("--background")) {
    log("DEBUG", "Running in background hook launcher mode.");
    launchBackground();
    return;
  }

  const input = readInput();
  if (!input) return;

  if (getSetting("settings", "debug") === "true") {
    log("DEBUG", JSON.stringify(input, null, 2));
  }

  const eventName = getEventName(input);
  log("DEBUG", `Processing hook event: ${eventName || "<unknown>"}`);
  if (eventName === "sessionStart") {
    const cliPath = await ensureWakatimeCli({ checkLatest: true });
    await syncHistoricalHeartbeats(cliPath, input);
    return;
  }

  if (!shouldSyncHeartbeat(eventName)) return;

  const cliPath = await ensureWakatimeCli({ checkLatest: eventName === "preInvocation" && isInitialInvocation(input) });
  if (eventName === "preInvocation" && isInitialInvocation(input)) {
    await syncHistoricalHeartbeats(cliPath, input);
  }
  await syncAiHeartbeats(cliPath, input);
}

function launchBackground() {
  try {
    const stdin = fs.readFileSync(0);
    if (!stdin.length || !stdin.toString("utf8").trim()) {
      process.stdout.write("{}\n");
      return;
    }

    const eventName = getArgumentValue("--event");
    const args = [__filename];
    if (eventName) args.push(`--event=${eventName}`);

    const child = childProcess.spawn(process.execPath, args, {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      env: process.env,
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
    child.unref();
  } catch (error) {
    logException("WARN", error);
  }

  process.stdout.write("{}\n");
}

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    if (!raw.trim()) return undefined;
    return JSON.parse(raw);
  } catch (error) {
    logException("WARN", error);
    return undefined;
  }
}

function getEventName(input) {
  return normalizeEventName(getArgumentValue("--event") || input.hook_event_name || input.hookEventName || input.eventName || "");
}

function getArgumentValue(name) {
  const prefix = `${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : "";
}

function normalizeEventName(eventName) {
  const names = {
    PostToolUse: "postToolUse",
    PreInvocation: "preInvocation",
    SessionStart: "sessionStart",
    session_started: "sessionStart",
    UserPromptSubmit: "userPromptSubmitted",
    userPromptSubmit: "userPromptSubmitted",
  };
  return names[eventName] || eventName;
}

function shouldSyncHeartbeat(eventName) {
  return eventName === "preInvocation" || eventName === "postToolUse" || eventName === "userPromptSubmitted";
}

function isInitialInvocation(input) {
  const invocationNum = Number(input.invocationNum);
  if (invocationNum === 0) return true;
  return invocationNum === 1 && Number(input.initialNumSteps || 0) <= 1;
}

function getProjectFolder(input) {
  if (input.cwd) return input.cwd;
  if (input.projectFolder) return input.projectFolder;
  if (Array.isArray(input.workspacePaths) && input.workspacePaths.length) return input.workspacePaths[0];
  return process.cwd();
}

async function syncAiHeartbeats(cliPath, input) {
  const antigravityVersion = await getAntigravityVersion();
  const plugin = `antigravity-cli/${antigravityVersion || "unknown"} ${PLUGIN_NAME}/${VERSION}`;
  const args = ["--sync-ai-activity", "--plugin", plugin];
  const projectFolder = getProjectFolder(input);

  if (projectFolder) args.push("--project-folder", projectFolder);

  log("DEBUG", `AI sync project folder: ${projectFolder || "<none>"}`);
  log("DEBUG", `Syncing AI heartbeats: ${formatArguments(cliPath, args)}`);

  try {
    const result = await execFile(cliPath, args, {
      windowsHide: true,
      env: getChildEnv(),
      timeout: 120000,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (output) log("WARN", output);
  } catch (error) {
    logException("WARN", error);
  }
}

async function syncHistoricalHeartbeats(cliPath, input, options = {}) {
  try {
    log("DEBUG", `Starting historical backfill (force=${options.force === true}).`);
    const data = collectBackfillHeartbeats(options);
    if (!data.heartbeats.length) {
      log("DEBUG", "No historical Antigravity heartbeats to backfill.");
      return;
    }

    const antigravityVersion = await getAntigravityVersion();
    const plugin = `antigravity-cli/${antigravityVersion || "unknown"} ${PLUGIN_NAME}/${VERSION}`;

    const chunks = chunkArray(data.heartbeats, data.batchSize);
    log("DEBUG", `Backfill prepared ${data.heartbeats.length} heartbeat(s) in ${chunks.length} chunk(s).`);
    for (const [index, chunk] of chunks.entries()) {
      if (!chunk.length) continue;
      log("DEBUG", `Sending backfill chunk ${index + 1}/${chunks.length} (${chunk.length} heartbeat(s)).`);

      const main = chunk[0];
      const args = [
        "--entity",
        main.entity,
        "--entity-type",
        "app",
        "--category",
        "ai coding",
        "--project-folder",
        main.project,
        "--time",
        String(main.time),
        "--plugin",
        plugin,
        "--sync-ai-disabled",
      ];

      const extras = chunk.slice(1).map((heartbeat) => ({
        category: "ai coding",
        entity: heartbeat.entity,
        project: heartbeat.project,
        time: heartbeat.time,
        type: "app",
      }));

      if (extras.length) args.push("--extra-heartbeats", "true");

      log("DEBUG", `Backfilling historical AI heartbeats: ${formatArguments(cliPath, args)} (${chunk.length} heartbeats)`);
      await execFileWithInput(cliPath, args, extras.length ? `${JSON.stringify(extras)}\n` : "", {
        windowsHide: true,
        env: getChildEnv(),
        timeout: 120000,
      });

      const lastTimestampMs = chunk[chunk.length - 1].timestampMs;
      log("DEBUG", `Backfill chunk ${index + 1}/${chunks.length} sent successfully. Updating checkpoint to ${lastTimestampMs}.`);
      writeBackfillState({
        lastTimestampMs,
        updatedAt: new Date().toISOString(),
        version: 1,
      });
    }

    if (data.totalCandidates > data.heartbeats.length) {
      log("DEBUG", `Backfill limited to ${data.heartbeats.length} of ${data.totalCandidates} heartbeats. Remaining history will sync in later sessions.`);
    } else {
      log("DEBUG", `Backfilled ${data.heartbeats.length} historical AI heartbeats.`);
    }
  } catch (error) {
    logException("WARN", error);
  }
}

async function syncTranscriptLineBackfill(cliPath) {
  try {
    const days = getBackfillDays();
    const rewoundAt = rewindWakatimeAILogsCursor(days);
    const antigravityVersion = await getAntigravityVersion();
    const plugin = `antigravity-cli/${antigravityVersion || "unknown"} ${PLUGIN_NAME}/${VERSION}`;
    const args = ["--sync-ai-activity", "--plugin", plugin, "--log-to-stdout", "--verbose"];

    log("DEBUG", `Starting transcript line backfill after rewinding ai_logs_last_parsed_at to ${rewoundAt}.`);
    log("DEBUG", `Running transcript sync command: ${formatArguments(cliPath, args)}`);

    const result = await execFile(cliPath, args, {
      windowsHide: true,
      env: getChildEnv(),
      timeout: 300000,
    });

    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (output) {
      // Keep output in debug logs to avoid noisy WARN entries for normal command progress.
      log("DEBUG", output);
    }
    log("DEBUG", "Transcript line backfill command completed.");
  } catch (error) {
    logException("WARN", error);
  }
}

function collectBackfillHeartbeats(options = {}) {
  const force = options.force === true;
  const state = readBackfillState();
  const batchSize = getBackfillBatchSize();
  const historyPaths = getHistoryPaths();
  const nowMs = Date.now();
  const minTimestampMs = nowMs - getBackfillDays() * 24 * 60 * 60 * 1000;
  const sinceMs = force ? minTimestampMs - 1 : Number(state.lastTimestampMs || minTimestampMs - 1);
  const byBucket = new Map();
  let parsedLines = 0;
  let skippedInvalidJson = 0;
  let skippedByType = 0;
  let skippedByTimestamp = 0;
  let skippedMissingWorkspace = 0;

  log("DEBUG", `Backfill scan window: since=${new Date(sinceMs).toISOString()} min=${new Date(minTimestampMs).toISOString()} days=${getBackfillDays()} batchSize=${batchSize}`);
  log("DEBUG", `Backfill history sources: ${historyPaths.length ? historyPaths.join(", ") : "<none found>"}`);

  for (const historyPath of historyPaths) {
    let content;
    try {
      content = fs.readFileSync(historyPath, "utf8");
    } catch (_) {
      continue;
    }

    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      parsedLines++;

      let item;
      try {
        item = JSON.parse(line);
      } catch (_) {
        skippedInvalidJson++;
        continue;
      }

      if (!shouldBackfillHistoryItem(item)) {
        skippedByType++;
        continue;
      }

      const timestampMs = Number(item.timestamp);
      if (!Number.isFinite(timestampMs)) {
        skippedByTimestamp++;
        continue;
      }
      if (timestampMs <= sinceMs) {
        skippedByTimestamp++;
        continue;
      }
      if (timestampMs < minTimestampMs) {
        skippedByTimestamp++;
        continue;
      }

      const project = String(item.workspace || "").trim();
      if (!project) {
        skippedMissingWorkspace++;
        continue;
      }

      const bucket = Math.floor(timestampMs / BACKFILL_BUCKET_MS);
      const key = `${project}\u0000${bucket}`;
      const existing = byBucket.get(key);
      if (!existing || timestampMs > existing.timestampMs) {
        byBucket.set(key, {
          entity: "Antigravity CLI",
          project,
          time: timestampMs / 1000,
          timestampMs,
        });
      }
    }
  }

  const all = Array.from(byBucket.values()).sort((left, right) => left.timestampMs - right.timestampMs);
  log(
    "DEBUG",
    `Backfill scan summary: parsed=${parsedLines} kept=${all.length} skippedInvalidJson=${skippedInvalidJson} skippedByType=${skippedByType} skippedByTimestamp=${skippedByTimestamp} skippedMissingWorkspace=${skippedMissingWorkspace}`,
  );
  return {
    batchSize,
    heartbeats: all.slice(0, batchSize),
    totalCandidates: all.length,
  };
}

function shouldBackfillHistoryItem(item) {
  if (!item || typeof item !== "object") return false;
  if (item.type === "shell") return false;
  const display = typeof item.display === "string" ? item.display.trim() : "";
  return Boolean(display);
}

function getBackfillDays() {
  const days = Number(process.env.ANTIGRAVITY_WAKATIME_BACKFILL_DAYS || process.env.WAKATIME_ANTIGRAVITY_BACKFILL_DAYS);
  if (Number.isFinite(days) && days > 0) return Math.min(days, 3650);
  return DEFAULT_BACKFILL_DAYS;
}

function getBackfillBatchSize() {
  const size = Number(process.env.ANTIGRAVITY_WAKATIME_BACKFILL_BATCH_SIZE || process.env.WAKATIME_ANTIGRAVITY_BACKFILL_BATCH_SIZE);
  if (Number.isFinite(size) && size > 0) return Math.min(Math.floor(size), 5000);
  return DEFAULT_BACKFILL_BATCH_SIZE;
}

function rewindWakatimeAILogsCursor(days) {
  const internalCfg = path.join(getWakatimeDir(), "wakatime-internal.cfg");
  const rewoundAt = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let content = "";
  try {
    content = fs.readFileSync(internalCfg, "utf8");
  } catch (_) {
    content = "[internal]\n";
  }

  const keyLine = `ai_logs_last_parsed_at       = ${rewoundAt}`;

  if (/^\s*ai_logs_last_parsed_at\s*=.*$/m.test(content)) {
    content = content.replace(/^\s*ai_logs_last_parsed_at\s*=.*$/m, keyLine);
  } else if (/^\[internal\]\s*$/m.test(content)) {
    content = content.replace(/^\[internal\]\s*$/m, `[internal]\n${keyLine}`);
  } else {
    content = `${content.replace(/\s*$/, "")}\n[internal]\n${keyLine}\n`;
  }

  fs.mkdirSync(path.dirname(internalCfg), { recursive: true });
  fs.writeFileSync(internalCfg, content);
  log("DEBUG", `Rewrote ${internalCfg} ai_logs_last_parsed_at => ${rewoundAt}`);
  return rewoundAt;
}

function getHistoryPaths() {
  const base = getAntigravityBaseDir();
  return HISTORY_APP_DIRS.map((appDir) => path.join(base, appDir, "history.jsonl")).filter((candidate) => fs.existsSync(candidate));
}

function getAntigravityBaseDir() {
  const override = cleanEnvPath(process.env.ANTIGRAVITY_HOME || process.env.GEMINI_HOME);
  if (override && fs.existsSync(override)) return override;
  return path.join(getUserHomeDirectory(), ".gemini");
}

function getUserHomeDirectory() {
  return process.env[isWindows() ? "USERPROFILE" : "HOME"] || os.homedir() || process.cwd();
}

function readBackfillState() {
  try {
    const raw = fs.readFileSync(getBackfillStateFile(), "utf8");
    const parsed = JSON.parse(raw);
    log("DEBUG", `Loaded backfill checkpoint from ${getBackfillStateFile()}: ${raw}`);
    return parsed;
  } catch (_) {
    log("DEBUG", `No existing backfill checkpoint at ${getBackfillStateFile()}.`);
    return {};
  }
}

function writeBackfillState(state) {
  const stateFile = getBackfillStateFile();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state));
  log("DEBUG", `Wrote backfill checkpoint to ${stateFile}: ${JSON.stringify(state)}`);
}

function getBackfillStateFile() {
  return path.join(getWakatimeDir(), BACKFILL_STATE_FILE);
}

function chunkArray(values, chunkSize) {
  const chunks = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

async function getAntigravityVersion() {
  const envVersion = process.env.ANTIGRAVITY_CLI_VERSION || process.env.AGY_CLI_VERSION;
  if (envVersion) return envVersion;

  try {
    const result = await execFile("agy", ["--version"], { windowsHide: true, timeout: 2000 });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    const match = output.match(/(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/);
    return match ? match[1] : "";
  } catch (_) {
    return "";
  }
}

async function ensureWakatimeCli(options = {}) {
  const checkLatest = options.checkLatest === true;
  const cliPath = getCliLocation();
  fs.mkdirSync(getWakatimeDir(), { recursive: true });

  if (!fs.existsSync(cliPath)) {
    await installCli();
    return cliPath;
  }

  let currentVersion;
  try {
    currentVersion = await getCurrentCliVersion(cliPath);
    log("DEBUG", `Current wakatime-cli version is ${currentVersion}`);
  } catch (_) {
    await installCli();
    return cliPath;
  }

  if (checkLatest && !(await isCliLatest(cliPath, currentVersion))) {
    await installCli();
  } else {
    ensureCliAlias(cliPath);
  }

  return cliPath;
}

async function getCurrentCliVersion(cliPath) {
  const versionResult = await execFile(cliPath, ["--version"], { windowsHide: true, timeout: 10000 });
  return `${versionResult.stdout || ""}${versionResult.stderr || ""}`.trim();
}

async function isCliLatest(cliPath, currentVersion) {
  try {
    if (currentVersion === undefined) currentVersion = await getCurrentCliVersion(cliPath);

    if (currentVersion === "<local-build>") {
      log("DEBUG", "Skip checking for wakatime-cli updates because current version is <local-build>.");
      return true;
    }

    const legacyTag = legacyReleaseTag();
    if (legacyTag) return currentVersion === legacyTag;

    const latest = await getLatestCliVersion();
    if (!latest) return true;
    if (currentVersion === latest) {
      log("DEBUG", "wakatime-cli is up to date");
      return true;
    }

    log("DEBUG", `Found an updated wakatime-cli ${latest}`);
    return false;
  } catch (_) {
    return false;
  }
}

async function getLatestCliVersion() {
  log("DEBUG", `Fetching latest wakatime-cli version from GitHub API: ${GITHUB_RELEASES_URL}`);

  try {
    const response = await getJson(GITHUB_RELEASES_URL);
    if (response.statusCode !== 200) {
      log("WARN", `GitHub API Response ${response.statusCode}`);
      return "";
    }

    const latest = response.body.tag_name || "";
    log("DEBUG", `Latest wakatime-cli version from GitHub: ${latest}`);
    return latest;
  } catch (error) {
    logException("WARN", error);
    return "";
  }
}

async function installCli() {
  const url = cliDownloadUrl();
  const zipFile = path.join(getWakatimeDir(), `wakatime-cli-${randomString()}.zip`);
  const cliPath = getCliLocation();
  const backupPath = `${cliPath}.backup`;

  log("DEBUG", `Downloading wakatime-cli from ${url}`);
  await downloadToFile(url, zipFile);

  try {
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    if (fs.existsSync(cliPath)) fs.renameSync(cliPath, backupPath);
    extractZip(zipFile, getWakatimeDir());
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    if (!isWindows()) fs.chmodSync(cliPath, 0o755);
    ensureCliAlias(cliPath);
  } catch (error) {
    if (fs.existsSync(backupPath)) {
      if (fs.existsSync(cliPath)) fs.unlinkSync(cliPath);
      fs.renameSync(backupPath, cliPath);
    }
    throw error;
  } finally {
    try {
      fs.unlinkSync(zipFile);
    } catch (_) {}
  }
}

function ensureCliAlias(cliPath) {
  const alias = path.join(getWakatimeDir(), `wakatime-cli${isWindows() ? ".exe" : ""}`);
  try {
    if (fs.existsSync(alias)) {
      if (!isWindows() && fs.lstatSync(alias).isSymbolicLink()) return;
      fs.unlinkSync(alias);
    }
    if (isWindows()) {
      fs.copyFileSync(cliPath, alias);
      return;
    }
    fs.symlinkSync(cliPath, alias);
  } catch (error) {
    logException("WARN", error);
    try {
      fs.copyFileSync(cliPath, alias);
      if (!isWindows()) fs.chmodSync(alias, 0o755);
    } catch (copyError) {
      logException("WARN", copyError);
    }
  }
}

function getCliLocation() {
  const ext = isWindows() ? ".exe" : "";
  return path.join(getWakatimeDir(), `wakatime-cli-${osName()}-${architecture()}${ext}`);
}

function cliDownloadUrl() {
  const legacyTag = legacyReleaseTag();
  const platform = `${osName()}-${architecture()}`;

  if (legacyTag) {
    return `https://github.com/wakatime/wakatime-cli/releases/download/${legacyTag}/wakatime-cli-${platform}.zip`;
  }

  const validCombinations = new Set([
    "android-amd64",
    "android-arm64",
    "darwin-amd64",
    "darwin-arm64",
    "freebsd-386",
    "freebsd-amd64",
    "freebsd-arm",
    "linux-386",
    "linux-amd64",
    "linux-arm",
    "linux-arm64",
    "netbsd-386",
    "netbsd-amd64",
    "netbsd-arm",
    "openbsd-386",
    "openbsd-amd64",
    "openbsd-arm",
    "openbsd-arm64",
    "windows-386",
    "windows-amd64",
    "windows-arm64",
  ]);

  if (!validCombinations.has(platform)) reportMissingPlatformSupport();
  return `${GITHUB_DOWNLOAD_URL}/wakatime-cli-${platform}.zip`;
}

function reportMissingPlatformSupport() {
  const url = `https://api.wakatime.com/api/v1/cli-missing?osname=${encodeURIComponent(osName())}&architecture=${encodeURIComponent(architecture())}&plugin=antigravity-cli`;
  requestWithRedirects(url)
    .then((response) => response.resume())
    .catch(() => {});
}

function legacyReleaseTag() {
  if (osName() !== "darwin") return undefined;
  return compareVersions(os.release(), "17.0.0") < 0 ? "v1.39.1-alpha.1" : undefined;
}

function architecture() {
  const arch = os.arch();
  if (arch === "ia32" || arch.includes("32")) return "386";
  if (arch === "x64") return "amd64";
  return arch;
}

function osName() {
  return isWindows() ? "windows" : os.platform();
}

function isWindows() {
  return os.platform() === "win32";
}

async function downloadToFile(url, outputFile) {
  const response = await requestWithRedirects(url);
  const statusCode = response.statusCode || 0;
  if (statusCode < 200 || statusCode >= 300) {
    response.resume();
    throw new Error(`Unexpected status code ${statusCode}`);
  }

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(outputFile);
    response.pipe(stream);
    response.once("error", reject);
    stream.once("error", reject);
    stream.once("finish", resolve);
  });
}

async function getJson(url) {
  const response = await requestWithRedirects(url);
  const chunks = [];
  for await (const chunk of response) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const bodyText = Buffer.concat(chunks).toString("utf8");
  return {
    statusCode: response.statusCode || 0,
    body: bodyText ? JSON.parse(bodyText) : {},
  };
}

async function requestWithRedirects(url, redirectsLeft = 5) {
  const response = await sendRequest(url);
  const statusCode = response.statusCode || 0;
  const location = response.headers.location;

  if (statusCode >= 300 && statusCode < 400 && location && redirectsLeft > 0) {
    response.resume();
    return requestWithRedirects(new URL(location, url).toString(), redirectsLeft - 1);
  }

  return response;
}

async function sendRequest(url) {
  const targetUrl = new URL(url);
  const proxy = getSetting("settings", "proxy");
  const proxyUrl = proxy ? new URL(proxy) : undefined;
  const noSSLVerify = getSetting("settings", "no_ssl_verify") === "true";
  const rejectUnauthorized = !noSSLVerify;
  const headers = { "User-Agent": "github.com/wakatime/antigravity-cli-wakatime" };

  return new Promise(async (resolve, reject) => {
    let request;
    try {
      if (proxyUrl) log("DEBUG", `Using Proxy: ${proxyUrl.toString()}`);

      if (proxyUrl && targetUrl.protocol === "https:") {
        const tunnel = await createProxyTunnel(proxyUrl, targetUrl, rejectUnauthorized);
        const secureSocket = tls.connect({ socket: tunnel, servername: targetUrl.hostname, rejectUnauthorized });
        secureSocket.once("error", reject);
        request = https.request(
          {
            host: targetUrl.hostname,
            port: targetUrl.port ? Number.parseInt(targetUrl.port, 10) : 443,
            path: `${targetUrl.pathname}${targetUrl.search}`,
            method: "GET",
            headers,
            agent: false,
            createConnection: () => secureSocket,
          },
          resolve,
        );
      } else {
        const isHttpsRequest = proxyUrl ? proxyUrl.protocol === "https:" : targetUrl.protocol === "https:";
        const requestModule = isHttpsRequest ? https : http;
        const requestUrl = proxyUrl || targetUrl;
        const authHeader = proxyUrl ? getProxyAuthorizationHeader(proxyUrl) : undefined;
        const requestOptions = {
          host: requestUrl.hostname,
          port: requestUrl.port ? Number.parseInt(requestUrl.port, 10) : isHttpsRequest ? 443 : 80,
          path: proxyUrl ? targetUrl.toString() : `${targetUrl.pathname}${targetUrl.search}`,
          method: "GET",
          headers: proxyUrl ? { Host: targetUrl.host, ...headers, ...(authHeader ? { "Proxy-Authorization": authHeader } : {}) } : headers,
        };

        if (isHttpsRequest) {
          requestOptions.rejectUnauthorized = rejectUnauthorized;
          requestOptions.servername = requestUrl.hostname;
        }

        request = requestModule.request(requestOptions, resolve);
      }

      request.once("error", reject);
      request.end();
    } catch (error) {
      if (request) request.destroy();
      reject(error);
    }
  });
}

function createProxyTunnel(proxyUrl, targetUrl, rejectUnauthorized) {
  const proxyPort = proxyUrl.port ? Number.parseInt(proxyUrl.port, 10) : proxyUrl.protocol === "https:" ? 443 : 80;
  const baseSocket =
    proxyUrl.protocol === "https:"
      ? tls.connect({ host: proxyUrl.hostname, port: proxyPort, rejectUnauthorized, servername: proxyUrl.hostname })
      : net.connect(proxyPort, proxyUrl.hostname);

  return new Promise((resolve, reject) => {
    const auth = getProxyAuthorizationHeader(proxyUrl);
    let response = "";

    const cleanup = () => {
      baseSocket.removeListener("error", onError);
      baseSocket.removeListener("data", onData);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      response += chunk.toString("utf8");
      if (!response.includes("\r\n\r\n")) return;

      cleanup();
      const statusLine = response.split("\r\n", 1)[0];
      if (!statusLine.includes(" 200 ")) {
        baseSocket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${statusLine}`));
        return;
      }

      resolve(baseSocket);
    };

    const connectRequest = `CONNECT ${targetUrl.hostname}:${targetUrl.port || 443} HTTP/1.1\r\nHost: ${targetUrl.hostname}:${targetUrl.port || 443}\r\n${
      auth ? `Proxy-Authorization: ${auth}\r\n` : ""
    }Connection: close\r\n\r\n`;
    baseSocket.once("error", onError);
    baseSocket.on("data", onData);
    if (proxyUrl.protocol === "https:") {
      baseSocket.once("secureConnect", () => baseSocket.write(connectRequest));
    } else {
      baseSocket.once("connect", () => baseSocket.write(connectRequest));
    }
  });
}

function getProxyAuthorizationHeader(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) return undefined;
  return `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")}`;
}

function extractZip(zipFile, outputDir) {
  const buffer = fs.readFileSync(zipFile);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset === -1) throw new Error("Invalid zip file: missing central directory");

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;

  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid zip file: bad central directory header");

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.toString("utf8", offset + 46, offset + 46 + fileNameLength);

    if (!fileName.endsWith("/")) extractZipEntry(buffer, outputDir, fileName, method, compressedSize, localHeaderOffset);
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
}

function extractZipEntry(buffer, outputDir, fileName, method, compressedSize, localHeaderOffset) {
  if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error("Invalid zip file: bad local file header");

  const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
  let data;

  if (method === 0) {
    data = compressed;
  } else if (method === 8) {
    data = zlib.inflateRawSync(compressed);
  } else {
    throw new Error(`Unsupported zip compression method ${method}`);
  }

  const outputFile = safeJoin(outputDir, fileName);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, data);
}

function findEndOfCentralDirectory(buffer) {
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 65557; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function safeJoin(root, fileName) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, fileName);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing to extract outside target directory: ${fileName}`);
  }
  return target;
}

function getSetting(section, key) {
  try {
    const content = fs.readFileSync(getConfigFile(), "utf8");
    let currentSection = "";
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        currentSection = trimmed.slice(1, -1).toLowerCase();
        continue;
      }
      if (currentSection !== section) continue;
      const index = line.indexOf("=");
      if (index === -1) continue;
      if (line.slice(0, index).trim() === key)
        return line
          .slice(index + 1)
          .trim()
          .replace(/\0/g, "");
    }
  } catch (_) {}
  return undefined;
}

function getConfigFile() {
  return path.join(getHomeDirectory(), ".wakatime.cfg");
}

function getWakatimeDir() {
  return path.join(getHomeDirectory(), ".wakatime");
}

function getHomeDirectory() {
  const wakaHome = cleanEnvPath(process.env.WAKATIME_HOME);
  if (wakaHome && fs.existsSync(wakaHome)) return wakaHome;
  return getUserHomeDirectory();
}

function cleanEnvPath(value) {
  if (!value || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith("${") && trimmed.endsWith("}")) return undefined;
  return trimmed;
}

function getChildEnv() {
  if (isWindows() || process.env.HOME || process.env.WAKATIME_HOME) return process.env;
  return { ...process.env, WAKATIME_HOME: getHomeDirectory() };
}

function log(level, message) {
  if (level === "DEBUG" && getSetting("settings", "debug") !== "true") return;
  const line = `[${new Date().toISOString()}][${level}] ${message}`;
  try {
    const logFile = path.join(getWakatimeDir(), "antigravity-cli.log");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${line}\n`);
  } catch (_) {}

  if (ENABLE_CONSOLE_LOG) {
    try {
      process.stderr.write(`${line}\n`);
    } catch (_) {}
  }
}

function logException(level, error) {
  log(level, error && error.message ? error.message : String(error));
}

function execFile(file, args, options) {
  const command = resolveCommand(file, args);
  return new Promise((resolve, reject) => {
    childProcess.execFile(command.file, command.args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function execFileWithInput(file, args, input, options) {
  const command = resolveCommand(file, args);
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command.file, command.args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(signal ? `Process terminated with signal ${signal}` : `Process exited with code ${code}`);
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });

    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}

function resolveCommand(file, args) {
  if (isWindows()) {
    const source = readNodeScriptSource(file);
    if (source !== undefined) {
      return { file: process.execPath, args: ["-e", source, file, ...args] };
    }
  }
  return { file, args };
}

function readNodeScriptSource(file) {
  try {
    const source = fs.readFileSync(file, "utf8");
    if (!source.startsWith("#!") || !source.slice(0, 128).toLowerCase().includes("node")) return undefined;
    return source.replace(/^#![^\n]*\n?/, "");
  } catch (_) {
    return undefined;
  }
}

function formatArguments(binary, args) {
  return [binary, ...args].map((arg, index, list) => wrapArg(list[index - 1] === "--key" ? obfuscateKey(arg) : arg)).join(" ");
}

function wrapArg(arg) {
  return String(arg).includes(" ") ? `"${String(arg).replace(/"/g, '\\"')}"` : String(arg);
}

function obfuscateKey(key) {
  if (!key || key.length <= 4) return key || "";
  return `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXX${key.slice(-4)}`;
}

function compareVersions(left, right) {
  const leftParts = String(left)
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right)
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i++) {
    if ((leftParts[i] || 0) < (rightParts[i] || 0)) return -1;
    if ((leftParts[i] || 0) > (rightParts[i] || 0)) return 1;
  }
  return 0;
}

function randomString() {
  return Math.random().toString(36).slice(2);
}
