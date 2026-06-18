#!/usr/bin/env node

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
const AGENT_ENTITY = "Antigravity";
const GITHUB_DOWNLOAD_URL = "https://github.com/wakatime/wakatime-cli/releases/latest/download";
const GITHUB_RELEASES_URL = "https://api.github.com/repos/wakatime/wakatime-cli/releases/latest";

main().catch((error) => {
  logException("ERROR", error);
  console.log(JSON.stringify({ decision: "allow" }));
  process.exit(0);
});

async function main() {
  if (process.argv.includes("--background")) {
    launchBackground();
    console.log(JSON.stringify({ decision: "allow" }));
    return;
  }

  const input = readInput();
  if (!input) {
    console.log(JSON.stringify({ decision: "allow" }));
    return;
  }

  if (getSetting("settings", "debug") === "true") {
    log("DEBUG", JSON.stringify(input, null, 2));
  }

  const normalized = normalizeInput(input);
  const eventName = normalizeEventName(normalized.eventName);

  if (eventName === "sessionStart") {
    const cliPath = await ensureWakatimeCli({ checkLatest: true });
    await sendDirectHeartbeats(cliPath, input);
    await syncAiActivity(cliPath, input);
    console.log(JSON.stringify({ decision: "allow" }));
    return;
  }

  if (!shouldSyncHeartbeats(input)) {
    console.log(JSON.stringify({ decision: "allow" }));
    return;
  }

  const cliPath = await ensureWakatimeCli({ checkLatest: false });
  await sendDirectHeartbeats(cliPath, input);
  await syncAiActivity(cliPath, input);
  console.log(JSON.stringify({ decision: "allow" }));
}

