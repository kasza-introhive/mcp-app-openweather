/**
 * @file Diagnostics for the app side of the host<->app boundary.
 *
 * Why this exists: when an MCP App misbehaves inside a real host, the app runs
 * in an iframe whose console you usually cannot open (Claude Desktop exposes no
 * DevTools). A `console.log` there goes nowhere. So the primary diagnostic
 * channel is *the rendered page itself* -- `describeResultShape` is meant to be
 * appended to an on-screen error, which is the one output that always survives.
 *
 * `debugLog` is the secondary channel, for hosts where a console is reachable
 * (the E2E harness, `basic-host` in a browser tab).
 */

/**
 * Enabled by `?mcpDebug=1` on the app URL, or by a `mcpDebug` localStorage key.
 *
 * A host controls the URL it loads the bundle from, so the query param is not
 * always settable -- hence the localStorage fallback, which a host's devtools
 * can set if you have one, and the fact that nothing important depends on this
 * being on.
 */
function debugEnabled(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("mcpDebug") === "1") return true;
    return window.localStorage.getItem("mcpDebug") === "1";
  } catch {
    // Sandboxed iframes can throw on storage access. Never let diagnostics
    // become a source of failures.
    return false;
  }
}

const DEBUG = debugEnabled();

export function debugLog(...args: unknown[]): void {
  if (DEBUG) console.warn("[mcp-app]", ...args);
}

/**
 * A compact, human-readable description of what a tool result actually
 * contained -- without dumping a 40-point payload into the UI.
 *
 * This answers the question that matters when the payload goes missing: did the
 * host forward `structuredContent` at all, and if so, what was in it? Reports
 * the shape, never the values, so it is safe to show on screen.
 */
export function describeResultShape(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return `result is ${result === null ? "null" : typeof result}`;
  }

  const record = result as Record<string, unknown>;
  const keys = Object.keys(record);
  const parts = [`keys=[${keys.join(", ")}]`];

  const content = record.content;
  parts.push(`content=${Array.isArray(content) ? `${content.length} block(s)` : typeof content}`);

  const structured = record.structuredContent;
  if (structured === undefined) {
    // The interesting case: the host did not forward it.
    parts.push("structuredContent=absent");
  } else if (structured === null || typeof structured !== "object") {
    parts.push(`structuredContent=${structured === null ? "null" : typeof structured}`);
  } else {
    const inner = structured as Record<string, unknown>;
    const points = inner.points;
    parts.push(
      `structuredContent.keys=[${Object.keys(inner).join(", ")}]`,
      `points=${Array.isArray(points) ? `${points.length}` : typeof points}`,
      `location=${inner.location == null ? "absent" : "present"}`,
    );
  }

  return parts.join(" ");
}
