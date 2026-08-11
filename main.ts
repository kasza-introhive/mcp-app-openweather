/**
 * @file Entry point. Two transports, one flag:
 *
 *   npm run serve         -> Streamable HTTP on :3001 (shareable via a tunnel)
 *   npm run serve:stdio   -> stdio (local, for claude_desktop_config.json)
 *
 * IMPORTANT: under stdio, stdout *is* the JSON-RPC channel. Every diagnostic in
 * this file therefore goes to `console.error`. A stray `console.log` corrupts
 * the protocol stream and the client will fail to initialize.
 */
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { createServer } from "./server.ts";

/**
 * Streamable HTTP in stateless mode: a fresh server + transport per request,
 * torn down when the response closes. Stateless keeps the POC simple and is
 * what a tunnelled dev connector wants.
 */
export async function startStreamableHTTPServer(factory: () => McpServer): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);

  const app = createMcpExpressApp({ host: "0.0.0.0" });
  app.use(cors());

  app.all("/mcp", async (req: Request, res: Response) => {
    const server = factory();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!res.headersSent) {
        // Generic message to the client; detail stays in the server log.
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const httpServer = app.listen(port, (err?: Error) => {
    if (err) {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
    console.error(`MCP server listening on http://localhost:${port}/mcp`);
  });

  const shutdown = () => {
    console.error("Shutting down...");
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export async function startStdioServer(factory: () => McpServer): Promise<void> {
  await factory().connect(new StdioServerTransport());
}

async function main() {
  if (process.argv.includes("--stdio")) {
    await startStdioServer(createServer);
  } else {
    await startStreamableHTTPServer(createServer);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
