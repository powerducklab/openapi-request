// Local HTTP + SSE fixture server used by the http examples and tests.
// Endpoints:
//   GET /json    -> single JSON body (plain response)
//   GET /sse     -> text/event-stream, one event per 120ms (4 events)
//   GET /ndjson  -> application/x-ndjson stream (3 lines)
import http from "node:http";

function writeEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/json" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "plain json", at: Date.now() }));
    return;
  }

  if (url.pathname === "/sse" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`retry: 1000\n\n`);
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      writeEvent(res, "tick", { seq: i, at: Date.now() });
      if (i >= 4) {
        clearInterval(timer);
        writeEvent(res, "done", { total: i });
        res.end();
      }
    }, 120);
    req.on("close", () => clearInterval(timer));
    return;
  }

  if (url.pathname === "/ndjson" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    for (let i = 1; i <= 3; i += 1) {
      res.write(`${JSON.stringify({ seq: i, kind: "ndjson" })}\n`);
    }
    res.end();
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const port = Number(process.env.PORT ?? 4100);
server.listen(port, "127.0.0.1", () => {
  console.log(`http server listening on http://127.0.0.1:${port}`);
});
