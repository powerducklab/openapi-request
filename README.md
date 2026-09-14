# @powerduck/openapi-request

[![npm version](https://img.shields.io/npm/v/@powerduck/openapi-request)](https://www.npmjs.com/package/@powerduck/openapi-request)
[![license](https://img.shields.io/npm/l/@powerduck/openapi-request)](https://github.com/powerducklab/openapi-request/blob/main/LICENSE)
[![downloads](https://img.shields.io/npm/dm/@powerduck/openapi-request)](https://www.npmjs.com/package/@powerduck/openapi-request)

Execute OpenAPI operations with full parameter serialization, security resolution, and response parsing. Supports fetch, axios, and custom HTTP clients. Built for browsers, Node.js, and Edge Functions.

---

Powerduck is an open-source developer tooling platform for teams building modern API workflows.

- **Full Parameter Serialization** — Path, query, header, and cookie parameters with RFC 6570 URI templates
- **Security Resolution** — Bearer tokens, API keys, Basic auth, OAuth2, and custom schemes
- **3 HTTP Clients** — fetch (default), axios, and custom client adapters
- **Request Body Handling** — JSON, form-data, x-www-form-urlencoded, and raw payloads
- **Response Parsing** — Automatic JSON, text, blob, and stream parsing with content-type detection
- **Prepare & Send** — Two-phase API for request inspection before sending
- **Type-Safe Operations** — Full TypeScript types for parameters, request bodies, and responses
- **Error Handling** — Structured error objects with status, headers, and parsed body
- **Interceptors** — Request and response interceptors for logging, auth refresh, and retries
- **Browser & Node** — Works in browsers, Node.js, and Edge Functions with zero dependencies

---

## Quick Start

### Install

```bash
npm install @powerduck/openapi-request
```

### Create a client and send a request

```typescript
import { createClient } from "@powerduck/openapi-request";

const client = createClient();

const result = await client.send({
  spec: openApiDocument,
  operationId: "getUserById",
  parameters: {
    path: { id: "123" },
    query: { include: "profile" },
  },
});

console.log(result.response.status); // e.g. 200
console.log(result.response.body); // parsed response body
console.log(result.response.headers); // response headers
```

### Prepare and send separately

```typescript
import { createClient } from "@powerduck/openapi-request";

const client = createClient();

// Prepare builds the request without sending
const prepared = client.prepare({
  spec: openApiDocument,
  operationId: "listUsers",
  parameters: {
    query: { page: 1, limit: 20 },
  },
});

console.log(prepared.url); // final URL with serialized params
console.log(prepared.method); // HTTP method
console.log(prepared.headers); // resolved headers

// Send the prepared request
const result = await client.sendPrepared(prepared);
```

### With authentication

```typescript
import { createClient } from "@powerduck/openapi-request";

const client = createClient({
  securityValues: {
    bearerAuth: "your-token-here",
    apiKey: "your-api-key",
  },
});

const result = await client.send({
  spec: openApiDocument,
  operationId: "getProfile",
});
```

---

## Links

- [Official Website](https://www.powerduck.com/opensource/openapi-request.html)
- [Documentation](https://www.powerduck.com/docs/openapi-request/introduction)
- [GitHub](https://github.com/powerducklab/openapi-request)
- [npm](https://www.npmjs.com/package/@powerduck/openapi-request)

---

## Features

- **Full parameter serialization** — Path, query, header, and cookie parameters with RFC 6570 URI templates
- **Security resolution** — Bearer tokens, API keys, Basic auth, OAuth2, and custom schemes
- **3 HTTP clients** — fetch (default), axios, and custom client adapters
- **Request body handling** — JSON, form-data, x-www-form-urlencoded, and raw payloads
- **Response parsing** — Automatic JSON, text, blob, and stream parsing with content-type detection
- **Prepare & send** — Two-phase API for request inspection before sending
- **Type-safe operations** — Full TypeScript types for parameters, request bodies, and responses
- **Error handling** — Structured error objects with status, headers, and parsed body
- **Interceptors** — Request and response interceptors for logging, auth refresh, and retries
- **Browser & Node** — Works in browsers, Node.js, and Edge Functions with zero dependencies
- **Server selection** — Auto-select or manually specify server from OpenAPI servers
- **Content negotiation** — Automatic Accept header based on response content types
- **Upload progress** — Progress callbacks for file uploads with axios client
- **Abort support** — AbortController / AbortSignal for request cancellation
- **Dual ESM/CJS** — Works with `import` and `require`, with bundled TypeScript declarations

---

## API Reference

### `createClient(options?)`

Create an OpenAPI request client.

```typescript
import { createClient } from "@powerduck/openapi-request";

const client = createClient({
  client: "fetch", // "fetch" | "axios" | custom adapter
  baseUrl: "https://api.example.com",
  securityValues: { bearerAuth: "token" },
  defaultHeaders: { "X-App": "my-app" },
  timeout: 30000,
});
```

### `client.send(options)`

Send an OpenAPI operation.

```typescript
const result = await client.send({
  spec: openApiDocument,
  operationId: "getUser",
  parameters: {
    path: { id: "123" },
    query: { include: ["profile", "orders"] },
    header: { "X-Request-ID": "abc" },
  },
  requestBody: { name: "Ada" },
  securityValues: { bearerAuth: "token" },
  serverIndex: 0,
  signal: abortSignal,
});
```

### `client.prepare(options)`

Prepare a request without sending.

```typescript
const prepared = client.prepare({
  spec: openApiDocument,
  operationId: "listUsers",
  parameters: { query: { page: 1 } },
});

// prepared.url, prepared.method, prepared.headers, prepared.body
```

### `client.sendPrepared(prepared)`

Send a previously prepared request.

```typescript
const result = await client.sendPrepared(prepared);
```

### Result Type

```typescript
interface RequestResult<T = unknown> {
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: T;
    raw: Response;
  };
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  duration: number; // milliseconds
}
```

### Error Type

```typescript
class OpenApiRequestError extends Error {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  request: { url: string; method: string; headers: Record<string, string> };
}
```

---

## Interceptors

```typescript
import { createClient } from "@powerduck/openapi-request";

const client = createClient({
  interceptors: {
    request: async (request) => {
      console.log("Request:", request.method, request.url);
      request.headers["X-Request-ID"] = crypto.randomUUID();
      return request;
    },
    response: async (response) => {
      console.log("Response:", response.status);
      return response;
    },
    error: async (error) => {
      if (error.status === 401) {
        // Refresh token and retry
        return refreshToken().then(() => client.sendPrepared(error.request));
      }
      throw error;
    },
  },
});
```

---

## TypeScript Types

```typescript
import type {
  OpenApiClient,
  ClientOptions,
  SendOptions,
  PrepareOptions,
  RequestResult,
  OpenApiRequestError,
  ParameterMap,
  SecurityValues,
  HttpMethod,
} from "@powerduck/openapi-request";
```

---

## License

MIT © [POWERDUCK LIMITED](https://www.powerduck.com)
