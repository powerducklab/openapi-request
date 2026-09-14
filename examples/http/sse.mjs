// Standalone SSE incremental delivery test.
// Starts the example SSE server (1 event / 120ms), calls client.send() with
// onEvent, and prints the arrival timestamps. If streaming works, the gaps
// between onEvent calls should be ~120ms. If buffered, all timestamps cluster
// at the end.
import { spawn } from "node:child_process";
import { createClient } from "../../dist/index.js";

const PORT = 4199;
const SPEC = {
  openapi: "3.2.0",
  info: { title: "sse-test", version: "1.0.0" },
  servers: [{ url: `http://127.0.0.1:${PORT}` }],
  paths: {
    "/sse": {
      get: {
        operationId: "getSse",
        responses: {
          "200": {
            description: "ok",
            content: { "text/event-stream": {} },
          },
        },
      },
    },
  },
};

function log(label, ...args) {
  const t = (performance.now() / 1000).toFixed(3);
  console.log(`[${t}s] ${label}`, ...args);
}

async function main() {
  log("boot", "starting SSE fixture server");
  const server = spawn("node", ["server.mjs"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve) => {
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) resolve();
    });
    setTimeout(resolve, 2000);
  });
  log("boot", "server ready");

  const client = createClient();
  const arrivals = [];
  const startAt = performance.now();

  log("send", "calling client.send() with onEvent");
  const result = await client.send({
    spec: SPEC,
    target: { path: "/sse", method: "get" },
    maxStreamMs: 10000,
    onResponseStart: (info) => {
      log("responseStart", `streaming=${info.streaming} contentType=${info.contentType}`);
    },
    onEvent: (event) => {
      const elapsed = performance.now() - startAt;
      arrivals.push({ elapsed, event: event.event, data: event.data });
      log(
        "onEvent",
        `+${elapsed.toFixed(0)}ms  event=${event.event ?? "?"}  data=${JSON.stringify(event.data).slice(0, 60)}`,
      );
    },
  });

  log("send", `resolved. streaming=${result.response.streaming} eventsInResult=${result.response.body?.total ?? "n/a"}`);

  console.log("\n=== arrival timeline ===");
  if (arrivals.length === 0) {
    console.log("NO onEvent calls were made!");
  } else {
    for (let i = 0; i < arrivals.length; i++) {
      const prev = i > 0 ? arrivals[i - 1].elapsed : 0;
      const gap = arrivals[i].elapsed - prev;
      console.log(
        `  #${i + 1}  +${arrivals[i].elapsed.toFixed(0)}ms  (gap ${gap.toFixed(0)}ms)  ${arrivals[i].event}`,
      );
    }
    const firstGap = arrivals.length > 1 ? arrivals[1].elapsed - arrivals[0].elapsed : 0;
    console.log(
      `\nverdict: ${firstGap > 50 ? "INCREMENTAL (gaps > 50ms)" : "BUFFERED (all events arrived together)"}`,
    );
  }

  server.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
