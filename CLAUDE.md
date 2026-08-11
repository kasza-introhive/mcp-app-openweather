# CLAUDE.md

POC **MCP App**: an MCP server whose `get-forecast` tool renders an interactive
Recharts chart in the chat, with in-app controls that call back into the server.

The deliverable is a *readable reference* for the MCP Apps extension, meant to be
shared. Clarity of the pattern counts as much as the feature — prefer the
obvious implementation and a comment explaining why over a clever one.

## Commands

```bash
npm run build      # tsc --noEmit, then bundle the UI into dist/mcp-app.html
npm test           # unit + server suites (hermetic, MSW-backed)
npm run test:e2e   # Playwright against the built bundle -- run build first
npm run test:live  # OPT-IN: makes a real OpenWeather call
npm run typecheck
npm run serve      # Streamable HTTP on :3001/mcp
npm run serve:stdio
```

`npm test` does **not** cover the UI — E2E is a separate command. Run both
before claiming a change works.

## Architecture

Two registrations tied by one URI, and that link is the whole extension:

```
registerAppTool(..., _meta: { ui: { resourceUri: RESOURCE_URI } })
registerAppResource(server, name, RESOURCE_URI, { mimeType: RESOURCE_MIME_TYPE }, cb)
```

Break the `_meta.ui.resourceUri` link and nothing errors — the tool silently
degrades to text with no UI. `tests/server/server.test.ts` asserts on it for
exactly that reason; don't delete that test.

- `src/openweather.ts` — the **only** module that talks to OpenWeather. Keep it
  that way; everything else consumes `ForecastSeries`.
- `server.ts` — `createServer()`, the tool and the `ui://` resource.
- `main.ts` — transport selection.
- `src/mcp-app.tsx` — React root, `useApp()`, `callServerTool`.

### Invariants worth preserving

- **The payload split.** Tool results return `content[0].text` (short summary,
  for the model) *and* `structuredContent` (full series, for the chart). Don't
  make the model pay for 40 data points it won't read.
- **stdout is the JSON-RPC channel under stdio.** Every diagnostic uses
  `console.error`. One `console.log` in the server path corrupts the stream.
- **Error messages never interpolate the upstream response body** — OpenWeather
  echoes the `appid` back. `describeHttpFailure` maps status codes to fixed
  strings, and a test asserts the key never appears in a message. Keep both.
- **Both upstream responses are zod-validated** before use. It's a trust
  boundary, not a formality.
- **`toSeries` derives local time arithmetically** from `city.timezone` using
  `getUTC*`, so output never depends on the host's locale. Fixtures use a
  non-zero offset (UTC+2) so a UTC-vs-local bug can't hide.
- `units` is server-owned: the UI derives its toggle state from
  `series.units`, so the control can't disagree with the data on screen.

## Testing notes

Anything date-derived uses frozen time (`vi.setSystemTime`). MSW runs with
`onUnhandledRequest: "error"`, so a stray real network call fails the suite
instead of passing quietly. Fixtures are synthetic — never paste real payloads.

`tests/e2e/fake-host.ts` is a minimal host and doubles as protocol
documentation. Three things that cost real debugging time:

- `McpUiInitializeResult` requires `protocolVersion`, `hostInfo`,
  `hostCapabilities` (**not** `capabilities`), and `hostContext`. Get one wrong
  and the app renders "Could not connect to the host".
- The tool-result notification's `params` **is** the tool result —
  `content`/`structuredContent` at the top level of `params`, not under
  `result`.
- The app must run in an **iframe** (it posts to `window.parent`), hence
  `harness.html`. And `addInitScript` runs in every frame, so the fake host
  bails with `if (window.parent !== window) return;` or the frames ping-pong.

When protocol shapes are in question, read the generated schema rather than
guessing: `node_modules/@modelcontextprotocol/ext-apps/dist/src/generated/schema.json`.

The fake bridge does **not** enforce the iframe sandbox or CSP, so passing E2E
proves this app's logic, not host compatibility. See the README for verifying
against `ext-apps/examples/basic-host`.

## The Claude Desktop fallback

`ontoolresult` has a recovery path: when the pushed result carries no series,
the app re-fetches with the arguments captured from `ontoolinput`. Claude
Desktop forwards the *model-facing* copy of the tool result — original text plus
a synthetic "the user can already see the widget" note — and drops
`structuredContent`. App-initiated calls are unaffected, which is what makes the
recovery work.

It only runs when the series is missing, so a correct host never reaches it.
Remove it once the push path is fixed upstream; `docs/TROUBLESHOOTING.md` has
the evidence.

## Debugging

`docs/TROUBLESHOOTING.md` is the reference: the payload crosses five rungs
(data → handler → wire → host bridge → render) and each is observable in
isolation. Keep it current — it's a deliverable, not scratch notes.

The constraint that shapes the diagnostics: **a real host may give you no
console.** Claude Desktop's webview exposes no DevTools, so `console.log` in the
app goes nowhere. Hence two rules:

- **On-screen errors carry their own diagnosis.** `describeResultShape()` in
  `src/debug.ts` reports what actually arrived, and `missingDataError()` embeds
  it in the visible message (`structuredContent=absent` vs `points=0` are
  different bugs). Don't reduce these back to a bare string.
- **Verbose logging is gated, never ad-hoc.** `debugLog` behind `?mcpDebug=1` in
  the app; `MCP_APP_DEBUG=1` for the server handler. Server-side logging must
  use `console.error` — stdout is the JSON-RPC channel under stdio.

MCP Inspector is the fastest way to see the wire without a host:
`npx @modelcontextprotocol/inspector node --env-file-if-exists=.env --import tsx main.ts --stdio`.
If `structuredContent` is right there but missing in the app, the server is
exonerated.

`outputSchema` on the tool is asserted by `tests/server/server.test.ts` for the
same reason as `_meta.ui.resourceUri`: the app renders `structuredContent` and
nothing else, so the tool must declare it. Note the SDK does *not* strip
`structuredContent` when `outputSchema` is absent (verified in `server/mcp.js`
and `client/index.js`) — so if the field vanishes, suspect the host.

## Environment constraints

Pinned deliberately: `vite` 7 and `@vitejs/plugin-react` ^5.2.0 —
plugin-react 6 peer-requires vite 8. Don't bump one without the other.

Scripts use `node --env-file-if-exists=.env --import tsx` rather than bare
`tsx`, both to load `.env` and because `tsx`'s own CLI can't spawn its IPC pipe
in a restricted sandbox.

The MCP Apps extension is under active development. This is written against
`ext-apps@1.7.5` / `sdk@1.30.0`; treat those versions as part of the API and
re-read the schema after upgrading.

## Scope

Deliberately absent: auth, caching, historical data, in-app location search.
`updateModelContext` is an intentional commented stub in `src/mcp-app.tsx`.

Historical weather was dropped because One Call 3.0 (`timemachine`,
`day_summary`) needs a paid subscription and 401s on a free key. Don't retry it.
