# Troubleshooting an MCP App

An MCP App fails differently from an ordinary web app. The payload crosses four
boundaries between the data source and the pixels, a broken link degrades
*silently* rather than throwing, and the far end may be a webview you cannot
attach a console to. So the method is not "read the stack trace" — it is
**bisect the pipeline**: find the last boundary the data crossed intact.

The guide is written to generalise to any MCP App. The case study at the end is
a real bug from this repo, kept because the wrong turns are as instructive as
the answer.

## The pipeline

```
[0] OpenWeather  →  [1] tool handler  →  [2] MCP wire  →  [3] host→app bridge  →  [4] React
    src/openweather.ts   server.ts        tools/call       ui/notifications/     src/mcp-app.tsx
                                                           tool-result
```

Every rung can be observed **without** the rungs above it. That is the whole
trick: test them in isolation, in order, and stop at the first one that fails.

| # | Layer | How to observe it | Proves |
|---|---|---|---|
| 0 | Data source | `npm run test:live` | The upstream API and parsing are fine |
| 1 | Tool handler | `npm test`, plus `MCP_APP_DEBUG=1` | The handler built a well-formed result |
| 2 | MCP wire | MCP Inspector | The result survives serialization and transport |
| 3 | Host→app bridge | `npm run test:e2e`, then a real host | The host forwards what the server sent |
| 4 | App render | the on-screen error; `?mcpDebug=1` | The app parses and draws what it received |

## Symptom index

| What you see | Start at |
|---|---|
| No connector in the host at all | Host config — see README *If it doesn't show up* |
| Tool runs, but the answer is plain text with no UI | `_meta.ui.resourceUri` — rung 1 |
| `Could not connect to the host: …` | rung 3 — the `ui/initialize` reply is malformed |
| Stuck on `Connecting…` | rung 3 — the host never answered `ui/initialize` |
| `Waiting for forecast data…` forever | rung 3 — no `ui/notifications/tool-result` arrived |
| `The tool result did not contain forecast data.` | rung 3 — **read the shape in the message** |
| `The forecast request failed.` / an API message | rung 0 or 1 — the tool threw |
| Chart draws but images are missing | resource CSP — `_meta.ui.csp.resourceDomains` |
| A rebuild seems to change nothing | the host cached the bundle — see rung 3 |

## Rung 0 — the data source

```bash
npm run test:live   # opt-in; makes one real OpenWeather call
```

Hermetic tests run MSW with `onUnhandledRequest: "error"`, so they cannot catch
an upstream change. This is the only rung that talks to the real API.

## Rung 1 — the tool handler

```bash
npm test   # tests/server/server.test.ts drives a real client over an in-memory transport
```

That suite asserts the two links that fail *silently* when broken:

- **`_meta.ui.resourceUri`** on the tool — without it the host never learns a UI
  exists, and the tool degrades to plain text with no error anywhere.
- **`outputSchema`** on the tool — the app renders `structuredContent` and
  nothing else, so the tool must declare that field's shape.

To see what the handler returned from inside a real host, set `MCP_APP_DEBUG=1`
in the server's environment — in `claude_desktop_config.json` that means an
`env` object **inside** the server's entry, alongside `command` and `args`, not
at the top level of the file. The handler then logs its result shape to stderr,
which lands in the host's server log:

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

They show request/response lines (`Message from client: method="tools/call"`,
`Message from server: id=4 result(1 blocks)`) — enough to prove a call
*happened*, but not what was in it. That is the gap `MCP_APP_DEBUG=1` fills.

## Rung 2 — the wire

The most valuable rung, and the one most often skipped: **MCP Inspector** shows
the literal JSON a client receives, with no host and no UI in the way.

```bash
npx @modelcontextprotocol/inspector \
  node --env-file-if-exists=.env --import tsx main.ts --stdio
```

1. **Tools → `get-forecast`** — confirm `outputSchema` is present and that
   `_meta.ui.resourceUri` matches the resource URI exactly. A typo is invisible
   at runtime.
2. **Run the tool** with `{"location": "Halifax,CA"}`. The result should carry
   `content[0].text` **and** a `structuredContent` with a populated `points`.
3. **Resources** — read `ui://…` and confirm HTML comes back. If it fails, run
   `npm run build`; the bundle is read from disk at request time.

