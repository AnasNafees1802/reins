# Reins: let your AI agent use the browser you're already logged into

Reins is an open-source MCP server and browser extension that lets Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Antigravity and Windsurf drive your real Chrome, Edge, Brave or Opera. Your agent works in your actual browser, with your cookies, your logins and your open tabs. It doesn't spin up a fresh automation profile, so there's no "please sign in again" and no 2FA wall halfway through a task.

```
You:    "Go through my GitHub notifications and summarize the ones that need a reply."
Agent:  reads the page you're already signed into, calls GitHub's own endpoints, done.
```

- **Works where you're logged in.** Gmail, Jira, Salesforce, your admin panel, any internal tool behind SSO. If you can see it, your agent can use it.
- **Cheap to run.** Pages come back as a compact text outline, and every action replies with only what changed. A 22-step real task cost $0.16 on Opus 5.5 (numbers below).
- **Fast, and right the first time.** A click returns in well under half a second, already showing the result of the search or save it triggered. On our hard-case benchmark, agents finish every task in the minimum number of turns.
- **Calls the site's own API.** Reins records a page's requests and replays them as you, so a hundred clicks can become one call.
- **Waits without burning tokens.** Background watches tell your agent when a deploy finishes, a reply lands or a price moves.
- **Several agents at once.** Each agent session gets its own tab. Agents never take over each other's tab, or yours.

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

### Supported agents and browsers

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

## Things people do with it

