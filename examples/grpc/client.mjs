// gRPC client: exercise all four RPC modes through one manual session each,
// showing how the unified event DTO surfaces status/meta for every mode.
//
//   node examples/grpc/client.mjs
//   (start examples/grpc/server.mjs first)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createManualSession } from "../../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const protoDir = path.join(__dirname, "proto");

const base = {
  address: "127.0.0.1:4500",
  protoPaths: [path.join(protoDir, "echo", "echo.proto")],
  includeDirs: [protoDir],
};

const modes = [
  { method: "UnaryEcho", message: { text: "one", count: 1 } },
  { method: "ServerStreamEcho", message: { text: "stream", count: 4 } },
  { method: "ClientStreamEcho", message: { text: "a" } },
  { method: "BidiStreamEcho", message: { text: "x", count: 1 } },
];

for (const { method, message } of modes) {
  const session = createManualSession({
    kind: "grpc",
    ...base,
    service: "echo.Echo",
    method,
  });

  session.onEvent((event) => {
    if (event.direction === "in" || event.kind === "status") {
      console.log(`  [${method}] ${event.direction}/${event.kind}`, event.data ?? event.meta ?? {});
    }
  });

  await session.open();
  await session.send(message);
  // Client-streaming and bidi need a second message batch to exercise writes.
  if (method === "ClientStreamEcho") await session.send({ text: "b" });
  if (method === "BidiStreamEcho") await session.send({ text: "y", count: 2 });
  await session.close();
  console.log(`${method}: final=${session.state}`);
}