If `structuredContent` is correct here but missing in the app, **the server is
exonerated and the problem is the host or the bridge**. That single comparison
is usually the whole investigation.

## Rung 3 — the host→app bridge

Two very different things both count as "the host", and they prove different
things.

### The fake host — fast, proves your app's logic

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

**What it cannot prove.** It is canned: it replays results you handed it and
never contacts the server, and it enforces neither the iframe sandbox nor CSP.
Passing E2E proves *this app's logic*, not host compatibility — which is exactly
how a bug can be green here and broken in a real host. It also hand-builds its
own copy of the result shape (`toolResult()` in `forecast.spec.ts`), which can
drift from `server.ts` and still pass.

### `basic-host` — slower, proves compatibility

```bash
git clone https://github.com/modelcontextprotocol/ext-apps
cd ext-apps && npm install          # a workspace: install at the ROOT, not in examples/
npm run build                       # builds the ext-apps package the host imports
cd examples/basic-host && npm run build
SERVERS='["http://localhost:3001/mcp"]' node --import tsx serve.ts
```

Two snags worth knowing. Installing inside `examples/basic-host` triggers the
workspace root's `prepare` script and fails — install at the root. And `npm run
serve` invokes `bun`; if you do not have it, `serve.ts` is plain express and
runs under `node --import tsx` as above.

This serves the host on `:8080` and the sandbox on `:8081`, enforcing the real
cross-origin sandbox and CSP. Default `SERVERS` is already
`http://localhost:3001/mcp`. It runs in a normal browser tab, so you get full
DevTools — console, network, and CSP violation reports. **If the chart works
here but not in your target host, the bug is host-specific**, and you have a
two-host diff worth reporting upstream.

### Claude Desktop DevTools

They exist, and they are not obvious:

1. **Help → Troubleshooting → Enable Developer Mode**. A **Developer** menu appears.
2. `Cmd+Option+I` (macOS) / `Ctrl+Shift+I` (Windows).
3. Your app is the **inner** iframe of a nested pair — inspect the tool call
   element to find it. Run `localStorage.mcpDebug = "1"` in that frame to enable
   `debugLog`.

**Developer → Reload MCP Configuration** applies config edits without a restart.

On iOS the app runs in a `WKWebView`, inspectable from a connected Mac via
Safari's Web Inspector.

> **The host caches the `ui://` resource.** Reloading the MCP configuration
> restarts the *server* but can leave the app iframe on a previously fetched
> bundle, so `npm run build` appears to do nothing. Fully quit the host (Cmd+Q)
> and start a **new conversation** to force a re-fetch.
>
> Keep a way to tell which build you are looking at — a version string, or a
> diagnostic whose *format* changed. Check the bundle on disk first (`grep` for a
> string only the new build contains); if the file is right and the screen is
> wrong, you are looking at a cache, not a bug.

### Designing for a host with no console

DevTools are not always reachable — a different host, a webview, a user's
machine rather than yours. Two decisions in this repo follow from that, and are
worth copying:

1. **The error message carries its own diagnosis.** `describeResultShape()` in
   `src/debug.ts` describes what actually arrived, and the on-screen error
   embeds it:

   ```
   The tool result did not contain forecast data.
   Received: keys=[content, isError] isError=false content=2 block(s) [#0=text:"…" | #1=text:"…"]
   structuredContent=absent
   ```

   `structuredContent=absent` means the host never forwarded it. `points=0`
   means it arrived empty — a different bug entirely. The screen is the only
   output channel guaranteed to exist, so make the error worth reading.

2. **Verbose logging is gated, not deleted.** `?mcpDebug=1` on the app URL, or
   `localStorage.mcpDebug = "1"`, enables `debugLog`. It stays in the codebase
   rather than being re-added by hand every time something breaks.

## Rung 4 — the app

Test ids for locating state: `location`, `current-temp`, `error`, `waiting`,
`busy`, `forecast-chart`.

`extractSeries()` rejects a result unless `structuredContent.points` is a
non-empty array **and** `location` is present — an empty `points` is treated as
missing data rather than drawing an axis with nothing on it.

When the pushed result has no usable series, `ontoolresult` re-fetches using the
arguments captured from `ontoolinput`. That path exists to survive a specific
host bug (below); it only runs when the series is missing, so a correct host
never reaches it.

## Case study: the payload that vanished

