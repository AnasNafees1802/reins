# Reins

Hand your AI agent the reins of the browser you already use. Reins lets Claude Code, Codex, OpenCode, Antigravity, Gemini CLI and Cursor drive your open Chrome, Edge, Brave or Opera, logged in as you. No separate automation browser, no new profile, no re-logins.

## Install (one line)

Needs [Node.js 20+](https://nodejs.org). Pick your shell:

**Windows, Command Prompt (cmd)**
```cmd
npm i -g https://github.com/AnasNafees1802/reins/archive/refs/heads/main.tar.gz && reins install
```

**Windows, PowerShell 5.1 (the built-in one)**
```powershell
npm i -g https://github.com/AnasNafees1802/reins/archive/refs/heads/main.tar.gz; reins install
```

**Windows, PowerShell 7+ (pwsh)**
```powershell
npm i -g https://github.com/AnasNafees1802/reins/archive/refs/heads/main.tar.gz && reins install
```

**Windows, Git Bash or WSL**
```bash
npm i -g https://github.com/AnasNafees1802/reins/archive/refs/heads/main.tar.gz && reins install
```

**macOS (Terminal, zsh or bash)**
```bash
npm i -g https://github.com/AnasNafees1802/reins/archive/refs/heads/main.tar.gz && reins install
```

**Linux (bash, zsh, fish)**
```bash
npm i -g https://github.com/AnasNafees1802/reins/archive/refs/heads/main.tar.gz && reins install
```
If npm says `EACCES` (permission denied), your Node is installed system-wide. Use a user-level Node from [nvm](https://github.com/nvm-sh/nvm), or put `sudo` before `npm` only (not before `reins install`, so the setup lands in your own home folder).

**From a local clone (any OS)**
```bash
git clone https://github.com/AnasNafees1802/reins.git
cd reins
npm i -g .
reins install
```

The one-liners download a tarball, so they need no git or SSH setup. WSL note: inside WSL, `reins install` sets up agents installed in WSL, and the browsers on the Windows side cannot reach it. Run it in a Windows shell if your browsers are on Windows.

`reins install` does everything it can by itself:

1. Finds every agent on this machine and registers the Reins tools and skill in each one.
2. Copies the extension to a fixed folder (`~/.reins/extension`), so moving or updating Reins never breaks the browsers.
3. Opens the extensions page in every browser that is not set up yet and puts the folder path on your clipboard.
4. Waits and confirms each browser as it connects.

In each browser that opens, do this once:

1. Turn on **Developer mode**.
2. Click **Load unpacked**.
3. Paste the path and press Enter. It is already on your clipboard.
   - Windows: paste (Ctrl+V) into the folder box.
   - macOS: press Cmd+Shift+G first, then paste (Cmd+V).
   - Linux: press Ctrl+L first, then paste (Ctrl+V). The clipboard copy needs `xclip`; without it, type the path the installer prints.

Then restart your agents and ask: "use reins to list my tabs".

Run `reins install` again any time. It updates the agents, refreshes the extension in connected browsers, and only asks you about browsers that are not connected yet. `reins install extension=false` updates the agents only.

### Why browsers still need those 3 clicks

Chrome and Edge only allow automatic installs for extensions from their stores, or on company-managed PCs. Publishing Reins to the Chrome Web Store would make it a single "Add to Chrome" click that works in Edge too.

### Supported

| Agent | Registered in | Skill |
|---|---|---|
| Claude Code | `claude mcp add --scope user` | `~/.claude/skills/reins` |
| Codex | `~/.codex/config.toml` | `~/.codex/skills/reins` |
| OpenCode | `~/.config/opencode/opencode.json(c)` | `~/.config/opencode/skills/reins` |
| Antigravity | `~/.gemini/config/mcp_config.json` | `~/.gemini/config/skills/reins` |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/skills/reins` |
| Cursor | `~/.cursor/mcp.json` | |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | |
| Anything with a shell | `reins <tool> key=value` | |

Browsers: Chrome, Edge, Brave, Opera (anything Chromium). Firefox and Safari have no debugger API for extensions, so they are not supported.

## How it works

```
agent ──MCP/CLI──> reins daemon (127.0.0.1:17333) <──WebSocket── Reins extension (in each browser) ──CDP──> your tabs
```

- The extension uses `chrome.debugger` (the Chrome DevTools Protocol). Clicks and keystrokes are real input events, so sites treat them as a real user.
- Pages are read as a compact outline with stable refs (`e12`, `f1e5` inside iframes), including shadow DOM and cross-site iframes.
- After each action the agent gets only what changed on the page, so it rarely needs a second read.
- `batch` runs a whole form plus Save in one call. Fewer turns is the biggest cost saver.

The toolbar badge shows **ON** when connected. Click the icon to pause or resume agent control.

## CLI

```
reins tabs
reins snapshot query="login"
reins type ref=e3 text="hello" submit=true
reins screenshot              # saved to ~/.reins/screenshot.jpg
reins batch @steps.json       # several actions in one call (use @file on PowerShell 5.1)
reins status                  # which browsers are connected
reins reload-extension        # after editing extension/ (run reins install to copy it first)
```

Several agents can share one browser. On long runs, pass `tab=<id>` on every call so agents do not steal each other's tab.

## Cost

Set `REINS_METER=path\to\usage.jsonl` (CLI or MCP server env). Every call is logged, and `node test/cost.js usage.jsonl` prices the run per model with prompt caching.

| Task | Calls | Opus 5.5 | Sonnet 5.5 | Screenshot every step (Opus) |
|---|---|---|---|---|
| Invite a user, read the email in yopmail, sign up, join the team | 22 | $0.16 | $0.08 | $0.28 |
| HR workflow, 121 actions, with batch | 43 turns | $0.34 | $0.17 | $2.78 |

Token counts are estimates (about 3.5 characters per token).

## Security

- Only the extension ID pinned by `manifest.json` can connect to the daemon.
- HTTP calls need the token in `~/.reins/token`, and any request carrying an `Origin` header is refused, so web pages cannot drive your browser.
- Clicking "Cancel" on the browser's debugging bar, or the toolbar icon, pauses control.
