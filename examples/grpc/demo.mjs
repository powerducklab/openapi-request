// gRPC demo: discover the schema from proto files, write operations into an
// OpenAPI document, send a unary call through createClient and write the
// response back. Then open a manual session and drive all four RPC modes.
//
//   node examples/grpc/demo.mjs
//   (start examples/grpc/server.mjs first)
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createClient,
  createManualSession,
  discoverAndWriteGrpcOperations,
} from "../../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const protoDir = path.join(__dirname, "proto");

const endpoint = {
  address: "127.0.0.1:4500",
  protoPaths: [path.join(protoDir, "echo", "echo.proto")],
  includeDirs: [protoDir],
};

const spec = {
  openapi: "3.2.0",
  info: { title: "grpc-demo", version: "1.0.0" },
  servers: [{ url: "http://127.0.0.1:4500" }],
  paths: {},
};

const { spec: withOps, discovery } = await discoverAndWriteGrpcOperations(
  spec,
  endpoint,
);
console.log("discovered methods:", discovery.services[0].methods.map((m) => m.name).join(", "));

const client = createClient();

// --- 1. one-shot unary via OpenAPI --------------------------------
const target = { path: "/grpc/echo/Echo/UnaryEcho", method: "post" };
const prepared = client.prepare({ spec: withOps, target });
console.log("prepare:", prepared.display.mode, prepared.stream.kind);

const result = await client.send({
  spec: withOps,
  target,
  grpc: { messages: [{ text: "unary", count: 1 }] }, // adapter expects the envelope
});
console.log("unary response:", JSON.stringify(result.response.body));
const patched = client.writeback(withOps, prepared, result);
console.log("writeback status keys:", Object.keys(patched.paths[target.path].post.responses ?? {}).join(", "));

// --- 2. manual session, all four modes ----------------------------
const session = createManualSession({
  kind: "grpc",
  address: "127.0.0.1:4500",
  protoPaths: [path.join(protoDir, "echo", "echo.proto")],
  includeDirs: [protoDir],
  service: "echo.Echo",
  method: "UnaryEcho",
});
await session.open();
console.log("grpc session:", session.state, "kind=", session.kind, "source=", session.source);

await session.send({ text: "manual-unary" }); // manual sessions take the raw message
await session.close();

console.log("final state:", session.state, "| events:", session.events.length);
