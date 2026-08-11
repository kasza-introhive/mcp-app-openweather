/**
 * @file The MCP App itself.
 *
 * Lifecycle:
 *   1. `useApp()` creates an App, registers handlers, and connects to the host.
 *   2. The host pushes the tool result via `ontoolresult`; `structuredContent`
 *      seeds the chart.
 *   3. In-app controls call `app.callServerTool()` to fetch *fresh* data --
 *      the bidirectional flow that makes this an MCP App rather than a static
 *      rendering.
 */
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ForecastChart, type Metric } from "./components/ForecastChart.tsx";
import { Controls } from "./components/Controls.tsx";
import {
  ICON_BASE_URL,
  unitSymbols,
  type ForecastSeries,
  type Units,
} from "./openweather.ts";
import styles from "./mcp-app.module.css";
import "./global.css";

const TOOL_NAME = "get-forecast";

/**
 * Pull the forecast series out of a tool result.
 *
 * Prefers `structuredContent` (the full typed payload). This is untrusted input
 * from the app's perspective, so it is shape-checked before use rather than
 * cast blindly.
 */
function extractSeries(result: CallToolResult): ForecastSeries | null {
  const candidate = result.structuredContent as unknown;
  if (
    candidate &&
    typeof candidate === "object" &&
    Array.isArray((candidate as ForecastSeries).points) &&
    (candidate as ForecastSeries).location != null
  ) {
    return candidate as ForecastSeries;
  }
  return null;
}

function errorTextOf(result: CallToolResult): string {
  const text = result.content?.find((c) => c.type === "text");
  return text && "text" in text ? text.text : "The forecast request failed.";
}

function ForecastApp() {
  const [series, setSeries] = useState<ForecastSeries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();

  const { app, error: connectionError } = useApp({
    appInfo: { name: "OpenWeather Forecast App", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app) => {
      // Fires when the host pushes the result of the tool call that opened
      // this app, and again for any result the host chooses to forward.
      app.ontoolresult = (result) => {
        if (result.isError) {
          setError(errorTextOf(result));
          return;
        }
        const next = extractSeries(result);
        if (next) {
          setSeries(next);
          setError(null);
        } else {
          setError("The tool result did not contain forecast data.");
        }
      };

      app.ontoolinput = (input) => {
        // Useful for streaming/preloading: arguments can arrive before the
        // result does.
        console.info("tool input:", input);
      };

      app.onteardown = async () => {
        console.info("app teardown");
        return {};
      };

      app.onerror = (err) => console.error("app error:", err);

      app.onhostcontextchanged = (ctx) => {
        setHostContext((prev) => ({ ...prev, ...ctx }));
      };
    },
  });

  useEffect(() => {
    if (app) setHostContext(app.getHostContext());
  }, [app]);

  if (connectionError) {
    return (
      <main className={styles.main}>
        <div className={`${styles.status} ${styles.error}`}>
          Could not connect to the host: {connectionError.message}
        </div>
      </main>
    );
  }

  if (!app) {
    return (
      <main className={styles.main}>
        <div className={styles.status}>Connecting…</div>
      </main>
    );
  }

  return (
    <ForecastAppInner
      app={app}
      series={series}
      setSeries={setSeries}
      error={error}
      setError={setError}
      hostContext={hostContext}
    />
  );
}

interface InnerProps {
  app: App;
  series: ForecastSeries | null;
  setSeries: (series: ForecastSeries) => void;
  error: string | null;
  setError: (error: string | null) => void;
  hostContext?: McpUiHostContext;
}

