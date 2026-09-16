# @powerduck/openapi-request

[![npm version](https://img.shields.io/npm/v/@powerduck/openapi-request)](https://www.npmjs.com/package/@powerduck/openapi-request)
[![license](https://img.shields.io/npm/l/@powerduck/openapi-request)](https://github.com/powerducklab/openapi-request/blob/main/LICENSE)
[![downloads](https://img.shields.io/npm/dm/@powerduck/openapi-request)](https://www.npmjs.com/package/@powerduck/openapi-request)
[![website](https://img.shields.io/badge/website-powerduck.com-blue)](https://www.powerduck.com/)

OpenAPI 3.2 collection debugger with first-class support for HTTP, SSE,
WebSocket, GraphQL, gRPC, and MCP. `createClient()` is the single UI-facing
surface: it answers what the UI needs before sending (`prepare`), runs one-shot
calls (`send`), opens long-lived sessions (`connect`), discovers schemas
(`discover`), and writes live responses back into the OpenAPI document
(`writeback`).

---

## Install

```bash
npm install @powerduck/openapi-request
```

## Quick Start

### Prepare and send one operation

```typescript
import { createClient } from "@powerduck/openapi-request";

const client = createClient();

// Inspect the request without sending — protocol, transport, stream kind,
// and display mode are all derived from the operation's x-extensions.
const prepared = client.prepare({
  spec,
  target: { operationId: "getUserById" },
  values: { path: { id: "123" }, query: { include: "profile" } },
});

console.log(prepared.protocol);      // "http"
console.log(prepared.stream.kind);   // "none" | "sse" | "websocket" | ...
console.log(prepared.display.mode);  // "response" | "event-list" | "duplex-session"

// Send the call. The result includes a derived OpenAPI response fragment
// and, by default, a deep copy of the spec with that response merged in.
const result = await client.send({
  spec,
  target: { operationId: "getUserById" },
  values: { path: { id: "123" } },
});

console.log(result.responseStatusCode); // "200"
console.log(result.patchedSpec);        // spec with the 200 response written back
```

### Batch replay with schema inference

```typescript
const results = client.sendMany(
  spec,
  [
    { target: { operationId: "listUsers" }, values: { query: { limit: 10 } } },
    { target: { operationId: "createUser" }, values: { requestBody: { name: "Ada" } } },
  ],
  { serverUrl: "https://api.example.com" },
);
```

### Long-lived sessions (WebSocket / MCP / gRPC bidi)

```typescript
const session = client.connect({
  spec,
  target: { operationId: "chatStream" },
  // ...protocol-specific options (websocket / mcp / grpc)
});

session.on("message", (msg) => console.log(msg));
await session.send({ text: "hello" });
await session.close();
```

### Discover MCP / gRPC capabilities

```typescript
const mcpCaps = await client.discover({ protocol: "mcp", url: "http://localhost:3000/mcp" });
const grpcCaps = await client.discover({ protocol: "grpc", endpoint: "localhost:50051" });
```

### Write a live response back into the spec

```typescript
const prepared = client.prepare({ spec, target: { operationId: "getUser" } });
const result = await client.send({ spec, target: { operationId: "getUser" } });

const patched = client.writeback(spec, prepared, result);
// `patched` is a new spec object with the response merged under the
// operation's 200 (or observed status) response.
```

---

## Links

- [Official Website](https://www.powerduck.com/opensource/openapi-request.html)
- [Documentation](https://www.powerduck.com/docs/openapi-request/introduction)
- [GitHub](https://github.com/powerducklab/openapi-request)
- [npm](https://www.npmjs.com/package/@powerduck/openapi-request)

---

## Protocols

| Protocol    | Transport            | Stream kind                  |
|-------------|----------------------|------------------------------|
| HTTP        | HTTP/1.1, HTTP/2     | none, sse, ndjson, chunked   |
| WebSocket   | ws / wss             | websocket (duplex session)   |
| GraphQL     | HTTP POST            | none, graphql-stream         |
| gRPC        | HTTP/2               | unary, server/client/bidi stream |
| MCP         | streamable-http, stdio| mcp-http-stream, mcp-stdio  |

The protocol is derived from the operation's `x-protocol` extension
(`"http" | "ws" | "graphql" | "grpc" | "mcp"`). When omitted, it defaults to
`"http"`.

---

## API Reference

### `createClient(options?)`

| Option | Type | Description |
|--------|------|-------------|
| `writeBack` | `WriteBackOptions` | Defaults for the response write-back step |
| `response`  | `ToResponseOptions` | Defaults for deriving an OpenAPI Response Object from a live call |

Returns a `ProtoClient`:

| Method | Signature | Description |
|--------|-----------|-------------|
| `prepare` | `(opts: SendOptions) => PreparedRequest` | Resolve protocol, transport, stream kind, and display mode without sending |
| `send` | `(opts: SendOptions) => Promise<SendResult>` | Execute one operation and run the full write-back pipeline |
| `sendMany` | `(spec, targets, shared?) => Promise<SendResult[]>` | Batch replay across operations, accumulating inferred schemas |
| `connect` | `(opts: ManualSessionOptions) => AnyManualSession` | Open a long-lived WebSocket / MCP / gRPC session |
| `discover` | `(opts) => Promise<any>` | Discover MCP tools/resources/prompts or gRPC services |
| `writeback` | `(spec, prepared, result, opts?) => OpenApiDocument` | Merge one call's response into a spec copy |
| `dispose` | `() => void` | Release client-level resources |

### `SendOptions`

| Field | Type | Description |
|-------|------|-------------|
| `spec` | `OpenApiDocument` | The complete OpenAPI 3.2 document (required) |
| `target` | `{ path?, method?, operationId? }` | Which operation to run (required) |
| `values` | `RequestValues` | Path / query / header / cookie / requestBody values |
| `serverUrl` | `string` | Override `spec.servers[0].url` |
| `variables` | `Record<string, string>` | Server variable values |
| `auth` | `AuthConfig` | Bearer / API key / Basic / custom scheme values |
| `timeout` | `number` | Per-request timeout (ms) |
| `writeBack` | `boolean` | Set `false` to skip spec patching (still produces `responseFragment`) |
| `websocket` / `graphql` / `mcp` / `grpc` | protocol options | Per-protocol configuration |

### `SendResult`

| Field | Type | Description |
|-------|------|-------------|
| `responseStatusCode` | `string` | Observed HTTP / RPC status |
| `responseFragment` | `any` | OpenAPI 3.2 Response Object derived from the live call |
| `patchedSpec` | `OpenApiDocument \| undefined` | Deep copy of the spec with the response merged in |
| `writeBackSkippedReason` | `string` | Why write-back did not happen (when applicable) |

### `PreparedRequest`

Returned by `prepare()`. Carries the resolved `protocol`, `transport`,
`display.mode`, `stream.kind`, and OpenAPI extensions the UI needs to pick a
renderer before any bytes are sent.

---

## Utility Exports

| Function | Description |
|----------|-------------|
| `locateOperation(spec, target)` | Find an operation by `operationId` or `path`+`method` |
| `inferSchema(value)` / `inferSchemaFromMany(values)` | Infer a JSON Schema from sample values |
| `mergeSchema(base, incoming)` | Merge an inferred schema into an existing one |
| `sampleFromSchema(schema)` | Produce an example value from a JSON Schema |
| `toResponseObject(result, options?)` | Convert a live call into an OpenAPI Response Object |
| `writeBackResponse(spec, path, method, fragment, options?)` | Merge a response fragment into a spec copy |
| `probeStreamingResponse(response)` | Detect SSE / chunked / ndjson on a raw fetch Response |

| Class / Type | Description |
|--------------|-------------|
| `ProtoKitError` | Structured error carrying status, headers, and parsed body |
| `HttpAdapter` | Low-level HTTP adapter |
| `SseParser` | SSE event stream parser |
| `GraphQLAdapter` | GraphQL operation runner |
| `McpAdapter` | MCP client adapter |
| `AdapterRegistry` | Register custom protocol adapters |

---

## License

MIT © [POWERDUCK LIMITED](https://www.powerduck.com)