Against `ext-apps@1.7.5` / `sdk@1.30.0` in Claude Desktop (2026-08), the chart
loaded but rendered `The tool result did not contain forecast data.` The model's
own text answer was correct, so nothing looked broken from the outside.

**Rung 2** — a plain MCP client over stdio, no host:

```
outputSchema present: true
_meta.ui: {"resourceUri":"ui://weather-forecast/mcp-app.html"}
keys: [ 'content', 'structuredContent' ]   content blocks: 1 [ 'text' ]
isError: undefined                         structuredContent: points=40
```

**Rung 3** — the same call, as the app received it:

```
keys=[content, isError] isError=false content=2 block(s) structuredContent=absent
```

A different object. Printing the blocks named the mechanism:

```
#0=text:"40-point forecast for Downtown Toronto, CA: 2026-08-11: 22.0-26.8°C, clouds…"
#1=text:"[This tool call rendered an interactive widget in the chat. The user can
         already see the result — do not repeat it in te…"
```

Block #1 is not ours — it is the host's own instruction *to the model*. Claude
Desktop builds a **model-facing copy** of the result (original text, plus that
note, plus `isError: false`) and forwards that copy to the app, dropping
`structuredContent` because the model has no use for it. Everything follows:
two blocks, an `isError` the server never set, no structured data, a correct
model answer, and a chart with nothing to draw.

`basic-host`, same server and same bundle, renders correctly — confirming the
fault is host-specific and not a lenient-harness artifact:

| Host | Result reaching the app | Chart |
|---|---|---|
| `basic-host` 1.7.5 | `content` (1 block) + `structuredContent` 40 pts | renders |
| Claude Desktop | `content` (2 blocks) + `isError`, no `structuredContent` | error |

**Only the push path is affected.** An app-initiated `callServerTool` returns
`structuredContent` intact in the same host. The server log proves it: reopening
two affected conversations produced one fresh `tools/call` each, seconds after
the bundle loaded, and both charts then rendered.

```
13:06:52  resources/read                      <- app bundle loads
13:06:54  tools/call  -> Downtown Toronto     <- app re-fetches
13:07:58  tools/call  -> Japan
```

Hosts do not re-run tools when a conversation is reopened, so those calls came
from the app. That asymmetry is the fix: `ontoolinput` still delivers the
original arguments, so an app whose pushed result is missing its series can
simply ask again.

### Three hypotheses that were wrong

Each looked obvious and cost time:

- **Missing `outputSchema`.** The app depends entirely on `structuredContent`,
  so this was plausible. But the SDK does not strip the field without one
  (`validateToolOutput` returns early), and adding it changed nothing. It was
  kept because it is correct, not because it fixed anything.
- **The documented large-payload path.** Claude's docs describe results over
  ~150,000 characters being written to the code-execution sandbox filesystem,
  the app receiving *a pointer to the file rather than the structured content* —
  which predicts this symptom exactly. Measured: the full result is **10,054
  characters**, 7% of the threshold.
- **A missing Claude-specific requirement.** Checked against the published docs:
  `_meta.ui.resourceUri`, the `ui://[app]/[file].html` pattern, matching
  resource URI, `RESOURCE_MIME_TYPE`, `useApp()`/`connect()`, non-zero iframe
  height. All satisfied. `_meta.ui.domain` is correctly absent — it is for
  remote connectors running their own OAuth, and is unavailable over stdio.

Two lessons generalise. **Measure before assuming a documented limit applies to
you** — one number killed the most convincing hypothesis. And **when rung 2 and
rung 3 disagree, stop reading your own code**: diff the two shapes, then work
out which side is rewriting the payload.

## Protocol facts worth knowing before you guess

Read the generated schema rather than guessing:
`node_modules/@modelcontextprotocol/ext-apps/dist/src/generated/schema.json`.
Claude's own docs are the other half — in particular
[Troubleshooting MCP Apps](https://claude.com/docs/connectors/building/mcp-apps/troubleshooting),
which covers the DevTools route, the ~150,000-character sandbox threshold, and
`ui.domain` validation. The full index is at `https://claude.com/docs/llms.txt`.

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
  field vanishes, suspect the host, not the SDK.

The extension is under active development. This is written against
`ext-apps@1.7.5` / `sdk@1.30.0`; treat those versions as part of the API and
re-read the schema after upgrading.
