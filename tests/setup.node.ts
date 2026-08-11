/**
 * @file Shared setup for the node suites.
 *
 * `onUnhandledRequest: "error"` is deliberate: if a test accidentally reaches a
 * real network endpoint, it fails loudly instead of quietly depending on the
 * internet.
 *
 * The contract suite opts out via `server.close()` in its own beforeAll, since
 * it *is* meant to hit the live API.
 */
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./msw/handlers.ts";

// A dummy key by default, so tests exercise real code paths without a real
// secret. Individual tests override or unset it as needed.
process.env.OPENWEATHER_API_KEY ??= "test-api-key-not-a-real-secret";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
