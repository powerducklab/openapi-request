import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/protocols/http/index.ts",
    "src/protocols/ws/index.ts",
    "src/protocols/grpc/index.ts",
    "src/protocols/mcp/index.ts",
    "src/protocols/graphql/index.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  minify: "terser",
  target: "node18",
  platform: "node",
  // These carry native and dynamic requires that must not be bundled.
  external: [
    // "postman-runtime",
    // "postman-collection",
    // "ws",
    // "@grpc/grpc-js",
    // "@grpc/proto-loader",
  ],
});
