# Troubleshooting an MCP App

An MCP App fails differently from an ordinary web app. The payload crosses four
boundaries between the data source and the pixels, **you usually cannot open a
console at the far end**, and a broken link degrades silently rather than
throwing. So the method here is not "read the stack trace" — it is *bisect the
pipeline*: find the last boundary the data crossed intact.

This guide is written to generalise to any MCP App. The worked example is a real
bug from this repo: the chart rendered but showed
`The tool result did not contain forecast data.`

## The pipeline

```
[0] OpenWeather  →  [1] tool handler  →  [2] MCP wire  →  [3] host→app bridge  →  [4] React
    src/openweather.ts   server.ts        tools/call       ui/notifications/     src/mcp-app.tsx
                                                           tool-result
```

Each rung can be observed **without** the rungs above it. That is the whole
trick: test them in isolation, in order, and stop at the first one that fails.

| # | Layer | How to observe it | Proves |
|---|---|---|---|
| 0 | Data source | `npm run test:live` | The upstream API and parsing are fine |
| 1 | Tool handler | `npm test`, plus `MCP_APP_DEBUG=1` | The handler built a well-formed result |
| 2 | MCP wire | **MCP Inspector** (below) | The result survives serialization and transport |
| 3 | Host→app bridge | `npm run test:e2e`; then a real host | The host forwards what the server sent |
| 4 | App render | the on-screen error text; `?mcpDebug=1` | The app parses and draws what it received |

## Symptom index

| What you see | Start at |
|---|---|
| No connector in the host at all | Host config — see README *If it doesn't show up* |
| Tool runs, but answer is plain text with no UI | `_meta.ui.resourceUri` — rung 1 |
| `Could not connect to the host: …` | rung 3 — the `ui/initialize` reply is malformed |
| Stuck on `Connecting…` | rung 3 — the host never answered `ui/initialize` |
| `Waiting for forecast data…` forever | rung 3 — no `ui/notifications/tool-result` arrived |
| `The tool result did not contain forecast data.` | rung 2→3 — **read the shape in the message** |
| `The forecast request failed.` / an API message | rung 0 or 1 — the tool threw |
| Chart draws but images are missing | resource CSP — `_meta.ui.csp.resourceDomains` |

## Rung 0 — the data source

```bash
npm run test:live   # opt-in; makes one real OpenWeather call
```

Hermetic tests use MSW with `onUnhandledRequest: "error"`, so they cannot catch
an upstream change. This is the only rung that talks to the real API.

## Rung 1 — the tool handler

```bash
npm test            # tests/server/server.test.ts drives a real client over an in-memory transport
```

That suite asserts the two links that fail *silently* when broken:

- `_meta.ui.resourceUri` on the tool — without it the host never learns a UI
  exists, and the tool degrades to plain text with no error anywhere.
- `outputSchema` on the tool — the app renders `structuredContent` and nothing
  else, so the tool must declare that field's shape.

To see what the handler returned from inside a real host, set `MCP_APP_DEBUG=1`
in the server's environment (in `claude_desktop_config.json`, add it to `env`).
The handler then logs its result shape to **stderr**, which lands in the host's
server log:

```
[get-forecast] returning content=1 block(s), structuredContent.points=40, location=Halifax
```

> **stdout is the JSON-RPC channel under stdio.** Every diagnostic must use
> `console.error`. A single `console.log` on the server path corrupts the
> protocol stream and the client fails to initialize.

Host server logs live at:

```bash
# macOS
tail -n 50 -f ~/Library/Logs/Claude/mcp-server-openweather-forecast.log
# Windows
type "%APPDATA%\Claude\logs\mcp-server-openweather-forecast.log"
```

Those logs show request/response lines (`Message from client: method="tools/call"`,
`Message from server: id=4 result(1 blocks)`) — enough to prove the call
*happened*, but **not** what was in it. That is the gap `MCP_APP_DEBUG=1` fills.

## Rung 2 — the wire

The most valuable rung, and the one most often skipped: **MCP Inspector** shows
you the literal JSON a client receives, with no host and no UI in the way.

```bash
npx @modelcontextprotocol/inspector \
  node --env-file-if-exists=.env --import tsx main.ts --stdio
```

Then:

1. **Tools → `get-forecast`** — confirm `outputSchema` is present, and that
   `_meta.ui.resourceUri` matches the resource URI exactly. A typo here is
   invisible at runtime.
2. **Run the tool** with `{"location": "Halifax,CA"}`. Inspect the raw result:
   `content[0].text` **and** `structuredContent` with a populated `points`
   array should both be there.
3. **Resources** — read `ui://…` and confirm HTML comes back. If it 404s, run
   `npm run build`; the bundle is read from disk at request time.

