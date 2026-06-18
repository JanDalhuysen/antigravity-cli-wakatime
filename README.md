# Google Antigravity CLI WakaTime Plugin

[WakaTime][wakatime] plugin for [Google Antigravity CLI][antigravity-cli] (`agy`).

The plugin installs [wakatime-cli][wakatime-cli] into `~/.wakatime/`, checks for CLI updates on session start, and tracks AI coding metrics by sending heartbeats during prompts and
tool executions (such as file reads, writes, edits, commands, and search events).

It supports both:

1. **Direct real-time heartbeats** for file edits, views, command runs, and directory listings.
2. **AI activity batch synchronization** (`--sync-ai-activity`) to track developer prompting, tokens, and AI usage metrics.

---

## Installation

You can install the plugin either **globally** for all projects, or **locally** for a specific workspace.

### Option A: Global Installation (Recommended)

1. Clone or copy this repository into your global Antigravity plugins directory:
   - **Windows**: `C:\Users\<YourUsername>\.gemini\config\plugins\antigravity-cli-wakatime`
   - **Linux/macOS**: `~/.gemini/config/plugins/antigravity-cli-wakatime`

2. If the directory does not exist, create it first. Once copied, the plugin is loaded automatically by the Antigravity CLI.

### Hook Manifest

The canonical hook manifest is [plugin.json](plugin.json), which points to the root [hooks.json](hooks.json) file. The copy under [hooks/hooks.json](hooks/hooks.json) is a
duplicate and is not the active manifest referenced by the plugin metadata.

### Option B: Project-Scoped (Workspace) Installation

1. Create an `.agents/plugins` directory at the root of your project/workspace:

   ```bash
   mkdir -p .agents/plugins
   ```

2. Copy this repository into `.agents/plugins/antigravity-cli-wakatime`.

---

## Configuration

The plugin reads standard WakaTime settings from your global configuration file (`~/.wakatime.cfg`).

Example `~/.wakatime.cfg`:

```ini
[settings]
api_key = XXXX
debug = true
```

### Logging & Diagnostics

Logs from the plugin and `wakatime-cli` operations are written to: `~/.wakatime/antigravity-cli.log`

<!--
### Local Communication Test

To send one test heartbeat directly to WakaTime and print the CLI response, run:

```bash
npm run test:wakatime -- --show-only
```

Remove `--show-only` to actually send the heartbeat. You can also override the visible editor label with `--editor-name ai-agent` if you want to check how WakaTime displays it. -->

[wakatime]: https://wakatime.com/
[antigravity-cli]: https://antigravity.google/product/antigravity-cli
[wakatime-cli]: https://github.com/wakatime/wakatime-cli
