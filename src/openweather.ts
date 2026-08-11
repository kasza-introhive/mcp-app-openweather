/**
 * @file The only module that talks to OpenWeather.
 *
 * Everything crossing this trust boundary is validated with zod before use --
 * we never index into an unvalidated upstream payload.
 *
 * Uses the FREE 5 day / 3 hour forecast endpoint. Note that OpenWeather's
 * *historical* endpoints (One Call 3.0 `timemachine` / `day_summary`) require a
 * separate paid "One Call by Call" subscription and return 401 on a free-tier
 * key -- which is why this app visualizes forecast data instead.
 */
import { z } from "zod";

const GEOCODE_URL = "https://api.openweathermap.org/geo/1.0/direct";
const FORECAST_URL = "https://api.openweathermap.org/data/2.5/forecast";

/** OpenWeather serves condition icons from here; mirrored in the resource CSP. */
export const ICON_BASE_URL = "https://openweathermap.org/img/wn";

export const UNITS = ["metric", "imperial", "standard"] as const;
export type Units = (typeof UNITS)[number];

/** Forecast rows arrive in 3-hour steps, so a day is 8 entries. */
const STEPS_PER_DAY = 8;

// --- Schemas -----------------------------------------------------------------
// Only the fields actually used are declared. Unknown keys are ignored rather
// than rejected, so an additive upstream change won't break the app.

const GeocodeResultSchema = z.object({
  name: z.string(),
  lat: z.number(),
  lon: z.number(),
  country: z.string(),
  state: z.string().optional(),
});

export const GeocodeResponseSchema = z.array(GeocodeResultSchema);

const ForecastEntrySchema = z.object({
  dt: z.number(),
  dt_txt: z.string(),
  main: z.object({
    temp: z.number(),
    feels_like: z.number(),
    humidity: z.number(),
    pressure: z.number(),
  }),
  weather: z
    .array(
      z.object({
        id: z.number(),
        main: z.string(),
        description: z.string(),
        icon: z.string(),
      }),
    )
    .min(1, "forecast entry has no weather description"),
  wind: z.object({ speed: z.number() }),
  clouds: z.object({ all: z.number() }),
  pop: z.number(),
  rain: z.object({ "3h": z.number() }).optional(),
  snow: z.object({ "3h": z.number() }).optional(),
});

export const ForecastResponseSchema = z.object({
  // An empty list means we'd render a blank chart -- treat it as a failure.
  list: z.array(ForecastEntrySchema).min(1, "forecast contained no data points"),
  city: z.object({
    name: z.string(),
    country: z.string(),
    // Shift from UTC in seconds. Used to label points in *local* time.
    timezone: z.number(),
    coord: z.object({ lat: z.number(), lon: z.number() }),
  }),
});

export type ForecastResponse = z.infer<typeof ForecastResponseSchema>;
export type Location = z.infer<typeof GeocodeResultSchema>;

// --- Public types ------------------------------------------------------------

export interface ForecastPoint {
  /** Unix seconds, UTC. */
  dt: number;
  /** Local-time label at the forecast location, e.g. "Mon 14:00". */
  label: string;
  /** ISO-ish local day key, e.g. "2026-08-11". */
  day: string;
  temp: number;
  feelsLike: number;
  humidity: number;
  pressure: number;
  windSpeed: number;
  clouds: number;
  /** Probability of precipitation as a percentage (0-100). */
  pop: number;
  /** Millimetres in the 3h window; 0 when absent. */
  rain: number;
  snow: number;
  condition: string;
  description: string;
  icon: string;
}

export interface ForecastSeries {
  location: { name: string; country: string; lat: number; lon: number };
  units: Units;
  timezoneOffsetSeconds: number;
  points: ForecastPoint[];
}

// --- Errors ------------------------------------------------------------------

/**
 * Error carrying a message that is safe to return to a caller: it never
 * includes the API key or the raw upstream body.
 */
export class OpenWeatherError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenWeatherError";
  }
}

/**
 * Maps an HTTP status to an actionable message.
 *
 * Deliberately does not interpolate the response body, which can echo the
 * `appid` query parameter back to us.
 */
function describeHttpFailure(status: number, what: string): OpenWeatherError {
  switch (status) {
    case 401:
      return new OpenWeatherError(
        "OpenWeather rejected the API key (401). Check OPENWEATHER_API_KEY in .env. " +
          "Note that a newly created key can take ~10 minutes to activate.",
        status,
      );
    case 404:
      return new OpenWeatherError(`OpenWeather could not find the requested ${what} (404).`, status);
    case 429:
      return new OpenWeatherError(
        "OpenWeather rate limit exceeded (429). Wait a moment before retrying.",
        status,
      );
    default:
      return new OpenWeatherError(
        `OpenWeather request for ${what} failed with HTTP ${status}.`,
        status,
      );
  }
}

// --- API key -----------------------------------------------------------------

/**
 * Read the key at call time rather than module load.
 *
 * This still fails fast -- the first request throws a descriptive error -- but
 * it keeps the module importable by tests that never make a request.
 */
function requireApiKey(): string {
  const key = process.env.OPENWEATHER_API_KEY?.trim();
  if (!key) {
    throw new OpenWeatherError(
      "OPENWEATHER_API_KEY is not set. Copy .env.example to .env and add your " +
        "free OpenWeather API key (https://openweathermap.org/api).",
    );
  }
  return key;
}

// --- Requests ----------------------------------------------------------------