If `structuredContent` is correct here but missing in the app, **the server is
exonerated and the problem is the host or the bridge** — jump to rung 3. That
single comparison is usually the whole investigation.

## Rung 3 — the host→app bridge

This is where MCP Apps get genuinely confusing, because two different things
both count as "the host".

### The fake host (fast, proves your app's logic)

```bash
npm run build && npm run test:e2e
```

`tests/e2e/fake-host.ts` is a ~100-line host and doubles as protocol
documentation. Three details that each cost real debugging time:

- `McpUiInitializeResult` requires `protocolVersion`, `hostInfo`,
  **`hostCapabilities`** (not `capabilities`), and `hostContext`. Get one wrong
  and the app renders "Could not connect to the host".
- The tool-result notification's **`params` *is* the tool result** —
  `content`/`structuredContent` sit at the top level of `params`, not nested
  under a `result` key.
- The app must run in an **iframe** (it posts to `window.parent`), hence
  `harness.html`. `addInitScript` runs in *every* frame, so the fake host bails
  with `if (window.parent !== window) return;` or the frames ping-pong.

**What it does not prove.** The fake host is canned: it replays results you
handed it and never contacts the server. It enforces neither the iframe sandbox
nor CSP. Passing E2E proves *this app's logic*, not host compatibility — which
is exactly why a bug can be green here and broken in Claude Desktop. It also
hand-builds its own copy of the result shape (`toolResult()` in
`forecast.spec.ts`), so it can drift from `server.ts` and still pass.

### A real host (slow, proves compatibility)

```bash
git clone https://github.com/modelcontextprotocol/ext-apps
cd ext-apps/examples/basic-host && npm install
SERVERS='["http://localhost:3001/mcp"]' npm start   # with `npm run serve` running
```

Runs in a normal browser tab, so **you get DevTools** — the console, the network
tab, and CSP violation reports that no other rung can show you. If the chart
works here but not in Claude Desktop, the bug is Desktop-specific.

### Claude Desktop DevTools

They exist, and they are not obvious:

1. **Help → Troubleshooting → Enable Developer Mode**. A **Developer** menu appears.
2. `Cmd+Option+I` (macOS) / `Ctrl+Shift+I` (Windows).
3. Your app is the **inner** iframe of a nested pair — inspect the tool call
   element to find it. Run `localStorage.mcpDebug = "1"` in that frame to turn
   on `debugLog`.

**Developer → Reload MCP Configuration** applies `claude_desktop_config.json`
edits without a restart.

> **The host caches the `ui://` resource.** Reloading the MCP configuration
> restarts the *server* but can leave the app iframe running a previously
> fetched bundle, so `npm run build` appears to do nothing. Fully quit the host
> (Cmd+Q) and start a **new conversation** to force a re-fetch.
>
> Always leave yourself a way to tell which build you are looking at — a version
> string, or a diagnostic whose *format* changed. Confirm the bundle on disk
> first (`grep` for a string only the new build contains); if the file is right
> and the screen is wrong, you are looking at a cache, not a bug.

On iOS the app runs in a `WKWebView`, inspectable from a connected Mac via
Safari's Web Inspector.

### When you have no console at all

Claude Desktop renders the app in a webview with no reachable DevTools. A
`console.log` there goes into the void. This shaped two decisions in this repo,
and is worth copying:

1. **The error message carries its own diagnosis.** `describeResultShape()` in
   `src/debug.ts` renders what actually arrived, and the on-screen error embeds
   it:

   ```
   The tool result did not contain forecast data.
   Received: keys=[content] content=1 block(s) structuredContent=absent
   ```

   `structuredContent=absent` says the host did not forward it. Contrast with
   `points=0`, which means it arrived empty — a completely different bug. The
   screen is the only output channel guaranteed to exist, so the error has to
   be worth reading.

2. **Verbose logging is gated, not deleted.** `?mcpDebug=1` on the app URL (or
   `localStorage.mcpDebug = "1"`) enables `debugLog`. It stays in the codebase
   instead of being re-added by hand every time something breaks.

## Worked example: the payload that vanished

Running the ladder on the bug this guide was written for, against
`ext-apps@1.7.5` / `sdk@1.30.0` in Claude Desktop (2026-08):

**Rung 2** — a plain MCP client over stdio, no host:

```
outputSchema present: true
_meta.ui: {"resourceUri":"ui://weather-forecast/mcp-app.html"}
[get-forecast] returning content=1 block(s), structuredContent.points=40
keys: [ 'content', 'structuredContent' ]   content blocks: 1 [ 'text' ]
isError: undefined                          structuredContent: points=40
```

