/**
 * @file A minimal MCP Apps host, implemented as a browser-side script.
 *
 * It speaks just enough of the postMessage dialect to drive the app:
 *   - answers `ui/initialize`
 *   - pushes `ui/notifications/tool-result`
 *   - answers `tools/call` from a queue of canned results, recording each call
 *
 * This doubles as documentation of the protocol -- it is roughly the smallest
 * thing that makes an MCP App run.
 *
 * Note the app is loaded in an *iframe* (harness.html): the App SDK posts to
 * `window.parent`, so a top-level page would just talk to itself.
 *
 * NOT a real host: it does not enforce the iframe sandbox or CSP, so passing
 * specs prove the app's logic, not host compatibility. See the README for
 * verifying against the real `basic-host`.
 */

export interface RecordedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Runs in the harness page via `page.addInitScript`.
 *
 * Everything here executes in the browser and cannot close over Node values, so
 * all data arrives through the single `config` argument.
 */
export function installFakeHost(config: {
  /** Path to the built bundle, assigned to the iframe once the DOM is ready. */
  bundleUrl: string;
  /** Result pushed after the app initializes. */
  initialResult: unknown;
  /** Results returned to successive `tools/call` requests, in order. */
  queuedResults: unknown[];
}) {
  // `addInitScript` runs in EVERY frame, including the app's iframe. Without
  // this guard the app's own frame would install a second host, echo replies
  // back to the parent, and the two would ping-pong forever.
  if (window.parent !== window) return;

  const PROTOCOL_VERSION = "2026-01-26";

  const recorded: RecordedToolCall[] = [];
  const queue = [...config.queuedResults];

  // Exposed for assertions from the spec.
  (window as unknown as Record<string, unknown>).__toolCalls = recorded;

  window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data;
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;

    const { id, method, params } = message as {
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
    };

    // Reply to whoever sent the message -- the app's iframe window.
    const source = event.source as WindowProxy | null;
    const send = (payload: unknown) => source?.postMessage(payload, "*");
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id, result });

    switch (method) {
      case "ui/initialize": {
        // Every field here is REQUIRED by McpUiInitializeResult. Omitting one
        // (or using `capabilities` instead of `hostCapabilities`) fails the
        // app's own zod validation and it renders "Could not connect".
        reply({
          protocolVersion: PROTOCOL_VERSION,
          hostInfo: { name: "fake-host", version: "1.0.0" },
          hostCapabilities: { serverTools: {} },
          hostContext: { theme: "light" },
        });
        return;
      }

      case "ui/notifications/initialized": {
        // The app is ready; now push the result that opened it.
        //
        // `params` IS the tool result -- content/structuredContent sit at the
        // top level of params, they are NOT nested under a `result` key.
        send({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: config.initialResult,
        });
        return;
      }

      case "tools/call": {
        recorded.push({
          name: String(params?.name),
          arguments: (params?.arguments ?? {}) as Record<string, unknown>,
        });
        // Replay the last queued result if a spec clicks more than it queues.
        const next = queue.shift() ?? config.queuedResults.at(-1) ?? config.initialResult;
        reply(next);
        return;
      }

      // Requests the app may make that these specs don't assert on.
      case "ui/update-model-context":
      case "ui/message":
      case "ui/open-link":
      case "ui/request-display-mode":
        reply({});
        return;

      default:
        // Notifications carry no id and need no reply.
        if (id !== undefined) reply({});
    }
  });

  // Point the iframe at the bundle once the DOM exists.
  const attach = () => {
    const frame = document.getElementById("app-frame") as HTMLIFrameElement | null;
    if (frame) frame.src = config.bundleUrl;
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }
}
