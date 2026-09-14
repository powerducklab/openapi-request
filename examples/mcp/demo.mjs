// MCP demo over Streamable HTTP: discover capabilities, write them into an
// OpenAPI document, send a tools/call through createClient, and open a
// manual session for a long-lived duplex flow.
//
//   node examples/mcp/demo.mjs
//   (start examples/mcp/server.mjs first)
import { createClient, createManualSession, discoverMcpCapabilities } from "../../dist/index.js";

const endpoint = "http://127.0.0.1:4400";

// --- 1. discovery ------------------------------------------------
const { capabilities } = await discoverMcpCapabilities(endpoint);
console.log("capabilities:", capabilities.map((c) => `${c.kind}:${c.name}`).join(", "));

// --- 2. write into OpenAPI + one-shot call -----------------------
const { writeMcpOperations, generateAllMcpCalls } = await import("../../dist/index.js");
const calls = generateAllMcpCalls(capabilities);
const spec = writeMcpOperations(
  { openapi: "3.2.0", info: { title: "mcp-demo", version: "1.0.0" }, paths: {} },
  endpoint,
  calls,
);

const target = { path: "/mcp/tools/echo", method: "post" };
const client = createClient();
const prepared = client.prepare({ spec, target });
console.log("prepare:", prepared.display.mode, prepared.stream.kind);

const result = await client.send({
  spec,
  target,
  mcp: { arguments: { text: "over-http", n: 7 } },
});
console.log("tools/call response:", JSON.stringify(result.response.body));

// --- 3. manual duplex session ------------------------------------
const session = createManualSession({ kind: "mcp", endpoint });
await session.open();
console.log("mcp session:", session.state, session.serverInfo?.name, session.sessionId);
const tools = await session.listTools();
console.log("manual tools:", tools.items.map((t) => t.name).join(", "));
const reply = await session.callTool({ name: "add", arguments: { a: 2, b: 3 } });
console.log("manual call:", JSON.stringify(reply));
await session.close();
console.log("final state:", session.state, "| events:", session.events.length);
