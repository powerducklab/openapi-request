import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

function buildServer() {
  const server = new McpServer({ name: "protokit-demo-mcp", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echo the given text back verbatim.",
      inputSchema: { text: z.string().describe("Text to echo") },
    },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  server.registerTool(
    "add",
    {
      title: "Add",
      description: "Add two numbers.",
      inputSchema: { a: z.number(), b: z.number() },
    },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
  );
  server.registerTool(
    "get_weather",
    {
      title: "Get weather",
      description:
        "Fake weather lookup for a city (demo data, not a real API).",
      inputSchema: { city: z.string() },
    },
    async ({ city }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ city, tempC: 18, condition: "cloudy" }),
        },
      ],
    }),
  );
  server.registerResource(
    "config",
    "config://app",
    {
      title: "App config",
      description: "Static demo configuration.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: "demo-mode=true\nregion=local" }],
    }),
  );
  server.registerPrompt(
    "summarize",
    {
      title: "Summarize",
      description: "Ask the model to summarize a piece of text.",
      argsSchema: { text: z.string() },
    },
    ({ text }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Summarize the following in one sentence:\n\n${text}`,
          },
        },
      ],
    }),
  );
  return server;
}

async function startHttpMode() {
  const sessions = new Map();
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method !== "POST" || url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error" },
            id: null,
          }),
        );
        return;
      }
      try {
        const sessionId = req.headers["mcp-session-id"];
        let transport = sessionId ? sessions.get(sessionId) : undefined;
        if (!transport && body && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => sessions.set(id, transport),
          });
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          await buildServer().connect(transport);
        }
        if (!transport) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "No active session; send initialize first.",
              },
              id: body?.id ?? null,
            }),
          );
          return;
        }
        await transport.handleRequest(req, res, body);
      } catch (e) {
        console.error("[mcp] request failed:", e);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal error" },
              id: null,
            }),
          );
        }
      }
    });
  });
  const port = process.env.PORT ?? 4200;
  httpServer.listen(port, () =>
    console.error(`[mcp http] listening on http://127.0.0.1:${port}/mcp`),
  );
}

async function startStdioMode() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp stdio] server ready");
}

// 启动判断逻辑
(async function main() {
  const mode = process.env.MCP_TRANSPORT ?? "stdio";
  if (mode === "http") {
    await startHttpMode();
  } else {
    await startStdioMode();
  }
})().catch((err) => {
  console.error("mcp server fatal error", err);
  process.exit(1);
});