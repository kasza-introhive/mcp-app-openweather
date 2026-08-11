/**
 * @file Integration tests at the MCP boundary.
 *
 * Drives the real `createServer()` through an in-memory transport pair, exactly
 * as a host would: `tools/list`, `tools/call`, `resources/read`. No HTTP, no
 * stdio -- the protocol surface is what's under test.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createServer, RESOURCE_URI, TOOL_NAME } from "../../server.ts";
import type { ForecastSeries } from "../../src/openweather.ts";
import { respondWithStatus } from "../msw/handlers.ts";

const BUNDLE_PATH = path.join(process.cwd(), "dist", "mcp-app.html");
const bundleExists = fs.existsSync(BUNDLE_PATH);

/** Connect a client to a fresh server over a linked transport pair. */
async function connect(): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    createServer().connect(serverTransport),
  ]);
  return client;
}

let client: Client;

beforeEach(async () => {
  client = await connect();
});

describe("tools/list", () => {
  it("exposes get-forecast", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain(TOOL_NAME);
  });

  /*
   * The single most important assertion in this file.
   *
   * Without `_meta.ui.resourceUri` the host has no idea a UI exists and the
   * tool silently degrades to plain text -- a failure that is easy to introduce
   * and invisible without a test.
   */
  it("carries the UI resource URI in tool metadata", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === TOOL_NAME);
    expect(tool).toBeDefined();

    const meta = tool!._meta as { ui?: { resourceUri?: string } } | undefined;
    expect(meta?.ui?.resourceUri).toBe(RESOURCE_URI);
  });

  it("declares the input schema the UI relies on", async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === TOOL_NAME)!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["location", "units", "days"]),
    );
    expect(schema.required).toContain("location");
  });
});

describe("resources/list", () => {
  it("advertises the ui:// resource with the app mime type", async () => {
    const { resources } = await client.listResources();
    const resource = resources.find((r) => r.uri === RESOURCE_URI);
    expect(resource).toBeDefined();
    expect(resource!.mimeType).toContain("html");
  });

  it("declares the CSP domain needed for weather icons", async () => {
    const { resources } = await client.listResources();
    const meta = resources.find((r) => r.uri === RESOURCE_URI)!._meta as
      | { ui?: { csp?: { resourceDomains?: string[] } } }
      | undefined;
    expect(meta?.ui?.csp?.resourceDomains).toContain("https://openweathermap.org");
  });
});

// Skipped rather than failing when `dist/` is absent -- run `npm run build`
// first to exercise these.
describe.skipIf(!bundleExists)("resources/read (requires npm run build)", () => {
  it("serves the bundled HTML", async () => {
    const result = await client.readResource({ uri: RESOURCE_URI });
    // `contents[]` is a text-or-blob union; a UI resource must be the text arm.
    const [content] = result.contents as { uri: string; mimeType?: string; text?: string }[];
    expect(content!.uri).toBe(RESOURCE_URI);
    expect(content!.mimeType).toContain("html");
    expect(content!.text).toContain("<!doctype html>");
    expect(content!.text!.length).toBeGreaterThan(1000);
  });
});

describe("tools/call get-forecast", () => {
  it("returns a text summary for the model and structured data for the chart", async () => {
    const result = await client.callTool({
      name: TOOL_NAME,
      arguments: { location: "Halifax,CA", units: "metric", days: 5 },
    });

    expect(result.isError).toBeFalsy();

    // Text content: what the model reads.
    const content = result.content as { type: string; text?: string }[];
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toContain("Halifax, CA");

    // Structured content: what the UI renders.
    const series = result.structuredContent as unknown as ForecastSeries;
    expect(series.points).toHaveLength(40);
    expect(series.units).toBe("metric");
    expect(series.location.name).toBe("Halifax");
    expect(series.points[0]).toMatchObject({
      label: expect.any(String),
      temp: expect.any(Number),
      pop: expect.any(Number),
    });
  });

  it("honours the days argument", async () => {
    const result = await client.callTool({
      name: TOOL_NAME,
      arguments: { location: "Halifax,CA", days: 1 },
    });
    const series = result.structuredContent as unknown as ForecastSeries;
    expect(series.points).toHaveLength(8);
  });

  it("defaults units to metric and days to 5 when omitted", async () => {
    const result = await client.callTool({
      name: TOOL_NAME,
      arguments: { location: "Halifax,CA" },
    });
    const series = result.structuredContent as unknown as ForecastSeries;
    expect(series.units).toBe("metric");
    expect(series.points).toHaveLength(40);
  });

  it.each([
    ["unknown units", { location: "Halifax", units: "furlongs" }],
    ["days above the maximum", { location: "Halifax", days: 9 }],
    ["days below the minimum", { location: "Halifax", days: 0 }],
    ["empty location", { location: "" }],
  ])("rejects %s", async (_label, args) => {
    const result = await client.callTool({ name: TOOL_NAME, arguments: args });
    expect(result.isError).toBe(true);
  });

  it("reports an upstream API failure as a tool error", async () => {
    respondWithStatus(401);
    const result = await client.callTool({
      name: TOOL_NAME,
      arguments: { location: "Halifax,CA" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as { text?: string }[];
    expect(content[0]!.text).toMatch(/OPENWEATHER_API_KEY/);
  });
});
