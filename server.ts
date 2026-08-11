/**
 * @file MCP server: one tool paired with one `ui://` resource.
 *
 * The pairing is the heart of MCP Apps:
 *   1. `registerAppTool` declares `_meta.ui.resourceUri`.
 *   2. `registerAppResource` serves the HTML at that exact URI.
 * A host reads (1) to know what to fetch and render for (2). Break either side
 * and the tool silently degrades to plain text -- which is why there's a test
 * asserting the URI is present on `tools/list`.
 */
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  fetchForecast,
  forecastSeriesShape,
  resolveLocation,
  summarize,
  toSeries,
  UNITS,
  type ForecastSeries,
} from "./src/openweather.ts";

// Resolves correctly whether running from source via tsx (server.ts) or from a
// compiled build (dist/server.js).
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;

export const RESOURCE_URI = "ui://weather-forecast/mcp-app.html";
export const TOOL_NAME = "get-forecast";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "OpenWeather Forecast MCP App",
    version: "1.0.0",
  });

  registerAppTool(
    server,
    TOOL_NAME,
    {
      title: "Get Weather Forecast",
      description:
        "Fetches a 5-day / 3-hour weather forecast for a location and displays it as an " +
        "interactive chart. Accepts a city name, optionally with a country code " +
        '(e.g. "Halifax,CA"). Note: this returns a FORECAST, not historical weather.',
      inputSchema: {
        location: z.string().min(1).describe('City name, optionally with country code, e.g. "Berlin,DE"'),
        units: z
          .enum(UNITS)
          .default("metric")
          .describe("metric = °C/m/s, imperial = °F/mph, standard = K/m/s"),
        days: z
          .number()
          .int()
          .min(1)
          .max(5)
          .default(5)
          .describe("How many days of forecast to return (1-5)"),
      },
      // Declares the shape of `structuredContent`. The app hard-depends on that
      // field, and a tool returning structured data should advertise it: hosts
      // and clients use `outputSchema` to decide whether to expect, validate,
      // and forward `structuredContent` at all.
      outputSchema: forecastSeriesShape,
      // Links this tool to the UI resource below.
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ location, units, days }): Promise<CallToolResult> => {
      // Errors from the data layer intentionally propagate: the MCP SDK converts
      // a thrown error into an `isError` result, and OpenWeatherError messages
      // are already written to be safe and actionable for the caller.
      const place = await resolveLocation(location);
      const forecast = await fetchForecast({ lat: place.lat, lon: place.lon, units });
      const series: ForecastSeries = toSeries(forecast, units, days);

      // Two representations of one result, per the MCP Apps large-payload
      // pattern:
      //   - `content`           -> compact text, cheap for the model to read.
      //   - `structuredContent` -> full series, what the chart actually renders.
      const result: CallToolResult = {
        content: [{ type: "text", text: summarize(series) }],
        structuredContent: series as unknown as Record<string, unknown>,
      };

      // Set MCP_APP_DEBUG=1 to record what the handler actually returned. This
      // is the only way to observe the server end of the payload from inside a
      // real host -- it lands in the host's server log (see
      // docs/TROUBLESHOOTING.md). `console.error`, never `console.log`: stdout
      // is the JSON-RPC channel under stdio.
      if (process.env.MCP_APP_DEBUG === "1") {
        console.error(
          `[${TOOL_NAME}] returning content=${result.content.length} block(s), ` +
            `structuredContent.points=${series.points.length}, location=${series.location.name}`,
        );
      }

      return result;
    },
  );

  registerAppResource(
    server,
    "Weather Forecast Chart", // human-readable name shown by hosts
    RESOURCE_URI,
    {
      mimeType: RESOURCE_MIME_TYPE,
      // The bundle is self-contained except for OpenWeather's condition icons,
      // so that single origin is allowlisted. Without this the host's
      // deny-by-default CSP blocks the images. Kept as a worked example of the
      // field -- drop it if you inline the icons.
      _meta: {
        ui: {
          csp: { resourceDomains: ["https://openweathermap.org"] },
        },
      },
    },
    async (): Promise<ReadResourceResult> => {
      const htmlPath = path.join(DIST_DIR, "mcp-app.html");
      let html: string;
      try {
        html = await fs.readFile(htmlPath, "utf-8");
      } catch {
        throw new Error(
          `UI bundle not found at ${htmlPath}. Run \`npm run build\` before serving.`,
        );
      }
      return {
        contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  return server;
}
