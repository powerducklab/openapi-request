import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bin = (name) => join(root, "node_modules", ".bin", name);

await rm(join(root, "dist"), { recursive: true, force: true });
await mkdir(join(root, "dist"), { recursive: true });

const run = (cmd, args) => {
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status ?? 1);
};

// Single-file ESM bundle. Peer-ish runtime deps stay external so the app
// controls their versions; node builtins are external automatically.
run(bin("esbuild"), [
  "src/index.ts",
  "--bundle",
  "--format=esm",
  "--platform=node",
  "--target=node22",
  "--outfile=dist/index.js",
  "--external:postman-collection",
  "--external:postman-runtime",
  "--external:ws",
  "--external:@grpc/grpc-js",
  "--external:@grpc/proto-loader",
  "--sourcemap",
]);

// Declaration emit: keeps the src tree shape under dist so "./core/..."-style
// deep imports keep typechecking.
run(bin("tsc"), ["-p", "tsconfig.build.json"]);

console.log("built dist/index.js + dist/*.d.ts");
