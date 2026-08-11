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

Registering with a stdio host (e.g. `claude mcp add`):

```json
{
  "command": "npm",
  "args": ["run", "serve:stdio"],
  "cwd": "/absolute/path/to/mcp-app-openweather"
}
```

Sharing the HTTP server as a custom connector:

```bash
npx cloudflared tunnel --url http://localhost:3001
# add the resulting https URL + /mcp as a custom connector
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
