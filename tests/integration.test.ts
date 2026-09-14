// End-to-end tests: real servers, full pipeline (prepare -> send -> writeback)
// and live SSE classification. These mirror what the electron renderer does.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createClient,
  discoverAndWriteGrpcOperations,
  discoverMcpCapabilities,
  generateAllMcpCalls,
  writeMcpOperations,
} from "../src/index.js";
import {
  echoProtoDir,
  echoProtoPath,
  startGrpcServer,
  startHttpServer,
  startMcpHttpServer,
} from "./helpers/servers.js";

const servers = {
  http: startHttpServer(),
  mcp: startMcpHttpServer(),
  grpc: startGrpcServer(),
};

beforeAll(async () => {
  await Promise.all([servers.http.port, servers.mcp.port, servers.grpc.port]);
});

afterAll(() => {
  for (const server of Object.values(servers)) server.stop();
});

describe("HTTP + SSE streaming", () => {
  it("probeStreamingResponse classifies live response headers", async () => {
    const port = await servers.http.port;
    const client = createClient();
    const probe = await client.probeStreamingResponse(`http://127.0.0.1:${port}/sse`);
    expect(probe.ok).toBe(true);
    expect(probe.kind).toBe("sse");
    expect(probe.contentType).toContain("text/event-stream");
    await probe.response.body?.cancel?.();

    const plain = await client.probeStreamingResponse(`http://127.0.0.1:${port}/json`);
    expect(plain.kind).toBe("none");
  });

  it("send() streams SSE events into the response and reports them early", async () => {
    const port = await servers.http.port;
    const spec = {
      openapi: "3.2.0",
      info: { title: "sse", version: "1.0.0" },
      servers: [{ url: `http://127.0.0.1:${port}` }],
      paths: {
        "/sse": {
          get: {
            operationId: "getSse",
            responses: { "200": { description: "ok", content: { "text/event-stream": {} } } },
          },
        },
      },
    };
    const target = { path: "/sse", method: "get" };
    const client = createClient();

    let startInfo;
    const result = await client.send({
      spec,
      target,
      onResponseStart: (info) => {
        startInfo = info;
      },
    });

    expect(startInfo).toMatchObject({ streaming: true, protocol: "sse" });
    expect((result.response as any).streaming).toBe(true);
    expect(result.response.body).toHaveProperty("total", 4);
    expect(result.response.body).toHaveProperty("seq", 4);
  });
});

describe("OpenAPI write-back across protocols", () => {
  it("writes gRPC operations with a kind the client can read back", async () => {
    const address = await servers.grpc.grpcAddress;
    const spec = { openapi: "3.2.0", info: { title: "g", version: "1" }, paths: {} };
    const { spec: withOps } = await discoverAndWriteGrpcOperations(spec, {
      address,
      protoPaths: [echoProtoPath],
      includeDirs: [echoProtoDir],
    });

    const operation = withOps.paths["/grpc/demo/echo/Echo/Say"].post;
    expect(operation["x-protocol"]).toBe("grpc");
    expect(operation["x-grpc"].kind).toBe("unary");
    expect(operation["x-grpc"].address).toBe(address);

    const prepared = createClient().prepare({
      spec: withOps,
      target: { path: "/grpc/demo/echo/Echo/Say", method: "post" },
    });
    expect(prepared.stream.kind).toBe("grpc-unary");
    expect(prepared.display.mode).toBe("response");
  });

  it("writes MCP operations from live discovery with endpoint and method", async () => {
    const port = await servers.mcp.port;
    const endpoint = `http://127.0.0.1:${port}/mcp`;
    const { capabilities } = await discoverMcpCapabilities(endpoint);
    const spec = writeMcpOperations(
      { openapi: "3.2.0", info: { title: "m", version: "1" }, paths: {} },
      endpoint,
      generateAllMcpCalls(capabilities),
    );
    const operation = spec.paths["/mcp/tools/echo"].post;
    expect(operation["x-protocol"]).toBe("mcp");
    expect(operation["x-mcp"].endpoint).toBe(endpoint);
    expect(operation["x-mcp"].method).toBe("tools/call");
  });
});
