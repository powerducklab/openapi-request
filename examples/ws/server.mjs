// Minimal echo WebSocket server for the ws example and tests.
import { WebSocketServer } from "ws";

const port = Number(process.env.PORT ?? 4200);
const wss = new WebSocketServer({ host: "127.0.0.1", port });

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const text = raw.toString();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
    socket.send(
      JSON.stringify({
        echo: true,
        ...payload,
        serverAt: Date.now(),
      }),
    );
  });
});

console.log(`ws server listening on ws://127.0.0.1:${port}`);
