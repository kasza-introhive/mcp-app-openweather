/**
 * @file MSW handlers shared by the unit and server suites.
 *
 * Intercepting at the network layer means `src/openweather.ts` is exercised
 * exactly as it ships -- no injected seams, no production code aware of tests.
 */
import { http, HttpResponse, type JsonBodyType } from "msw";
import { setupServer } from "msw/node";
import { FORECAST_RESPONSE, GEOCODE_RESPONSE } from "../fixtures/forecast.ts";

export const GEOCODE_ENDPOINT = "https://api.openweathermap.org/geo/1.0/direct";
export const FORECAST_ENDPOINT = "https://api.openweathermap.org/data/2.5/forecast";

/** The happy path: valid geocode + valid forecast. */
export const defaultHandlers = [
  http.get(GEOCODE_ENDPOINT, () => HttpResponse.json(GEOCODE_RESPONSE)),
  http.get(FORECAST_ENDPOINT, () => HttpResponse.json(FORECAST_RESPONSE)),
];

export const server = setupServer(...defaultHandlers);

/** Reply to both endpoints with a status code, mimicking an OpenWeather error. */
export function respondWithStatus(status: number) {
  const body = { cod: String(status), message: "simulated failure" };
  server.use(
    http.get(GEOCODE_ENDPOINT, () => HttpResponse.json(body, { status })),
    http.get(FORECAST_ENDPOINT, () => HttpResponse.json(body, { status })),
  );
}

/**
 * Serve an arbitrary (usually malformed) forecast body.
 *
 * `JsonBodyType` is deliberately widened here: the point of these helpers is to
 * send payloads that do NOT match the schema, so the caller passes `unknown`.
 */
export function respondWithForecastBody(body: unknown) {
  server.use(http.get(FORECAST_ENDPOINT, () => HttpResponse.json(body as JsonBodyType)));
}

/** Serve an arbitrary geocode body, e.g. `[]` for "no match". */
export function respondWithGeocodeBody(body: unknown) {
  server.use(http.get(GEOCODE_ENDPOINT, () => HttpResponse.json(body as JsonBodyType)));
}

/** Simulate a transport-level failure rather than an HTTP error status. */
export function respondWithNetworkError() {
  server.use(
    http.get(GEOCODE_ENDPOINT, () => HttpResponse.error()),
    http.get(FORECAST_ENDPOINT, () => HttpResponse.error()),
  );
}
