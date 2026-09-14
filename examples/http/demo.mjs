// HTTP demo: decide the renderer BEFORE sending (prepare), then send and
// write the response back into the OpenAPI document.
//
//   node examples/http/demo.mjs
//   (start examples/http/server.mjs first)
import { createClient } from "../../dist/index.js";

// A minimal OpenAPI 3.x document. The /sse operation does NOT declare any
// x-* extension: streaming is inferred from the responses content-type.
const spec = {
  openapi: "3.2.0",
  info: { title: "http-demo", version: "1.0.0" },
  servers: [{ url: "http://127.0.0.1:4100" }],
  paths: {
    "/json": {
      get: {
        operationId: "getJson",
        responses: {
          "200": { description: "plain json", content: { "application/json": {} } },
        },
      },
    },
    "/sse": {
      get: {
        operationId: "getSse",
        responses: {
          "200": {
            description: "server events",
            content: { "text/event-stream": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
};

const client = createClient();

for (const target of [
  { path: "/json", method: "get" },
  { path: "/sse", method: "get" },
]) {
  const prepared = client.prepare({ spec, target });

  console.log(
    `${target.path}: display=${prepared.display.mode} stream=${prepared.stream.kind}`,
  );

  // UI would now pick event-list vs plain response box.
  const result = await client.send({ spec, target });
  console.log("  response:", JSON.stringify(result.response.body));

  const patched = client.writeback(spec, prepared, result);
  console.log(
    "  writeback:",
    JSON.stringify(patched.paths[target.path].get.responses["200"]?.content ?? {}),
  );
}
