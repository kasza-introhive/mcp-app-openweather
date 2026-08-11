/**
 * @file E2E specs against the built bundle, driven by the fake host bridge.
 *
 * Run `npm run build` first -- these load `dist/mcp-app.html` from disk.
 */
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeForecastResponse } from "../fixtures/forecast.ts";
import { installFakeHost, type RecordedToolCall } from "./fake-host.ts";

const BUNDLE = path.join(process.cwd(), "dist", "mcp-app.html");
const HARNESS = path.join(import.meta.dirname, "harness.html");

/**
 * Build a tool result the way the server does, without importing the server
 * (which would pull Node-only modules into the Playwright context).
 */
function toolResult(options: { units?: "metric" | "imperial" | "standard"; days?: number } = {}) {
  const units = options.units ?? "metric";
  const days = options.days ?? 5;
  const response = makeForecastResponse(40);
  const offset = response.city.timezone;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pad = (n: number) => String(n).padStart(2, "0");

  const points = response.list.slice(0, days * 8).map((entry) => {
    const local = new Date((entry.dt + offset) * 1000);
    return {
      dt: entry.dt,
      label: `${weekdays[local.getUTCDay()]} ${pad(local.getUTCHours())}:00`,
      day: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
      temp: entry.main.temp,
      feelsLike: entry.main.feels_like,
      humidity: entry.main.humidity,
      pressure: entry.main.pressure,
      windSpeed: entry.wind.speed,
      clouds: entry.clouds.all,
      pop: Math.round(entry.pop * 100),
      rain: (entry as { rain?: { "3h": number } }).rain?.["3h"] ?? 0,
      snow: (entry as { snow?: { "3h": number } }).snow?.["3h"] ?? 0,
      condition: entry.weather[0]!.main,
      description: entry.weather[0]!.description,
      icon: entry.weather[0]!.icon,
    };
  });

  const series = {
    location: {
      name: response.city.name,
      country: response.city.country,
      lat: response.city.coord.lat,
      lon: response.city.coord.lon,
    },
    units,
    timezoneOffsetSeconds: offset,
    points,
  };

  return {
    content: [{ type: "text", text: `Forecast for ${series.location.name}` }],
    structuredContent: series,
  };
}