async function getJson(url: URL, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    // Network-level failure (DNS, offline, blocked egress). Surface it as
    // distinct from an API rejection so callers aren't misled into thinking the
    // key is bad.
    throw new OpenWeatherError(
      `Could not reach OpenWeather while fetching ${what}. Check network connectivity.`,
    );
  }

  if (!response.ok) {
    throw describeHttpFailure(response.status, what);
  }

  try {
    return await response.json();
  } catch {
    throw new OpenWeatherError(`OpenWeather returned a malformed JSON response for ${what}.`);
  }
}

/** Turn a zod failure into a message that points at the offending field. */
function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const [first] = result.error.issues;
    const path = first?.path.join(".") || "(root)";
    throw new OpenWeatherError(
      `OpenWeather ${what} response did not match the expected shape at "${path}": ${first?.message}`,
    );
  }
  return result.data;
}

/** Resolve a free-text place name to coordinates. */
export async function resolveLocation(query: string): Promise<Location> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new OpenWeatherError("Location must not be empty.");
  }

  const url = new URL(GEOCODE_URL);
  url.searchParams.set("q", trimmed);
  url.searchParams.set("limit", "1");
  url.searchParams.set("appid", requireApiKey());

  const results = parseOrThrow(GeocodeResponseSchema, await getJson(url, "location"), "geocoding");

  // The geocoder returns [] for unknown places rather than a 404, so guard
  // before indexing.
  const first = results[0];
  if (!first) {
    throw new OpenWeatherError(`No location found matching "${trimmed}". Try adding a country code, e.g. "Halifax,CA".`);
  }
  return first;
}

/** Fetch the raw 5-day/3-hour forecast for a coordinate. */
export async function fetchForecast(params: {
  lat: number;
  lon: number;
  units: Units;
}): Promise<ForecastResponse> {
  const url = new URL(FORECAST_URL);
  url.searchParams.set("lat", String(params.lat));
  url.searchParams.set("lon", String(params.lon));
  url.searchParams.set("units", params.units);
  url.searchParams.set("appid", requireApiKey());

  return parseOrThrow(ForecastResponseSchema, await getJson(url, "forecast"), "forecast");
}

// --- Transform ---------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Format a UTC instant in the *forecast location's* local time.
 *
 * Done arithmetically via `timezone` (seconds from UTC) rather than with the
 * host's locale, so output does not depend on where this code runs.
 */
function formatLocal(dtSeconds: number, offsetSeconds: number) {
  const local = new Date((dtSeconds + offsetSeconds) * 1000);
  return {
    label: `${WEEKDAYS[local.getUTCDay()]} ${pad(local.getUTCHours())}:00`,
    day: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
  };
}

/**
 * Flatten a validated forecast into chart-ready rows.
 *
 * @param days Clamp the result to the first N days (1-5) of 3-hour steps.
 */
export function toSeries(response: ForecastResponse, units: Units, days = 5): ForecastSeries {
  const limit = Math.max(1, Math.min(5, Math.trunc(days))) * STEPS_PER_DAY;

  const points: ForecastPoint[] = response.list.slice(0, limit).map((entry) => {
    const { label, day } = formatLocal(entry.dt, response.city.timezone);
    // `weather` is schema-guaranteed non-empty.
    const weather = entry.weather[0]!;
    return {
      dt: entry.dt,
      label,
      day,
      temp: entry.main.temp,
      feelsLike: entry.main.feels_like,
      humidity: entry.main.humidity,
      pressure: entry.main.pressure,
      windSpeed: entry.wind.speed,
      clouds: entry.clouds.all,
      // Upstream gives 0-1; charts read better as a percentage.
      pop: Math.round(entry.pop * 100),
      // Absent rain/snow means "none", not "unknown".
      rain: entry.rain?.["3h"] ?? 0,
      snow: entry.snow?.["3h"] ?? 0,
      condition: weather.main,
      description: weather.description,
      icon: weather.icon,
    };
  });

  return {
    location: {
      name: response.city.name,
      country: response.city.country,
      lat: response.city.coord.lat,
      lon: response.city.coord.lon,
    },
    units,
    timezoneOffsetSeconds: response.city.timezone,
    points,
  };
}

/** Symbols for each unit system, used in labels and the text summary. */
export function unitSymbols(units: Units): { temp: string; speed: string } {
  switch (units) {
    case "metric":
      return { temp: "°C", speed: "m/s" };
    case "imperial":
      return { temp: "°F", speed: "mph" };
    case "standard":
      return { temp: "K", speed: "m/s" };
  }
}

/**
 * One-line-per-day text summary for the *model* to read.
 *
 * The chart consumes `structuredContent` instead; this keeps the token cost of
 * a tool call low while still giving the model something to reason about.
 */
export function summarize(series: ForecastSeries): string {
  const { temp } = unitSymbols(series.units);
  const byDay = new Map<string, ForecastPoint[]>();
  for (const point of series.points) {
    const bucket = byDay.get(point.day);
    if (bucket) bucket.push(point);
    else byDay.set(point.day, [point]);
  }

  const lines = [...byDay.entries()].map(([day, points]) => {
    const temps = points.map((p) => p.temp);
    const min = Math.min(...temps).toFixed(1);
    const max = Math.max(...temps).toFixed(1);
    const maxPop = Math.max(...points.map((p) => p.pop));
    // Most frequent condition of the day reads better than an arbitrary one.
    const counts = new Map<string, number>();
    for (const p of points) counts.set(p.condition, (counts.get(p.condition) ?? 0) + 1);
    const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Unknown";
    return `${day}: ${min}-${max}${temp}, ${dominant.toLowerCase()}, precipitation chance up to ${maxPop}%`;
  });

  const { name, country } = series.location;
  return [`${series.points.length}-point forecast for ${name}, ${country}:`, ...lines].join("\n");
}
