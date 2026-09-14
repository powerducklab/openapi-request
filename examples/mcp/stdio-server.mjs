// MCP stdio server entry point. Forces stdio transport regardless of env, so
// tests can spawn it as a child process without setting MCP_TRANSPORT.
process.env.MCP_TRANSPORT = "stdio";
await import("./server.mjs");
