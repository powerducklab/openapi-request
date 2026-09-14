// MCP client over stdio: spawn a child MCP server and drive initialize,
// tools/list and tools/call through one manual session. Responses are paired
// with requests by JSON-RPC id, so the session exposes exactly one result
// per call (the stdio stream itself carries many lines — that is normal).
//
//   node examples/mcp/client.mjs
import { createManualSession } from "../../dist/index.js";

const session = createManualSession({
  kind: "mcp",
  transport: "stdio",
  command: process.execPath,
  args: ["examples/mcp/stdio-server.mjs"],
  cwd: process.cwd(),
  timeoutMs: 10_000,
});

session.onEvent((event) => {
  if (event.kind === "jsonrpc") {
    console.log(`[${event.direction}] ${String(event.data).slice(0, 120)}`);
  }
});

await session.open();
console.log("state:", session.state, "server:", session.serverInfo?.name);

const tools = await session.listTools();
console.log("tools:", tools.items.map((t) => t.name).join(", "));

const reply = await session.callTool({ name: "echo", arguments: { text: "over-stdio" } });
console.log("call result:", JSON.stringify(reply));

await session.close();
console.log("final state:", session.state, "| events:", session.events.length);
