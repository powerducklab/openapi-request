import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const here = dirname(fileURLToPath(import.meta.url));
const protoRoot = join(here, "proto");

const packageDefinition = await protoLoader.load(
  [
    join(protoRoot, "echo", "echo.proto"),
    join(protoRoot, "common", "types.proto"),
  ],
  {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [protoRoot],
  },
);
const loaded = grpc.loadPackageDefinition(packageDefinition);

const meta = () => ({
  trace_id: `srv-${Date.now()}`,
  timestamp_ms: String(Date.now()),
});

const impl = {
  /* ---------- unary ---------- */
  Say(call, callback) {
    const req = call.request ?? {};
    // oneofs:true gives a `flavor` discriminator field naming the chosen branch.
    const flavor = req.flavor ?? "(none)";
    const decorated = req.decorated ?? {};
    const body =
      flavor === "decorated"
        ? `${decorated.prefix ?? ""}${req.text ?? ""}${decorated.suffix ?? ""}`
        : (req.text ?? "");

    callback(null, {
      text: `echo: ${body}`,
      meta: meta(),
      // Distinguishes "absent" from "empty string" for the optional field.
      had_nickname:
        Object.prototype.hasOwnProperty.call(req, "nickname") &&
        req.nickname !== undefined,
      flavor_used: flavor,
    });
  },

  /* ---------- unary failure ---------- */
  Boom(_call, callback) {
    callback({
      code: grpc.status.FAILED_PRECONDITION,
      details: "boom, as requested",
    });
  },

  /* ---------- server streaming ---------- */
  Countdown(call) {
    const from = Number(call.request?.from ?? 5);
    const interval = Number(call.request?.interval_ms ?? 100);
    let n = from;
    let closed = false;

    const timer = setInterval(() => {
      if (closed) return;
      if (n < 0) {
        clearInterval(timer);
        call.end();
        return;
      }
      call.write({ value: n-- });
    }, interval);

    const stop = () => {
      closed = true;
      clearInterval(timer);
    };
    call.on("cancelled", stop);
    call.on("error", stop);
    call.on("close", stop);
  },

  /* ---------- client streaming ---------- */
  Sum(call, callback) {
    let total = 0;
    let count = 0;
    call.on("data", (msg) => {
      total += Number(msg?.value ?? 0);
      count += 1;
    });
    call.on("end", () => callback(null, { total, count }));
    call.on("error", () => {
      /* client went away; nothing to report */
    });
  },

  /* ---------- bidi streaming ---------- */
  Chat(call) {
    call.write({ from: "server", text: "welcome" });
    call.on("data", (msg) => {
      call.write({ from: "server", text: `you said: ${msg?.text ?? ""}` });
    });
    call.on("end", () => call.end());
    call.on("error", () => {
      /* client cancelled */
    });
  },
};

const server = new grpc.Server();
server.addService(loaded.demo.echo.Echo.service, impl);

/**
 * Reflection is optional. Install @grpc/reflection to exercise the
 * reflection-based discovery path; without it the proto-directory path still
 * works and the client skips the reflection cases.
 */
let reflectionEnabled = false;
try {
  const { ReflectionService } = await import("@grpc/reflection");
  new ReflectionService(packageDefinition).addToServer(server);
  reflectionEnabled = true;
} catch {
  console.warn("[server] @grpc/reflection not installed; reflection disabled");
}

const port = process.env.PORT ?? "50051";
server.bindAsync(
  `127.0.0.1:${port}`,
  grpc.ServerCredentials.createInsecure(),
  (err, boundPort) => {
    if (err) throw err;
    console.log(
      `[server] listening on 127.0.0.1:${boundPort} (reflection: ${reflectionEnabled})`,
    );
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.tryShutdown(() => process.exit(0)));
}
