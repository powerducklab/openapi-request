// WebSocket demo: a long-lived duplex session driven through the unified
// manual session API. Every message arrives as a SessionEventDTO so one
// renderer serves ws, mcp and grpc alike.
//
//   node examples/ws/demo.mjs
//   (start examples/ws/server.mjs first)
import { createManualSession } from "../../dist/index.js";

const session = createManualSession({
  kind: "websocket",
  url: "ws://127.0.0.1:4200",
});

session.onEvent((event) => {
  console.log(
    `[${event.direction}/${event.kind}] state=${event.state} meta=${JSON.stringify(event.meta ?? {})}`,
  );
  if (event.kind === "text") {
    console.log("  payload:", event.data);
  }
});

await session.open();
await session.send({ text: "ping", n: 1 });
await session.send({ text: "ping-2", n: 2 });

// Give the echo server a moment to reply, then close cleanly.
await new Promise((resolve) => setTimeout(resolve, 150));
await session.close({ code: 1000, reason: "demo done" });

console.log("final state:", session.state, "| events:", session.events.length);
