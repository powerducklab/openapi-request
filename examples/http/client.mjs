// HTTP client: probe the live response headers to classify streaming before
// the UI commits to a renderer (event-list vs plain response box).
//
//   node examples/http/client.mjs
//   (start examples/http/server.mjs first)
import { createClient } from "../../dist/index.js";

const client = createClient();
const endpoint = process.env.ENDPOINT ?? "http://127.0.0.1:4100/sse";

const probe = await client.probeStreamingResponse(endpoint);

console.log("probe:", {
  ok: probe.ok,
  status: probe.status,
  contentType: probe.contentType,
  kind: probe.kind,
});

if (probe.kind === "sse" || probe.kind === "ndjson") {
  console.log("UI decision: render an event list");
} else {
  console.log("UI decision: render a plain response box");
}

// The probe owns the response; consume or cancel it.
await probe.response.body?.cancel?.();
