/**
 * @file Opt-in contract test against the real OpenWeather API.
 *
 * Mocks cannot catch upstream schema drift -- that is the one thing only a real
 * call proves. So this suite exists, but it never runs by default:
 *
 *   RUN_LIVE=1 npm test
 *
 * It asserts SHAPE, not values. Weather changes; the schema should not.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchForecast, resolveLocation, toSeries } from "../../src/openweather.ts";
import { server } from "../msw/handlers.ts";

const enabled = !!process.env.RUN_LIVE && !!process.env.OPENWEATHER_API_KEY;

describe.skipIf(!enabled)("live OpenWeather contract (RUN_LIVE=1)", () => {
  /*
   * `tests/setup.node.ts` starts MSW with `onUnhandledRequest: "error"`, which
   * would reject these calls outright. Stand it down for this file only, then
   * restore it so a later suite in the same worker stays hermetic.
   */
  beforeAll(() => server.close());
  afterAll(() => server.listen({ onUnhandledRequest: "error" }));

  it("geocodes a real city", async () => {
    const location = await resolveLocation("Halifax,CA");
    expect(location.name).toEqual(expect.any(String));
    expect(location.lat).toEqual(expect.any(Number));
    expect(location.lon).toEqual(expect.any(Number));
  });

  it("returns a forecast that still matches our zod schema", async () => {
    const location = await resolveLocation("Halifax,CA");

    // fetchForecast parses with ForecastResponseSchema internally, so an upstream
    // field rename or type change fails here rather than silently in the UI.
    const response = await fetchForecast({
      lat: location.lat,
      lon: location.lon,
      units: "metric",
    });

    expect(response.list.length).toBeGreaterThan(0);
    expect(response.city.timezone).toEqual(expect.any(Number));

    const series = toSeries(response, "metric", 1);
    expect(series.points).toHaveLength(8);
    expect(series.points[0]).toMatchObject({
      label: expect.any(String),
      temp: expect.any(Number),
      pop: expect.any(Number),
      icon: expect.any(String),
    });
  });

  it("reports an unknown location clearly rather than crashing", async () => {
    await expect(resolveLocation("zzzznotarealplacezzzz")).rejects.toThrow();
  });
});