function launchBackground() {
  try {
    const stdin = fs.readFileSync(0);
    const dataDir = getPluginDataDir();
    fs.mkdirSync(dataDir, { recursive: true });

    const inputFile = path.join(dataDir, `hook-${Date.now()}-${process.pid}-${randomString()}.json`);
    fs.writeFileSync(inputFile, stdin);
    log("DEBUG", `Launching background process with input file: ${inputFile}`);

    const child = childProcess.spawn(process.execPath, [__filename, inputFile], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.on("error", (err) => {
      logException("WARN", new Error(`Failed to spawn background process: ${err.message}`));
    });
    child.unref();
  } catch (error) {
    logException("WARN", error);
  }
}

function readInput() {
  const inputFile = process.argv.find((arg, index) => index > 1 && !arg.startsWith("--"));
  try {
    const raw = inputFile ? fs.readFileSync(inputFile, "utf8") : fs.readFileSync(0, "utf8");
    if (inputFile) {
      try {
        fs.unlinkSync(inputFile);
      } catch (_) {}
    }
    if (!raw.trim()) return undefined;
    return JSON.parse(raw);
  } catch (error) {
    logException("WARN", error);
    return undefined;
  }
}

function normalizeInput(input) {
  let cwd = input.cwd || input.projectFolder || input.project_folder;
  if (!cwd && input.workspacePaths && input.workspacePaths.length > 0) {
    cwd = input.workspacePaths[0];
  }
  if (!cwd) cwd = process.cwd();

  return {
    cwd: cwd,
    eventName: input.hook_event_name || input.hookEventName || input.eventName || "",
    toolCall: input.toolCall || input.tool_call || input.tool || undefined,
  };
}

function normalizeEntity(entity, workspace) {
  if (typeof entity !== "string") return null;

  const trimmed = entity.replace(/^["']|["']$/g, "").trim();
  if (!trimmed) return null;

  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(workspace || process.cwd(), trimmed);
}

function normalizeEventName(eventName) {
  const names = {
    PostToolUse: "postToolUse",
    postToolUse: "postToolUse",
    PreToolUse: "preToolUse",
    preToolUse: "preToolUse",
    SessionStart: "sessionStart",
    sessionStart: "sessionStart",
    session_started: "sessionStart",
    UserPromptSubmit: "userPromptSubmitted",
    userPromptSubmit: "userPromptSubmitted",
    userPromptSubmitted: "userPromptSubmitted",
    PreInvocation: "userPromptSubmitted",
    preInvocation: "userPromptSubmitted",
    Stop: "sessionEnd",
    stop: "sessionEnd",
    SessionEnd: "sessionEnd",
    sessionEnd: "sessionEnd",
    SubagentStop: "sessionEnd",
    subagentStop: "sessionEnd",
  };
  return names[eventName] || eventName;
}

function shouldSyncHeartbeats(input) {
  const normalized = normalizeInput(input);
  const eventName = normalizeEventName(normalized.eventName);

  if (eventName === "sessionStart") return true;
  if (eventName === "sessionEnd") return true;
  if (eventName === "userPromptSubmitted") return true;

  if (eventName === "postToolUse" || eventName === "preToolUse") {
    return isFileTool(normalized.toolCall);
  }

  return false;
}

function isFileTool(toolCall) {
  if (!toolCall) return false;
  const toolName = String(toolCall.name || "").toLowerCase();

  return [
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
    "view_file",
    "run_command",
    "list_dir",
    "find_by_name",
    "grep_search",
    "read_file",
    "edit_file",
    "patch",
    "create",
    "insert",
    "update",
    "write",
  ].some((needle) => toolName.includes(needle));
}

function getHeartbeatStateFile() {
  return path.join(getPluginDataDir(), "state.json");
}

function shouldSendDirectHeartbeat(entity) {
  try {
    const stateFile = getHeartbeatStateFile();
    if (!fs.existsSync(stateFile)) return true;
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const lastTime = state[entity] || 0;
    const now = Date.now() / 1000;
    return now - lastTime >= 30;
  } catch (_) {
    return true;
  }
}

function updateHeartbeatState(entity) {
  try {
    const stateFile = getHeartbeatStateFile();
    let state = {};
    if (fs.existsSync(stateFile)) {
      state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    }
    state[entity] = Date.now() / 1000;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (_) {}
}

async function sendDirectHeartbeats(cliPath, input) {
  try {
    const normalized = normalizeInput(input);
    const eventName = normalizeEventName(normalized.eventName);
    const workspace = normalized.cwd;

    let entity = null;
    let entityType = "file";
    let isWrite = false;
    let lineChanges = null;

    if (eventName === "preToolUse" || eventName === "postToolUse") {
      const toolCall = normalized.toolCall;
      if (toolCall) {
        const toolName = String(toolCall.name || "").toLowerCase();
        const args = toolCall.args || {};

        if (["write_to_file", "replace_file_content", "multi_replace_file_content", "edit_file"].some((t) => toolName.includes(t))) {
          entity = normalizeEntity(args.TargetFile || args.Target || args.file || args.path, workspace);
          isWrite = true;

          if (toolName.includes("replace_file_content")) {
            const target = args.TargetContent || "";
            const replacement = args.ReplacementContent || "";
            lineChanges = replacement.split("\n").length - target.split("\n").length;
          } else if (toolName.includes("multi_replace_file_content")) {
            let sum = 0;
            const chunks = args.ReplacementChunks || [];
            for (const chunk of chunks) {
              const target = chunk.TargetContent || "";
              const replacement = chunk.ReplacementContent || "";
              sum += replacement.split("\n").length - target.split("\n").length;
            }
            lineChanges = sum;
          } else if (toolName.includes("write_to_file")) {
            const code = args.CodeContent || "";
            lineChanges = code.split("\n").length;
          }
        } else if (toolName.includes("view_file") || toolName.includes("read_file")) {
          entity = normalizeEntity(args.AbsolutePath || args.TargetFile || args.file || args.path, workspace);
        } else if (toolName.includes("run_command")) {
          entity = normalizeEntity(args.Cwd || workspace, workspace);
        } else if (["list_dir", "find_by_name", "grep_search"].some((t) => toolName.includes(t))) {
          entity = normalizeEntity(args.DirectoryPath || args.SearchDirectory || args.SearchPath || workspace, workspace);
        }
      }
    } else if (eventName === "userPromptSubmitted" || eventName === "sessionStart") {
      entity = AGENT_ENTITY;
      entityType = "app";
    }

    if (!entity) return;

    if (!shouldSendDirectHeartbeat(entity)) {
      log("DEBUG", `Rate limited heartbeat for: ${entity}`);
      return;
    }

    const agyVersion = await getAntigravityVersion();
    // Spoof VS Code + Gemini agent so that WakaTime server/CLI records this correctly as AI activity
    // const plugin = "Gemini/1.2.3 vscode/1.125.0 vscode-wakatime/30.2.1";
    const plugin = "Antigravity/1.0.0 vscode/1.125.0 vscode-wakatime/30.2.1";
    const args = ["--entity", entity, "--entity-type", entityType, "--plugin", plugin, "--category", "ai coding"];

    if (isWrite) {
      args.push("--write");
    }

    if (lineChanges !== null && lineChanges !== 0) {
      args.push("--ai-line-changes", String(lineChanges));
    }

    if (workspace) {
      args.push("--project-folder", workspace);
    }

    log("DEBUG", `Sending direct heartbeat: ${formatArguments(cliPath, args)}`);

    await execFile(cliPath, args, {
      windowsHide: true,
      env: getChildEnv(),
      timeout: 10000,
    });

    updateHeartbeatState(entity);
  } catch (error) {
    logException("WARN", error);
  }
}

async function syncAiActivity(cliPath, input) {
  try {
    const normalized = normalizeInput(input);
    // Spoof VS Code + Gemini agent so that WakaTime server/CLI records this correctly as AI activity
    //const plugin = "Gemini/1.2.3 vscode/1.125.0 vscode-wakatime/30.2.1";
    const plugin = "Antigravity/1.0.0 vscode/1.125.0 vscode-wakatime/30.2.1";

    const flags = ["--sync-ai-activity", "--sync-ai-heartbeats"];

    for (const flag of flags) {
      const args = [flag, "--plugin", plugin];
      if (normalized.cwd) {
        args.push("--project-folder", normalized.cwd);
      }

      log("DEBUG", `Syncing AI activity with flag ${flag}: ${formatArguments(cliPath, args)}`);

      try {
        const result = await execFile(cliPath, args, {
          windowsHide: true,
          env: getChildEnv(),
          timeout: 120000,
        });
        const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
        if (output) {
          log("WARN", `CLI sync output: ${output}`);
          if (output.includes("unknown flag")) {
            continue;
          }
        }
        break;
      } catch (error) {
        const output = `${error.stdout || ""}${error.stderr || ""}${error.message || ""}`;
        if (output.includes("unknown flag")) {
          log("DEBUG", `Flag ${flag} not supported, trying fallback...`);
          continue;
        }
        logException("WARN", error);
        break;
      }
    }
  } catch (error) {
    logException("WARN", error);
  }
}

async function getAntigravityVersion() {
  const envVersion = process.env.ANTIGRAVITY_CLI_VERSION || process.env.ANTIGRAVITY_VERSION || process.env.GEMINI_CLI_VERSION;
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
  if (currentVersion === "<local-build>") return true;

  const legacyTag = legacyReleaseTag();
  if (legacyTag) return currentVersion === legacyTag;

  const latest = await getLatestCliVersion();
  if (!latest) return true;
  return currentVersion === latest;
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
    if (fs.existsSync(cliPath)) fs.renameSync(cliPath, backupPath);
    extractZip(zipFile, getWakatimeDir());
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    if (!isWindows()) fs.chmodSync(cliPath, 0o755);
    ensureCliAlias(cliPath);
  } catch (error) {
    if (fs.existsSync(backupPath)) fs.renameSync(backupPath, cliPath);
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

async function getJson(url) {
  const response = await requestWithRedirects(url);
  const chunks = [];
  for await (const chunk of response) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const bodyText = Buffer.concat(chunks).toString("utf8");
  return {
    statusCode: response.statusCode || 0,
    body: bodyText ? JSON.parse(bodyText) : {},
  };
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
  const headers = {
    "User-Agent": "github.com/JanDalhuysen/antigravity-cli-wakatime",
  };

  return new Promise(async (resolve, reject) => {
    let request;
    try {
      if (proxyUrl) log("DEBUG", `Using Proxy: ${proxyUrl.toString()}`);

      if (proxyUrl && targetUrl.protocol === "https:") {
        const tunnel = await createProxyTunnel(proxyUrl, targetUrl, rejectUnauthorized);
        const secureSocket = tls.connect({
          socket: tunnel,
          servername: targetUrl.hostname,
          rejectUnauthorized,
        });
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
          headers: proxyUrl
            ? {
                Host: targetUrl.host,
                ...headers,
                ...(authHeader ? { "Proxy-Authorization": authHeader } : {}),
              }
            : headers,
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
      ? tls.connect({
          host: proxyUrl.hostname,
          port: proxyPort,
          rejectUnauthorized,
          servername: proxyUrl.hostname,
        })
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

    if (!fileName.endsWith("/")) {
      extractZipEntry(buffer, outputDir, fileName, method, compressedSize, localHeaderOffset);
    }

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

function getPluginDataDir() {
  const fromEnv =
    cleanEnvPath(process.env.ANTIGRAVITY_PLUGIN_DATA) ||
    cleanEnvPath(process.env.GEMINI_PLUGIN_DATA) ||
    cleanEnvPath(process.env.COPILOT_PLUGIN_DATA) ||
    cleanEnvPath(process.env.CLAUDE_PLUGIN_DATA);
  if (fromEnv) return fromEnv;
  return path.join(getWakatimeDir(), "antigravity-cli");
}

function getHomeDirectory() {
  const wakaHome = cleanEnvPath(process.env.WAKATIME_HOME);
  if (wakaHome && fs.existsSync(wakaHome)) return wakaHome;
  return process.env[isWindows() ? "USERPROFILE" : "HOME"] || os.homedir() || process.cwd();
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
  try {
    const logFile = path.join(getWakatimeDir(), "antigravity-cli.log");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `[${new Date().toISOString()}][${level}] ${message}\n`);
  } catch (_) {}
}

function logException(level, error) {
  log(level, error && error.message ? error.message : String(error));
}

function execFile(file, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, options, (error, stdout, stderr) => {
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