function errorResult(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Load the harness page, which hosts the built app in an iframe, and return a
 * locator scoped to the app's frame.
 */
async function openApp(
  page: Page,
  config: { initialResult: unknown; queuedResults?: unknown[] },
): Promise<FrameLocator> {
  // Block outbound icon requests: no network in tests, and a hanging image
  // shouldn't slow the suite.
  await page.route("https://openweathermap.org/**", (route) => route.abort());

  await page.addInitScript(installFakeHost, {
    bundleUrl: pathToFileURL(BUNDLE).href,
    initialResult: config.initialResult,
    queuedResults: config.queuedResults ?? [],
  });
  await page.goto(pathToFileURL(HARNESS).href);

  return page.frameLocator("#app-frame");
}

function recordedCalls(page: Page): Promise<RecordedToolCall[]> {
  return page.evaluate(
    () => (window as unknown as { __toolCalls: RecordedToolCall[] }).__toolCalls,
  );
}

test.beforeAll(() => {
  if (!fs.existsSync(BUNDLE)) {
    throw new Error(`Missing ${BUNDLE}. Run \`npm run build\` before \`npm run test:e2e\`.`);
  }
});

test.describe("initial render", () => {
  test("renders the chart from the pushed tool result", async ({ page }) => {
    const app = await openApp(page, { initialResult: toolResult() });

    await expect(app.getByTestId("location")).toHaveText("Halifax, CA");

    const chart = app.getByTestId("forecast-chart");
    await expect(chart).toBeVisible();
    // The chart must actually draw, not just mount. Scope to the plot surface:
    // Recharts also renders a small <svg> per legend entry.
    await expect(chart.locator("svg.recharts-surface").first()).toBeVisible();
    await expect(chart.getByRole("application")).toBeVisible();
    await expect(chart.locator(".recharts-line")).toHaveCount(2); // metric + feels-like

    // One bar per 3-hour step.
    await expect(chart.locator(".recharts-bar-rectangle")).toHaveCount(40);
  });

  test("shows the current temperature", async ({ page }) => {
    const app = await openApp(page, { initialResult: toolResult() });
    await expect(app.getByTestId("current-temp")).toContainText("°C");
  });

  test("renders an error result instead of a chart", async ({ page }) => {
    const app = await openApp(page, {
      initialResult: errorResult("OPENWEATHER_API_KEY is not set."),
    });
    await expect(app.getByTestId("error")).toContainText("OPENWEATHER_API_KEY");
    await expect(app.getByTestId("forecast-chart")).toHaveCount(0);
  });

  /*
   * The failure mode that cost real debugging time: a successful result whose
   * `structuredContent` never reaches the app. `structuredContent` is OPTIONAL
   * in `McpUiToolResultNotification`, so a host is free not to forward it and
   * the app sees a result that looks fine apart from the one field it needs.
   *
   * The assertion on the shape text is the point -- the message has to say what
   * arrived, because a real host may give you no console to inspect.
   * See docs/TROUBLESHOOTING.md.
   */
  test("reports the received shape when structuredContent is absent", async ({ page }) => {
    const app = await openApp(page, {
      initialResult: { content: [{ type: "text", text: "Forecast for Halifax" }] },
    });

    const error = app.getByTestId("error");
    await expect(error).toContainText("did not contain forecast data");
    await expect(error).toContainText("structuredContent=absent");
    await expect(app.getByTestId("forecast-chart")).toHaveCount(0);
  });

  test("reports the received shape when the series has no points", async ({ page }) => {
    const result = toolResult();
    const app = await openApp(page, {
      initialResult: { ...result, structuredContent: { ...result.structuredContent, points: [] } },
    });

    // An empty series must error rather than draw an empty chart.
    await expect(app.getByTestId("error")).toContainText("points=0");
    await expect(app.getByTestId("forecast-chart")).toHaveCount(0);
  });
});

test.describe("client-side controls", () => {
  test("switching metric re-renders WITHOUT a new tool call", async ({ page }) => {
    const app = await openApp(page, { initialResult: toolResult() });
    await expect(app.getByTestId("forecast-chart")).toBeVisible();

    await app.getByTestId("metric-humidity").click();

    await expect(app.getByTestId("metric-humidity")).toHaveAttribute("aria-pressed", "true");
    // Humidity has no companion series, so only one line remains.
    await expect(app.getByTestId("forecast-chart").locator(".recharts-line")).toHaveCount(1);

    expect(await recordedCalls(page)).toHaveLength(0);
  });
});

test.describe("server-backed controls", () => {
  /*
   * The assertion that matters most: an in-app interaction produces a real
   * `tools/call` back through the host. This is the bidirectional flow that
   * distinguishes an MCP App from a static rendering.
   */
  test("changing units issues a tools/call with the right arguments", async ({ page }) => {
    const app = await openApp(page, {
      initialResult: toolResult(),
      queuedResults: [toolResult({ units: "imperial" })],
    });
    await expect(app.getByTestId("forecast-chart")).toBeVisible();

    await app.getByTestId("units-imperial").click();

    await expect(app.getByTestId("current-temp")).toContainText("°F");

    const calls = await recordedCalls(page);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("get-forecast");
    expect(calls[0]!.arguments).toMatchObject({
      location: "Halifax,CA",
      units: "imperial",
      days: 5,
    });
  });

  test("changing the day range issues a tools/call and shrinks the chart", async ({ page }) => {
    const app = await openApp(page, {
      initialResult: toolResult(),
      queuedResults: [toolResult({ days: 1 })],
    });
    await expect(app.getByTestId("forecast-chart")).toBeVisible();

    await app.getByTestId("days-1").click();

    await expect(app.getByTestId("forecast-chart").locator(".recharts-bar-rectangle")).toHaveCount(
      8,
    );

    const calls = await recordedCalls(page);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.arguments).toMatchObject({ days: 1 });
  });

  test("re-clicking the active unit does not re-fetch", async ({ page }) => {
    const app = await openApp(page, { initialResult: toolResult() });
    await expect(app.getByTestId("forecast-chart")).toBeVisible();

    await app.getByTestId("units-metric").click();

    expect(await recordedCalls(page)).toHaveLength(0);
  });

  test("surfaces a failed re-fetch as an error", async ({ page }) => {
    const app = await openApp(page, {
      initialResult: toolResult(),
      queuedResults: [errorResult("OpenWeather rate limit exceeded (429).")],
    });
    await expect(app.getByTestId("forecast-chart")).toBeVisible();

    await app.getByTestId("units-imperial").click();

    await expect(app.getByTestId("error")).toContainText("rate limit");
    // The previously loaded chart stays on screen rather than blanking out.
    await expect(app.getByTestId("forecast-chart")).toBeVisible();
  });
});
