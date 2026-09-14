# @powerduck/openapi-request examples

Every example is a runnable `.mjs` script against a self-contained local
server. Start the server first, then run the demo in a second terminal.

```bash
npm run build            # one-time: emit dist/index.js
```

## HTTP / SSE — decide the renderer before sending

```bash
node examples/http/server.mjs        # terminal 1
node examples/http/demo.mjs          # terminal 2
node examples/http/client.mjs
```

`demo.mjs` shows the two questions the UI asks up front:
`prepare().display.mode` (`response` vs `event-list`) and
`prepare().stream.kind`. `/sse` is inferred from the declared
`text/event-stream` content type — no extension needed. `client.mjs` shows
`probeStreamingResponse()` classifying the live response headers instead.

## WebSocket — duplex session, one event shape

```bash
node examples/ws/server.mjs
node examples/ws/demo.mjs
```

The session emits `SessionEventDTO` for open/text/binary/close/error. One
renderer consumes ws, mcp and grpc sessions alike.

## GraphQL — introspect, write operations, send, write back

```bash
node examples/graphql/server.mjs
node examples/graphql/demo.mjs
```

`discoverAndWriteGraphQLSchema()` runs introspection and writes one OpenAPI
operation per field; `createClient().send()` executes the query; the response
is merged back into the document.

## gRPC — all four modes

```bash
node examples/grpc/server.mjs
node examples/grpc/demo.mjs
node examples/grpc/client.mjs
```

`demo.mjs` discovers the schema from proto files, sends a unary call through
`createClient`, and opens a manual session. `client.mjs` drives unary, server
streaming, client streaming and bidi through manual sessions.

## MCP — Streamable HTTP and stdio

```bash
node examples/mcp/server.mjs         # terminal 1 (http)
node examples/mcp/demo.mjs           # terminal 2
node examples/mcp/client.mjs         # stdio, self-contained
```

`demo.mjs` discovers tools over HTTP, writes them into OpenAPI, sends a call
and opens a duplex session. `client.mjs` spawns a child stdio server. Note
that a stdio child may interleave many lines; responses are paired with
requests by JSON-RPC id, so each call resolves exactly one result.

## Electron preload

`electron-preload/client-bridge.mjs` wires `createClient`/`createManualSession`
through `contextBridge` so the renderer gets the identical API surface without
Node access.
