/**
 * @file Unit tests for the data layer -- schemas, transforms, error mapping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchForecast,
  ForecastResponseSchema,
  OpenWeatherError,
  resolveLocation,
  summarize,
  toSeries,
  unitSymbols,
  type ForecastResponse,
} from "../../src/openweather.ts";
import {
  makeForecastResponse,
  FORECAST_RESPONSE,
  TIMEZONE_OFFSET_SECONDS,
} from "../fixtures/forecast.ts";
import {
  respondWithForecastBody,
  respondWithGeocodeBody,
  respondWithNetworkError,
  respondWithStatus,
} from "../msw/handlers.ts";

/** Parse the fixture the same way production code does. */
function validFixture(count?: number): ForecastResponse {
  return ForecastResponseSchema.parse(makeForecastResponse(count));
}

beforeEach(() => {
  // Frozen time: nothing in the suite should depend on the wall clock.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-11T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ForecastResponseSchema", () => {
  it("accepts a well-formed payload and ignores unknown fields", () => {
    const parsed = ForecastResponseSchema.parse(FORECAST_RESPONSE);
    expect(parsed.list).toHaveLength(40);
    expect(parsed.city.name).toBe("Halifax");
  });

  it.each([
    ["missing list", { city: FORECAST_RESPONSE.city }],
    ["empty list", { ...FORECAST_RESPONSE, list: [] }],
    ["missing city", { list: FORECAST_RESPONSE.list }],
  ])("rejects %s", (_label, payload) => {
    expect(ForecastResponseSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects a temperature sent as a string", () => {
    const broken = structuredClone(FORECAST_RESPONSE) as unknown as {
      list: { main: { temp: unknown } }[];
    };
    broken.list[0]!.main.temp = "15";
    expect(ForecastResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an entry with an empty weather array", () => {
    const broken = structuredClone(FORECAST_RESPONSE) as unknown as {
      list: { weather: unknown[] }[];
    };
    broken.list[0]!.weather = [];
    expect(ForecastResponseSchema.safeParse(broken).success).toBe(false);
  });
});

describe("toSeries", () => {
  it("labels points in the location's local time, not UTC", () => {
    const series = toSeries(validFixture(), "metric");
    // First entry is 2026-08-11T00:00:00Z; at UTC+2 that is 02:00 local.
    expect(series.points[0]!.label).toBe("Tue 02:00");
    expect(series.timezoneOffsetSeconds).toBe(TIMEZONE_OFFSET_SECONDS);
  });

  it("derives the day key from local time", () => {
    const series = toSeries(validFixture(), "metric");
    expect(series.points[0]!.day).toBe("2026-08-11");
  });

  it("converts pop from a 0-1 fraction to a percentage", () => {
    const series = toSeries(validFixture(), "metric");
    expect(series.points[0]!.pop).toBe(20);
    expect(series.points[1]!.pop).toBe(85);
  });

  it("defaults absent rain and snow to 0 rather than undefined", () => {
    const series = toSeries(validFixture(), "metric");
    // Index 0 has neither key in the fixture.
    expect(series.points[0]!.rain).toBe(0);
    expect(series.points[0]!.snow).toBe(0);
    // Index 1 has rain, index 2 has snow.
    expect(series.points[1]!.rain).toBe(1.25);
    expect(series.points[2]!.snow).toBe(0.4);
  });

  it("clamps to whole days of 3-hour steps", () => {
    expect(toSeries(validFixture(), "metric", 1).points).toHaveLength(8);
    expect(toSeries(validFixture(), "metric", 3).points).toHaveLength(24);
    expect(toSeries(validFixture(), "metric", 5).points).toHaveLength(40);
  });

  it.each([
    [0, 8],
    [-3, 8],
    [99, 40],
    [2.7, 16],
  ])("clamps out-of-range days=%s to %s points", (days, expected) => {
    expect(toSeries(validFixture(), "metric", days).points).toHaveLength(expected);
  });

  it("never returns more points than the payload contained", () => {
    const series = toSeries(validFixture(10), "metric", 5);
    expect(series.points).toHaveLength(10);
  });

  it("carries location and units through", () => {
    const series = toSeries(validFixture(), "imperial");
    expect(series.units).toBe("imperial");
    expect(series.location).toEqual({
      name: "Halifax",
      country: "CA",
      lat: 44.6488,
      lon: -63.5752,
    });
  });
});

describe("unitSymbols", () => {
  it.each([
    ["metric", "°C", "m/s"],
    ["imperial", "°F", "mph"],
    ["standard", "K", "m/s"],
  ] as const)("maps %s", (units, temp, speed) => {
    expect(unitSymbols(units)).toEqual({ temp, speed });
  });
});

describe("summarize", () => {
  it("produces one line per day plus a header", () => {
    const summary = summarize(toSeries(validFixture(), "metric", 2));
    const lines = summary.split("\n");
    expect(lines[0]).toContain("Halifax, CA");
    // 2 days of data spans 3 local day buckets given the +2 offset, so assert
    // structure rather than an exact count.
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(summary).toContain("°C");
    expect(summary).toContain("precipitation chance up to");
  });

  it("uses the unit symbol matching the series", () => {
    expect(summarize(toSeries(validFixture(), "imperial", 1))).toContain("°F");
  });
});

describe("resolveLocation", () => {
  it("returns the first geocoding match", async () => {
    const place = await resolveLocation("Halifax");
    expect(place.name).toBe("Halifax");
    expect(place.lat).toBeCloseTo(44.6488);
  });

  it("gives an actionable error when the geocoder returns no match", async () => {
    respondWithGeocodeBody([]);
    await expect(resolveLocation("Nowheresville")).rejects.toThrow(/No location found/i);
  });

  it("rejects an empty query without making a request", async () => {
    await expect(resolveLocation("   ")).rejects.toThrow(/must not be empty/i);
  });
});

describe("fetchForecast", () => {
  const coords = { lat: 44.6488, lon: -63.5752, units: "metric" as const };

  it("returns a validated payload", async () => {
    const forecast = await fetchForecast(coords);
    expect(forecast.list).toHaveLength(40);
  });

  it("surfaces a schema mismatch with the offending field path", async () => {
    respondWithForecastBody({ list: [{ dt: 1 }], city: FORECAST_RESPONSE.city });
    await expect(fetchForecast(coords)).rejects.toThrow(/did not match the expected shape at/i);
  });

  it("distinguishes a network failure from an API rejection", async () => {
    respondWithNetworkError();
    await expect(fetchForecast(coords)).rejects.toThrow(/could not reach openweather/i);
  });
});

describe("error mapping", () => {
  const coords = { lat: 1, lon: 2, units: "metric" as const };

  it("maps 401 to a message naming the env var", async () => {
    respondWithStatus(401);
    await expect(fetchForecast(coords)).rejects.toThrow(/OPENWEATHER_API_KEY/);
  });

  it("maps 404 to not-found", async () => {
    respondWithStatus(404);
    await expect(fetchForecast(coords)).rejects.toThrow(/could not find/i);
  });

  it("maps 429 to a rate-limit message", async () => {
    respondWithStatus(429);
    await expect(fetchForecast(coords)).rejects.toThrow(/rate limit/i);
  });

  it("maps an unexpected status to a generic message carrying the code", async () => {
    respondWithStatus(503);
    await expect(fetchForecast(coords)).rejects.toThrow(/HTTP 503/);
  });

  it("records the status on the error", async () => {
    respondWithStatus(500);
    await expect(fetchForecast(coords)).rejects.toMatchObject({
      name: "OpenWeatherError",
      status: 500,
    });
  });

  // Policy: never leak credentials in anything a caller can see.
  it.each([401, 404, 429, 500])("never leaks the API key in a %s error message", async (status) => {
    const secret = "super-secret-key-value";
    vi.stubEnv("OPENWEATHER_API_KEY", secret);
    respondWithStatus(status);

    await expect(fetchForecast(coords)).rejects.toSatisfy((error: unknown) => {
      const err = error as OpenWeatherError;
      expect(err.message).not.toContain(secret);
      return true;
    });

    vi.unstubAllEnvs();
  });
});

describe("missing API key", () => {
  it("fails fast with a descriptive error", async () => {
    vi.stubEnv("OPENWEATHER_API_KEY", "");
    await expect(resolveLocation("Halifax")).rejects.toThrow(/OPENWEATHER_API_KEY is not set/);
    vi.unstubAllEnvs();
  });

  it("throws before any network request is attempted", async () => {
    vi.stubEnv("OPENWEATHER_API_KEY", "");
    // MSW is configured with onUnhandledRequest: "error", but more directly:
    // the thrown error must be about configuration, not connectivity.
    await expect(fetchForecast({ lat: 1, lon: 2, units: "metric" })).rejects.toThrow(
      /not set/i,
    );
    vi.unstubAllEnvs();
  });
});