- "Fill this 40-field onboarding form from the spreadsheet in my downloads."
- "Test the signup flow on staging and tell me which step breaks." (Reins reports console errors as they happen.)
- "Pull every invoice from the billing portal for October." (Reins finds the portal's own API and pages through it.)
- "Watch the deploy page and tell me when it says Finished."
- "Reply to the three oldest support tickets using our macros." (The agent asks before it sends anything.)

## Reins vs a separate automation browser

| | Reins | Playwright, Puppeteer, Selenium (default setup) |
|---|---|---|
| Uses your existing logins and cookies | Yes | No, fresh profile |
| 2FA and SSO already done | Yes | You redo them, often every run |
| Sites see a normal user | Real input events in your normal browser | Automation flags on a separate browser |
| You can watch and take over | Same window you're using | Separate window |
| Install for agents | One command, all agents | Per project |
| Headless CI | No | Yes |

Reins is built for agents doing real work in your accounts. For headless test suites in CI, keep using Playwright.

## All 17 tools

| Tool | What it does |
|---|---|
| `tabs` | List, open, switch or close tabs. Marks your agent's own tab and tabs other agents are using. |
| `navigate` | Open a URL, go back or forward, reload. |
| `snapshot` | Compact page outline with stable refs (`e12`, `f1e5` in iframes). Covers shadow DOM and cross-site iframes. Filter with `query`; add `hrefs:true` for link URLs. |
| `click` | Real mouse click on a ref, after checking nothing covers it. Or click at x,y on a screenshot. |
| `type` | Type into a field. `submit:true` presses Enter; `slowly:true` for picky autocomplete widgets. |
| `press` | Keys and shortcuts: `Enter`, `Escape`, `Control+a`. |
| `select` | Pick an option in a native dropdown. |
| `hover` | Open menus and tooltips. |
| `scroll` | Scroll the page or one scrollable area. |
| `upload` | Attach local files to a file input or upload button. |
| `screenshot` | JPEG of the viewport, for when layout matters. |
| `eval` | Run JavaScript in the page and get JSON back. |
| `batch` | Many actions in one call: fill a form, click Save, wait for "Saved". |
| `wait` | Wait for text to appear or disappear, or for the URL to change. |
| `network` | Record the page's API calls, read one, replay it with changes. |
| `console` | Capture console messages, uncaught exceptions and failed loads. |
| `watch` | Check a tab in the background and queue an event when something changes. |

### Call the site's own API with `network`

Clicking through 30 pages of results takes 30 rounds. Most web apps load their data from a JSON API, and Reins lets the agent use it directly, signed in as you.

```
network action:"start" reload:true                 # record what the page loads
network                                            # #10 POST 200 /1/indexes/items/query (27kB)
network action:"get" id:10                         # headers, body, response
network action:"replay" id:10 body:{"query":"invoices","page":3,"hitsPerPage":100}
```

Cookie, authorization, token, CSRF and nonce headers are masked in everything the agent sees, but replay still sends them. Replay runs inside the page, so it carries your session exactly like the site's own code does. It works for same-site APIs and for public cross-origin APIs.

### Debug a web app with `console`

```
console action:"start"
navigate reload:true
console                       # [error] TypeError: cannot read 'id' of undefined (app.js:212)
```

Once capture is on, every action's reply also flags new console errors, so the agent notices a broken click without asking.

### Wait in the background with `watch`

```
watch action:"add" text:"Deploy finished" every:30
watch action:"add" query:"price" reload:true every:300 once:false
watch action:"wait" timeout:0        # blocks until something fires, costs no turns
```

A watch fires when text appears (or disappears with `gone:true`), or when the lines matching `query` change. Relative times like "3 minutes ago" are ignored when comparing, so a feed only reports real changes. Watches run in the Reins daemon, so the agent can do other work in the meantime, and each agent only sees its own watches.

From the CLI, a watch can also run a command on each event:

```
reins watch action=add text="Deploy finished" run="node notify.js"
```

The command gets the event as JSON in a file named by `REINS_EVENT_FILE`, never on its command line. Agents cannot set `run`; only you can, from a terminal.

## Run several agents at once

Two Claude Code windows, Codex plus Cursor, or ten copies of the same agent can share one browser. Each agent session gets its own target tab, keeps it across extension reloads, and is refused if it tries to take over a tab another agent is using. Over the CLI, give each parallel agent its own `REINS_AGENT=<name>`.

## How it works

```
agent ──MCP/CLI──> reins daemon (127.0.0.1:17333) <──WebSocket── Reins extension (in each browser) ──CDP──> your tabs
```

- The extension uses `chrome.debugger` (the Chrome DevTools Protocol). Clicks and keystrokes are real input events, so sites treat them as a real user.
- Pages are read as a compact outline with stable refs, including shadow DOM and cross-site iframes.
- After each action the agent gets only what changed on the page, so it rarely needs a second read.
- Each action waits for its own effects: the requests it started and the DOM updates after them. A search box or a Save button replies with the results, not a blank diff followed by a `wait`. Elements that change on their own (clocks, tickers, ads) are ignored, so live pages are as fast as still ones.
- If a React or Vue page re-renders between snapshot and click, Reins finds the same control again by role and name instead of failing.
- A frozen iframe is skipped after 2 seconds instead of hanging the whole read.
- Unlabelled fields get a name from the text beside them, so a filter list of checkboxes reads as "Prime delivery", "4 stars and up" instead of a column of anonymous boxes.
- `batch` runs a whole form plus Save in one call. Fewer turns is the biggest cost saver.

The toolbar badge shows **ON** when connected. Click the icon to pause or resume agent control.

## Benchmark

What makes a browser agent expensive is not the size of one reply. It is the extra turns: a reply that comes back before the search results load, a click on an element that just re-rendered, a page read that hangs on a frozen ad frame. Each one costs a full model round trip.

`node test/bench.js` measures exactly that. It runs 9 hard tasks against local test pages and plays the agent: whenever a reply misses the result a task needs, it spends a recovery turn, the way a real agent would.

- A search box that waits 300 ms after typing, then calls an API that takes 700 ms
- A list that re-renders between the snapshot and the click
- A custom (non-native) dropdown
- A confirm dialog in front of a save that takes 600 ms
- A cross-site iframe whose page is frozen

The first four run twice: on a still page, and on a page with a clock that changes every 100 ms, like the ads, tickers and live counters on real sites.

| | Before | Now (Chrome) | Now (Edge) |
|---|---|---|---|
| Tasks passed | 8 of 9 | 9 of 9 | 9 of 9 |
| Agent turns (9 is the minimum) | 13 | 9 | 9 |
| Click, page with a live clock (median) | 2.23 s | 0.65 s | 0.67 s |
| Click, still page (median) | 1.06 s | 0.56 s | 0.57 s |
| Reading a page with a frozen iframe | failed after 60 s | 2 s | 2 s |
| Total time inside Reins | 107 s | 22 s | 23 s |

Click times are measured from the CLI and include about 0.34 s of process startup that MCP calls do not pay, so an agent over MCP sees roughly 0.3 to 0.4 s per click.

### Snapshot size on real sites

Full-page snapshot, before and after leaving out link URLs (still available with `hrefs:true`), naming unlabelled fields and dropping labels repeated as text:

| Page | Before | Now | Smaller by |
|---|---|---|---|
| Hacker News front page | 8,691 chars | 6,030 chars | 31% |
| GitHub repository page | 23,505 chars | 15,995 chars | 32% |
| Amazon search results | 40,330 chars | 23,976 chars | 41% |

The whole Hacker News front page now fits in one default reply. On the Amazon page, all 91 filter checkboxes went from unnamed to named.

## Cost

Set `REINS_METER=path/to/usage.jsonl` (CLI or MCP server env). Every call is logged, and `node test/cost.js usage.jsonl` prices the run per model with prompt caching.

| Task | Calls | Opus 5.5 | Sonnet 5.5 | Screenshot every step (Opus) |
|---|---|---|---|---|
| Invite a user, read the email in yopmail, sign up, join the team | 22 | $0.16 | $0.08 | $0.28 |
| HR workflow, 121 actions, with batch | 43 turns | $0.34 | $0.17 | $2.78 |

Token counts are estimates (about 3.5 characters per token). Reins's own output averages about 80 tokens per action.

## Security

- Only the extension ID pinned by `manifest.json` can connect to the daemon, and the daemon listens on 127.0.0.1 only.
- HTTP calls need the token in `~/.reins/token`, and any request carrying an `Origin` header is refused, so web pages cannot drive your browser.
- Credential headers are masked in network output. Passwords autofilled by the browser show as masked in snapshots.
- Agents cannot attach shell commands to watches. Only you can, from the CLI.
- The bundled skill tells agents to confirm before payments, sending messages, deleting data or changing account settings.
- Click **Cancel** on the browser's debugging bar, or the toolbar icon, to pause control at once.

## CLI

```
reins tabs
reins snapshot query="login"
reins type ref=e3 text="hello" submit=true
reins screenshot              # saved to ~/.reins/screenshot.jpg
reins batch @steps.json       # several actions in one call (use @file on PowerShell 5.1)
reins network action=start reload=true
reins watch action=wait timeout=0
reins status                  # which browsers are connected
reins reload-extension        # after editing extension/ (run reins install to copy it first)
```

## FAQ

**Does Reins work with Claude Code?**
Yes. `reins install` registers it with `claude mcp add --scope user` and installs a skill that teaches Claude how to use it cheaply. Codex, Cursor, Gemini CLI, OpenCode, Antigravity and Windsurf are set up the same way.

**Does my agent see my passwords?**
No. Reins never types a password unless you give it one for that purpose. On a login page the browser autofills your saved password after a real click, and snapshots show it masked. Auth headers in network output are masked too.

**How is this different from Playwright MCP or browser-use?**
Those tools usually launch their own browser profile, so the agent starts logged out. Reins drives the browser you already use, with your sessions, and adds API replay, console capture, background watches and parallel agent tabs.

**How fast is it?**
A click over MCP returns in about 0.3 to 0.4 seconds on a normal page, including waiting for the page to settle. If the click starts a request, like a search or a save, Reins waits for the answer (up to 5 seconds) so the reply already shows the result. See the benchmark above.

**Can I keep using the browser while the agent works?**
Yes. Agents work in their own tabs. If you need the agent to stop, click the toolbar icon.

**Does it work with Firefox or Safari?**
No. Those browsers don't give extensions a debugger API. Any Chromium browser works: Chrome, Edge, Brave, Opera.

**Is it free?**
Yes, MIT licensed. Reins itself makes no network calls outside your machine.

## Development

```
node test/fixture.js          # local test pages on :8701 and :8702
node test/e2e.js              # end-to-end check against your connected browser
node test/bench.js            # hard-task benchmark: accuracy, turns, latency (BENCH_BROWSER=edge to pick a browser)
```

`test/e2e.js` covers network recording, masking and replay (same-site and cross-origin), console capture, watches (text, query, run, per-agent isolation), tab ownership across an extension reload, field naming and link URL opt-in. Both scripts start their own fixture server, so stop any `test/fixture.js` you left running first, or it will serve stale pages on ports 8701 and 8702. After editing `extension/`, run `reins install extension=false`: it copies the extension to `~/.reins/extension` and reloads it in every connected browser.

## License

[MIT](LICENSE)
