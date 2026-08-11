# MCP App: OpenWeather Forecast Visualizer

A proof-of-concept **MCP App** — an MCP server whose tool renders an interactive
chart inside the chat instead of returning only text. Ask for a forecast, get a
Recharts graph you can click; clicking a control calls back into the server for
fresh data.

Built as a readable reference for the [MCP Apps
extension](https://modelcontextprotocol.io/extensions/apps/overview), written
against `@modelcontextprotocol/ext-apps@1.7.5` and
`@modelcontextprotocol/sdk@1.30.0`. The extension is under active development;
`_meta.ui` shapes may shift, so treat the pinned versions as part of the API.

## What an MCP App is, in one screen

A normal MCP tool returns content the model reads. An MCP App additionally ships
a **UI resource** that the host renders in a sandboxed iframe. Two registrations
tied together by one URI:

```ts
// server.ts
const RESOURCE_URI = "ui://weather-forecast/mcp-app.html";

registerAppTool(server, TOOL_NAME, {
  inputSchema: { location: z.string(), units: ..., days: ... },
  _meta: { ui: { resourceUri: RESOURCE_URI } },   // <-- the link
}, handler);

registerAppResource(server, "Weather Forecast Chart", RESOURCE_URI, {
  mimeType: RESOURCE_MIME_TYPE,
}, () => /* the built HTML */);
```

Drop `_meta.ui.resourceUri` and everything still "works" — the tool silently
degrades to plain text with no UI. That failure is invisible, which is why
`tests/server/server.test.ts` asserts on it explicitly.

Three things worth internalizing from this codebase:

1. **The payload split.** The handler returns `content[0].text` (a short summary
   — cheap tokens for the model) *and* `structuredContent` (the full typed
   series — for the chart). Never make the model pay for 40 data points it
   won't read. See `server.ts`.
2. **The UI is a client, not a template.** `src/mcp-app.tsx` uses `useApp()` and
   calls `app.callServerTool(...)` when you change units or day range. That
   round trip is the entire reason to reach for MCP Apps.
3. **`ui://` resources declare their own CSP.** Everything is inlined into one
   HTML file *except* the weather icons, so the resource declares
   `_meta.ui.csp.resourceDomains: ["https://openweathermap.org"]` — a small
   deliberate example of the field.

## Setup

```bash
npm install
cp .env.example .env      # then paste your key in
npm run build             # typechecks, then bundles the UI into dist/mcp-app.html
```

The free OpenWeather tier is enough. New keys take ~10 minutes to activate;
until then every call returns 401.

## Running it

Two transports, one entry point, to show both ends of the spectrum:

```bash
npm run serve:stdio   # stdio -- simplest local wiring, host spawns the process
npm run serve         # Streamable HTTP on :3001/mcp -- shareable, tunnelable
npm run dev           # rebuild UI on change + serve over HTTP
```

**stdio gotcha:** stdout *is* the JSON-RPC channel. One stray `console.log`
corrupts the stream and the host reports an unparseable message. Every
diagnostic in `main.ts` uses `console.error`.

The HTTP mode is stateless — `sessionIdGenerator: undefined`, with a fresh
server and transport per request, closed on `res.close`. Nothing to reap.

Sharing the HTTP server as a custom connector:

```bash
npx cloudflared tunnel --url http://localhost:3001
# add the resulting https URL + /mcp as a custom connector
```

## Adding it to the Claude desktop app

Written for someone who has never set up an MCP server. A Claude Pro account is
enough. Claude Desktop supports the MCP Apps extension, so the chart renders
inline rather than falling back to text.

You'll wire this up as a **local stdio server**: Claude Desktop starts the
process itself, so there's no hosting, no tunnel, and no login. Roughly 10
minutes.

### 1. Install the prerequisites

- **Claude Desktop** — https://claude.ai/download. If it's already installed,
  use *Check for Updates…* in the Claude menu.
- **Node.js 20+** — https://nodejs.org (the LTS build). Verify in a terminal:

  ```bash
  node --version
  ```

### 2. Set the project up

```bash
git clone https://github.com/kasza-introhive/mcp-app-openweather.git
cd mcp-app-openweather
npm install
npm run build      # REQUIRED -- creates dist/mcp-app.html, which IS the chart
```

Skipping `npm run build` is the most common mistake: the server starts fine and
the tool returns data, but asking for the UI errors out because the bundle it
serves doesn't exist yet.

### 3. Add your OpenWeather API key

Sign up at https://openweathermap.org/api and copy your key from
https://home.openweathermap.org/api_keys — the **free tier** is all this needs.

```bash
cp .env.example .env
```

Open `.env` and paste the key after `OPENWEATHER_API_KEY=`. A brand-new key can
take ~10 minutes to activate; until then every request returns 401.

### 4. Find your absolute paths

Claude Desktop doesn't run with your shell's `PATH`, so both the Node binary and
the project directory must be spelled out in full. Print them:

```bash
command -v node   # e.g. /usr/local/bin/node   (Windows: where node)
pwd               # e.g. /Users/you/code/mcp-app-openweather
```

### 5. Edit the Claude Desktop config

Open the **Claude** menu in your OS menu bar (not the settings inside the chat
window) → **Settings…** → **Developer** tab → **Edit Config**. That creates or
opens:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add this, substituting the two paths from step 4:

```json
{
  "mcpServers": {
    "openweather-forecast": {
      "command": "/absolute/path/to/node",
      "args": [
        "--env-file-if-exists=.env",
        "--import", "tsx",
        "main.ts",
        "--stdio"
      ],
      "cwd": "/absolute/path/to/mcp-app-openweather"
    }
  }
}
```

If the file already has an `mcpServers` block, add `"openweather-forecast"`
alongside your existing entries rather than replacing them.

Two things here are load-bearing, and both cause failures that look like
something else:

- **Call `node` directly, not `npm run serve:stdio`.** `npm` prints a two-line
  banner to *stdout*, and under stdio stdout is the JSON-RPC channel — the
  banner corrupts the first message and the server appears to fail for no
  reason. The npm scripts are for humans in a terminal.
- **`cwd` is required.** `--import tsx` resolves `tsx` from the working
  directory, so without it Node exits with `ERR_MODULE_NOT_FOUND`.

On Windows, write paths with escaped backslashes:
`"C:\\Program Files\\nodejs\\node.exe"`.

### 6. Restart and confirm

Quit Claude Desktop **completely** (⌘Q / right-click → Quit — closing the window
isn't enough) and reopen it. Config is only read at startup.

Click the **Add files, connectors, and more** (`/`) control at the bottom-left of
the message box, hover **Connectors** → **Manage connectors**, and look for
`openweather-forecast` with `get-forecast` listed under it.

### 7. Ask for a forecast

> "What's the weather forecast for Halifax this week?"

Claude will ask permission to run `get-forecast` the first time — approve it. An
interactive chart appears in the conversation. Click **Humidity** to reshape the
data instantly (no server call), or **°F** / **1 day** to trigger a fresh
`tools/call`.

### If it doesn't show up

Read the logs first — they name the actual cause:

```bash
# macOS
tail -n 50 -f ~/Library/Logs/Claude/mcp-server-openweather-forecast.log

# Windows
type "%APPDATA%\Claude\logs\mcp-server-openweather-forecast.log"
```

| Symptom | Cause |
|---|---|
| Connector absent entirely | Invalid JSON in the config (a trailing comma is the usual culprit), or Claude wasn't fully quit |
| `ERR_MODULE_NOT_FOUND` | `cwd` missing or wrong |
| `spawn ENOENT` | The `command` path is wrong — re-run `command -v node` |
| Unparseable-message errors | Launched via `npm` instead of `node` (see step 5) |
| Tool errors mentioning `OPENWEATHER_API_KEY` | `.env` missing, key not pasted, or key not yet activated |
| Chart never renders but text works | `npm run build` wasn't run, so `dist/mcp-app.html` is absent |

To confirm the server itself is healthy, independent of Claude, run it by hand
from the project directory — it should print one line of JSON:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}' \
  | node --env-file-if-exists=.env --import tsx main.ts --stdio
```

## Try it

> "What's the weather forecast for Halifax this week?"

The chart appears in the chat. Switching **metric** (temp / humidity / wind /
pressure) reshapes the data already on the client — no server call. Switching
**units** or **day range** issues a real `tools/call`, because only the server
has that data.

## Layout

```
main.ts                     transport selection: --stdio | Streamable HTTP
server.ts                   createServer(): the tool + the ui:// resource
src/openweather.ts          the ONLY module that talks to OpenWeather
src/mcp-app.tsx             React root, useApp(), callServerTool
src/components/             ForecastChart (Recharts), Controls
tests/unit/                 openweather: transform, schemas, error mapping
tests/server/               the MCP boundary, over an in-memory transport
tests/e2e/                  built bundle + a fake host bridge
tests/contract/             opt-in live API call (schema drift)
```

`src/openweather.ts` validates **both** upstream responses with zod before use —
it's a trust boundary — and maps failures to messages that never interpolate the
response body, since OpenWeather can echo the `appid` back. There's a test
asserting the key never appears in an error message.

## Testing

```bash
npm test          # unit + server. Hermetic: MSW intercepts all HTTP.
npm run test:e2e  # Playwright against dist/mcp-app.html (run npm run build first)
npm run test:live # opt-in: one REAL API call, asserts schema only
```

MSW runs with `onUnhandledRequest: "error"`, so an accidental real network call
fails the suite rather than passing quietly.

`tests/e2e/fake-host.ts` is a ~100-line host implementation and doubles as
protocol documentation: it answers `ui/initialize`, pushes
`ui/notifications/tool-result`, and serves `tools/call` from a queue while
recording each call. Three things that cost real debugging time:

- `McpUiInitializeResult` requires `protocolVersion`, `hostInfo`,
  `hostCapabilities` (**not** `capabilities`), and `hostContext`. Get one wrong
  and the app renders "Could not connect to the host".
- The tool-result notification's `params` **is** the tool result —
  `content`/`structuredContent` sit at the top level of `params`, not nested
  under a `result` key.
- The app must run in an **iframe**. It posts to `window.parent`, so loaded
  top-level it just talks to itself. Hence `tests/e2e/harness.html`. And because
  `addInitScript` runs in *every* frame, the fake host bails out with
  `if (window.parent !== window) return;` or the two frames ping-pong forever.

On a restricted machine where Chromium can't do its normal multi-process launch,
set `PW_SINGLE_PROCESS=1` (see `playwright.config.ts`). Note that under
`--single-process` the browser doesn't survive closing a context, so only the
first test per worker runs — pass `-g "<test title>"` to run them one at a time.

### Verifying against a real host

The fake bridge proves this app's logic, **not** host compatibility — it doesn't
enforce the iframe sandbox or CSP. For that:

```bash
git clone https://github.com/modelcontextprotocol/ext-apps
cd ext-apps/examples/basic-host && npm install
SERVERS='["http://localhost:3001/mcp"]' npm start   # then open localhost:8080
```

Confirm the chart draws, the icons load (that's the CSP allowance working), and a
control change shows a new `tools/call` in the server log.

## Why forecast and not history

The original goal was *historical* weather. OpenWeather's historical endpoints
(One Call 3.0 `timemachine` and `day_summary`) need a separate paid "One Call by
Call" subscription and return 401 on a free-tier key. So this uses the free
5 day / 3 hour forecast instead. Don't spend an afternoon rediscovering that.

## POC caveats

- **Bundle size.** `vite-plugin-singlefile` inlines React and Recharts into one
  ~920 KB HTML resource. Fine for a demo, not a production recommendation —
  a real app would trim the chart library or load from a CDN with the right
  `resourceDomains`.
- **`updateModelContext` is deliberately unimplemented.** `src/mcp-app.tsx`
  carries a commented `reportExploration()` stub marking where the app would
  tell the model what the user explored. Left as an exercise.
- No auth, no caching, no in-app location search.