function ForecastAppInner({
  app,
  series,
  setSeries,
  error,
  setError,
  hostContext,
}: InnerProps) {
  const [metric, setMetric] = useState<Metric>("temp");
  const [days, setDays] = useState(5);
  const [busy, setBusy] = useState(false);

  // Units are owned by the server response, not local state -- otherwise the
  // toggle could disagree with the data currently on screen.
  const units: Units = series?.units ?? "metric";

  /**
   * Re-fetch through the host.
   *
   * `callServerTool` is proxied by the host to the MCP server, so this is a
   * real network round-trip: keep the UI responsive and surface failures.
   */
  const refetch = useCallback(
    async (next: { units?: Units; days?: number }) => {
      if (!series) return;
      setBusy(true);
      try {
        const result = await app.callServerTool({
          name: TOOL_NAME,
          arguments: {
            // Re-derive the location from the current series so the app never
            // invents a place the user didn't ask about.
            location: `${series.location.name},${series.location.country}`,
            units: next.units ?? units,
            days: next.days ?? days,
          },
        });

        if (result.isError) {
          setError(errorTextOf(result));
          return;
        }
        const parsed = extractSeries(result);
        if (parsed) {
          setSeries(parsed);
          setError(null);
        } else {
          setError("The tool result did not contain forecast data.");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [app, series, units, days, setSeries, setError],
  );

  const handleUnitsChange = useCallback(
    (nextUnits: Units) => {
      if (nextUnits !== units) void refetch({ units: nextUnits });
    },
    [refetch, units],
  );

  const handleDaysChange = useCallback(
    (nextDays: number) => {
      if (nextDays === days) return;
      setDays(nextDays);
      void refetch({ days: nextDays });
    },
    [refetch, days],
  );

  /*
   * NOT WIRED UP -- intentional next step.
   *
   * `app.updateModelContext()` tells the model what the user explored in the
   * app, so a follow-up question like "why is Thursday so wet?" has grounding.
   * Left as a stub because it needs thought about *when* to fire (every toggle
   * would be far too chatty) and how much detail is useful without flooding the
   * conversation. Sketch:
   *
   *   const reportExploration = useCallback(async () => {
   *     await app.updateModelContext({
   *       content: [{
   *         type: "text",
   *         text: `User is viewing ${metric} for ${series.location.name} `
   *             + `over ${days} day(s) in ${units} units.`,
   *       }],
   *     });
   *   }, [app, metric, series, days, units]);
   *
   * Probably debounced, or fired on an explicit "discuss this" affordance
   * rather than on every interaction.
   */

  const current = series?.points[0];
  const symbols = useMemo(() => unitSymbols(units), [units]);

  return (
    <main
      className={styles.main}
      style={{
        // Respect any chrome the host reserves (rounded corners, toolbars).
        paddingTop: hostContext?.safeAreaInsets?.top,
        paddingRight: hostContext?.safeAreaInsets?.right,
        paddingBottom: hostContext?.safeAreaInsets?.bottom,
        paddingLeft: hostContext?.safeAreaInsets?.left,
      }}
    >
      {series && (
        <header className={styles.header}>
          <div>
            <h1 className={styles.place} data-testid="location">
              {series.location.name}, {series.location.country}
            </h1>
            <p className={styles.subtitle}>
              {series.points.length} readings · 3-hour steps · local time
            </p>
          </div>

          {current && (
            <div className={styles.now}>
              <img
                className={styles.nowIcon}
                // Loaded from openweathermap.org, which is why the resource
                // declares that origin in `_meta.ui.csp.resourceDomains`.
                src={`${ICON_BASE_URL}/${current.icon}@2x.png`}
                alt={current.description}
              />
              <span className={styles.nowTemp} data-testid="current-temp">
                {current.temp.toFixed(1)}
                {symbols.temp}
              </span>
            </div>
          )}
        </header>
      )}

      {error && (
        <div className={`${styles.status} ${styles.error}`} data-testid="error">
          {error}
        </div>
      )}

      {series ? (
        <>
          <Controls
            metric={metric}
            units={units}
            days={days}
            busy={busy}
            onMetricChange={setMetric}
            onUnitsChange={handleUnitsChange}
            onDaysChange={handleDaysChange}
          />
          {busy && (
            <div className={styles.loadingBar} data-testid="busy">
              Fetching updated forecast…
            </div>
          )}
          <ForecastChart series={series} metric={metric} />
        </>
      ) : (
        !error && (
          <div className={styles.status} data-testid="waiting">
            Waiting for forecast data…
          </div>
        )
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ForecastApp />
  </StrictMode>,
);
