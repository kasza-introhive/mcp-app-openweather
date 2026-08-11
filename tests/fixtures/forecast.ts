/**
 * @file Synthetic OpenWeather payloads. Hand-written, not captured from a live
 * account -- no real user or production data.
 *
 * The timezone is deliberately NON-ZERO (+7200 = UTC+2) so that a bug where
 * timestamps are formatted in UTC instead of the location's local time cannot
 * hide behind a zero offset.
 */

export const TIMEZONE_OFFSET_SECONDS = 7200; // UTC+2

/** 2026-08-11T00:00:00Z (a Tuesday) -> 02:00 local at UTC+2. */
const BASE_DT = 1786406400;

const THREE_HOURS = 3 * 60 * 60;

interface EntryOverrides {
  temp?: number;
  feels_like?: number;
  humidity?: number;
  pressure?: number;
  windSpeed?: number;
  clouds?: number;
  pop?: number;
  rain?: number;
  snow?: number;
  condition?: string;
  description?: string;
  icon?: string;
}

function entry(index: number, overrides: EntryOverrides = {}) {
  const dt = BASE_DT + index * THREE_HOURS;
  const base = {
    dt,
    dt_txt: new Date(dt * 1000).toISOString().replace("T", " ").slice(0, 19),
    main: {
      temp: overrides.temp ?? 15 + (index % 8),
      feels_like: overrides.feels_like ?? 14 + (index % 8),
      humidity: overrides.humidity ?? 60 + (index % 10),
      pressure: overrides.pressure ?? 1012,
      // Extra fields the schema ignores -- proves additive upstream changes
      // don't break parsing.
      temp_min: 12,
      temp_max: 20,
      sea_level: 1012,
      grnd_level: 1004,
      temp_kf: 0,
    },
    weather: [
      {
        id: 500,
        main: overrides.condition ?? "Clouds",
        description: overrides.description ?? "scattered clouds",
        icon: overrides.icon ?? "03d",
      },
    ],
    clouds: { all: overrides.clouds ?? 40 },
    wind: { speed: overrides.windSpeed ?? 3.5, deg: 210, gust: 6.1 },
    visibility: 10000,
    pop: overrides.pop ?? 0.2,
    sys: { pod: "d" },
    ...(overrides.rain !== undefined ? { rain: { "3h": overrides.rain } } : {}),
    ...(overrides.snow !== undefined ? { snow: { "3h": overrides.snow } } : {}),
  };
  return base;
}

/** 40 entries = the full 5 days at 3-hour steps, as the real API returns. */
export function makeForecastResponse(count = 40) {
  return {
    cod: "200",
    message: 0,
    cnt: count,
    list: Array.from({ length: count }, (_, i) =>
      // Give a couple of entries rain/snow so the "absent -> 0" case and the
      // "present" case are both covered.
      i === 1 ? entry(i, { rain: 1.25, pop: 0.85 }) : i === 2 ? entry(i, { snow: 0.4 }) : entry(i),
    ),
    city: {
      id: 6324729,
      name: "Halifax",
      coord: { lat: 44.6488, lon: -63.5752 },
      country: "CA",
      population: 390096,
      timezone: TIMEZONE_OFFSET_SECONDS,
      sunrise: BASE_DT + 21600,
      sunset: BASE_DT + 72000,
    },
  };
}

export const FORECAST_RESPONSE = makeForecastResponse();

export const GEOCODE_RESPONSE = [
  {
    name: "Halifax",
    local_names: { en: "Halifax" },
    lat: 44.6488,
    lon: -63.5752,
    country: "CA",
    state: "Nova Scotia",
  },
];