**Rung 3** — the same tool call, as the app received it in Claude Desktop:

```
Received: keys=[content, isError] content=2 block(s) structuredContent=absent
```

Different object. The host added `isError`, turned one content block into two,
and dropped `structuredContent`. The model still answered correctly from the
text, so nothing looked broken from the outside — only the chart failed.

Conclusion: **the server was correct at every rung it owns**, and the payload
died crossing the host→app bridge. Declaring `outputSchema` did not change this
(it was added during the investigation and kept because it is right, not because
it fixed anything). The call also went through Desktop's "Searched available
tools" path, which proxies the call and is a plausible place for a result to be
re-synthesized rather than passed through.

**Rung 3, second host** — `basic-host` 1.7.5, same server, same bundle: the
chart renders, icons load, and the in-app °F control round-trips a real
`tools/call` whose `structuredContent` arrives intact. It enforces the real
iframe sandbox and cross-origin CSP, so this is not a lenient-harness pass.

| Host | Result reaching the app | Chart |
|---|---|---|
| `basic-host` 1.7.5 | `content` (1 block) + `structuredContent` 40 pts | renders |
| Claude Desktop | `content` (2 blocks) + `isError`, no `structuredContent` | error |

The generalisable lesson: when rung 2 and rung 3 disagree, stop reading your own
code. Diff the two shapes and take it upstream.

### Hypotheses this killed

Worth recording, because each looked obvious and cost time:

- **Missing `outputSchema`.** Plausible — the app depends entirely on
  `structuredContent`. But the SDK does not strip the field without one
  (`validateToolOutput` returns early), and adding it changed nothing.
- **The documented large-payload path.** Claude's docs describe results over
  ~150,000 characters being written to the code-execution sandbox filesystem,
  with the app receiving *a pointer to the file rather than the structured
  content* — which predicts this symptom exactly. Measured: the full result is
  **10,054 characters**, 7% of the threshold. Ruled out.
- **A missing Claude-specific requirement.** Checked against the published docs:
  `_meta.ui.resourceUri`, the `ui://[app]/[file].html` pattern, matching
  resource URI, `RESOURCE_MIME_TYPE`, `useApp()`/`connect()`, non-zero iframe
  height. All satisfied. `_meta.ui.domain` is correctly absent — it is for
  remote connectors running their own OAuth and is unavailable over stdio.

What remains: the failing call went through Claude Desktop's "Searched available
tools" path, i.e. **the code-execution sandbox was active**. The size threshold
governs the file-write, but a call proxied through that sandbox plausibly loses
`structuredContent` regardless of size — the result returns as text, which is
what the 2-blocks-plus-`isError` shape looks like. Testable by disabling tool
search and re-running: one variable, and a clean repro if it renders.

**Measure before believing a documented limit applies to you.** Two of the three
hypotheses above were killed by a single number.

## Rung 4 — the app

Test ids for locating state: `location`, `current-temp`, `error`, `waiting`,
`busy`, `forecast-chart`.

`extractSeries()` rejects a result unless `structuredContent.points` is a
non-empty array **and** `location` is present. An empty `points` array is
treated as missing data rather than drawing an axis with nothing on it.

## Protocol facts worth knowing before you guess

Read the generated schema rather than guessing:
`node_modules/@modelcontextprotocol/ext-apps/dist/src/generated/schema.json`.

Claude's own docs are the other half — in particular
[Troubleshooting MCP Apps](https://claude.com/docs/connectors/building/mcp-apps/troubleshooting),
which documents the DevTools route, the ~150,000-character sandbox threshold,
and `ui.domain` validation. The full index is at `https://claude.com/docs/llms.txt`.

- **`structuredContent` is optional** in `McpUiToolResultNotification`. Nothing
  in the protocol obliges a host to forward it. An app that depends on it should
  declare an `outputSchema` and fail loudly when it is absent.
- **`params` is the tool result** in that notification — not `params.result`.
- **`csp` and `permissions` belong on the resource** (`McpUiResourceMeta`), not
  the tool. `McpUiToolMeta` explicitly forbids them, so setting them there is a
  no-op that looks correct.
- `csp.resourceDomains` is deny-by-default: omit it and every external image,
  font, and script is blocked.
- The MCP SDK does **not** strip `structuredContent` when a tool declares no
  `outputSchema` — verified in `server/mcp.js` (`validateToolOutput` returns
  early) and `client/index.js` (checks run only when a validator exists). If the
  field vanishes without an `outputSchema`, suspect the host, not the SDK.

The extension is under active development. This is written against
`ext-apps@1.7.5` / `sdk@1.30.0`; treat those versions as part of the API and
re-read the schema after upgrading.
