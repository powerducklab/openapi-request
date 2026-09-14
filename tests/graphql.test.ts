// GraphQL integration tests: real fixture server, full pipeline.
// Covers query, mutation, variables, introspection, SSE streaming,
// useGet mode, and error paths.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createClient,
  discoverAndWriteGraphQLSchema,
  introspectSchema,
} from "../src/index.js";
import { startGraphQLServer } from "./helpers/servers.js";

const server = startGraphQLServer();

beforeAll(async () => {
  await server.port;
});

afterAll(() => {
  server.stop();
});

function graphqlSpec(endpoint: string, query: string, extra: Record<string, unknown> = {}) {
  return {
    openapi: "3.2.0",
    info: { title: "gql-test", version: "1.0.0" },
    paths: {
      "/graphql": {
        post: {
          operationId: "graphqlOp",
          "x-protocol": "graphql",
          "x-graphql": { endpoint, query, ...extra },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

describe("GraphQL query execution", () => {
  it("executes a query with variables and returns data", async () => {
    const port = await server.port;
    const endpoint = `http://127.0.0.1:${port}/graphql`;
    const client = createClient();
    const result = await client.send({
      spec: graphqlSpec(endpoint, "query Hello($name: String!) { hello(name: $name) }"),
      target: { path: "/graphql", method: "post" },
      values: { body: { name: "world" } },
    });
    expect(result.response.status).toBe(200);
    expect((result.response.body as any).data.hello).toBe("Hello, world!");
  });

  it("executes a query returning an object type", async () => {
    const port = await server.port;
    const endpoint = `http://127.0.0.1:${port}/graphql`;
    const client = createClient();
    const result = await client.send({
      spec: graphqlSpec(endpoint, "query Greet($name: String!) { greeting(name: $name) { text language } }"),
      target: { path: "/graphql", method: "post" },
      values: { body: { name: "duck" } },
    });
    const body = result.response.body as any;
    expect(body.data.greeting.text).toBe("Hello, duck!");
    expect(body.data.greeting.language).toBe("en");
  });

  it("passes variables via options.graphql.variables", async () => {
    const port = await server.port;
    const endpoint = `http://127.0.0.1:${port}/graphql`;
    const client = createClient();
    const result = await client.send({
      spec: graphqlSpec(endpoint, "query Hello($name: String!) { hello(name: $name) }"),
      target: { path: "/graphql", method: "post" },
      graphql: { variables: { name: "via-options" } },
    });
    expect((result.response.body as any).data.hello).toBe("Hello, via-options!");
  });

  it("sends operationName in the request body", async () => {
    const port = await server.port;
    const endpoint = `http://127.0.0.1:${port}/graphql`;
    const client = createClient();
    const result = await client.send({
      spec: graphqlSpec(
        endpoint,
        "query OnlyOp { hello(name: \"single\") }",
        { operationName: "OnlyOp" },
      ),
      target: { path: "/graphql", method: "post" },
    });
    expect(result.request.body).toHaveProperty("operationName", "OnlyOp");
    expect((result.response.body as any).data.hello).toBe("Hello, single!");
  });
});

describe("GraphQL mutation", () => {
  it("executes a mutation and returns the result", async () => {
    const port = await server.port;
    const endpoint = `http://127.0.0.1:${port}/graphql`;
    const client = createClient();
    const result = await client.send({
      spec: graphqlSpec(endpoint, "mutation Set($lang: String!) { setGreeting(language: $lang) }"),
      target: { path: "/graphql", method: "post" },
      values: { body: { lang: "fr" } },
    });
    expect(result.response.status).toBe(200);
    expect((result.response.body as any).data.setGreeting).toBe(true);
  });
});

describe("GraphQL useGet mode", () => {
  it("sends the query as GET with querystring params", async () => {
    const port = await server.port;
    // The fixture server only accepts POST on /graphql, so useGet returns
    // 404. We verify the request method and URL shape, not the response.
    const endpoint = `http://127.0.0.1:${port}/graphql`;
    const client = createClient();
    const result = await client.send({
      spec: graphqlSpec(endpoint, "{ hello(name: \"get\") }"),
      target: { path: "/graphql", method: "post" },
      graphql: { useGet: true },
    });
    expect(result.request.method).toBe("GET");
    expect(result.request.url).toContain("query=");
    expect(result.request.url).toContain("hello");
  });
});

describe("GraphQL SSE streaming", () => {
  it("collects incremental events from a text/event-stream response", async () => {
    const port = await server.port;
    // The fixture's /stream-hello only accepts GET, so useGet is required.
    const endpoint = `http://127.0.0.1:${port}/stream-hello`;
    const client = createClient();
    const result = await client.send({
      spec: graphqlSpec(endpoint, "query { hello }"),
      target: { path: "/graphql", method: "post" },
      graphql: { useGet: true },
      maxEvents: 10,
    });
    expect(result.response.contentType).toContain("text/event-stream");
    const events = (result.response as any).events;
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(2);
    const eventNames = events.map((e: any) => e.event);
    expect(eventNames).toContain("next");
    expect(eventNames).toContain("complete");
  });
});

describe("GraphQL introspection", () => {
  it("introspects the schema and returns types", async () => {
    const port = await server.port;
    const endpoint = `http://127.0.0.1:${port}/graphql`;
    const result = await introspectSchema(endpoint);
    expect(result.schema).toBeDefined();
    expect(result.schema.queryType).toBe("Query");
    expect(result.schema.types.has("Greeting")).toBe(true);
    expect(result.schema.types.has("Query")).toBe(true);
  });

  it("discoverAndWriteGraphQLSchema writes operations into the spec", async () => {
    const port = await server.port;
    const endpoint = `http://127.0.0.1:${port}/graphql`;
    const spec = { openapi: "3.2.0", info: { title: "g", version: "1" }, paths: {} };
    const { spec: withOps } = await discoverAndWriteGraphQLSchema(spec, endpoint);
    const paths = Object.keys(withOps.paths);
    expect(paths.length).toBeGreaterThan(0);
    const firstOp = withOps.paths[paths[0]].post;
    expect(firstOp["x-protocol"]).toBe("graphql");
    expect(firstOp["x-graphql"].endpoint).toBe(endpoint);
    expect(typeof firstOp["x-graphql"].query).toBe("string");
  });
});

describe("GraphQL error handling", () => {
  it("surfaces GraphQL errors when data is absent", async () => {
    const port = await server.port;
    const endpoint = `http://127.0.0.1:${port}/graphql`;
    const client = createClient();
    const result = await client.send({
      spec: graphqlSpec(endpoint, "{ nonexistentField }"),
      target: { path: "/graphql", method: "post" },
    });
    // The server returns 200 with errors; the adapter sets error when
    // there is no data alongside errors.
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe("GRAPHQL_ERRORS");
  });

  it("rejects a missing query with BAD_GRAPHQL_QUERY", async () => {
    const port = await server.port;
    const endpoint = `http://127.0.0.1:${port}/graphql`;
    const client = createClient();
    const spec = {
      openapi: "3.2.0",
      info: { title: "g", version: "1" },
      paths: {
        "/graphql": {
          post: {
            operationId: "noQuery",
            "x-protocol": "graphql",
            "x-graphql": { endpoint },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    await expect(
      client.send({ spec, target: { path: "/graphql", method: "post" } }),
    ).rejects.toThrow(/BAD_GRAPHQL_QUERY|No GraphQL query/);
  });

  it("rejects an invalid endpoint with BAD_GRAPHQL_ENDPOINT", async () => {
    const client = createClient();
    const spec = graphqlSpec("ftp://not-http/graphql", "{ hello }");
    await expect(
      client.send({ spec, target: { path: "/graphql", method: "post" } }),
    ).rejects.toThrow(/BAD_GRAPHQL_ENDPOINT|must be an absolute http/);
  });

  it("returns status 0 on network failure (unreachable server)", async () => {
    const client = createClient();
    const spec = graphqlSpec("http://127.0.0.1:1/nonexistent", "{ hello }");
    const result = await client.send({
      spec,
      target: { path: "/graphql", method: "post" },
      timeout: 2000,
    });
    expect(result.response.status).toBe(0);
    expect(result.error).toBeDefined();
  });

  it("respects a short timeout on an unreachable server", async () => {
    const client = createClient();
    const spec = graphqlSpec("http://10.255.255.1:1/graphql", "{ hello }");
    const result = await client.send({
      spec,
      target: { path: "/graphql", method: "post" },
      timeout: 1500,
    });
    expect(result.response.status).toBe(0);
    expect(result.error).toBeDefined();
  });
});

describe("GraphQL prepare() classification", () => {
  it("classifies a graphql operation as display=response", () => {
    const client = createClient();
    const spec = graphqlSpec("http://example.com/graphql", "{ hello }");
    const prepared = client.prepare({
      spec,
      target: { path: "/graphql", method: "post" },
    });
    expect(prepared.protocol).toBe("graphql");
    expect(prepared.display.mode).toBe("response");
  });

  it("classifies a graphql-stream operation as event-list", () => {
    const client = createClient();
    const spec = {
      openapi: "3.2.0",
      info: { title: "g", version: "1" },
      paths: {
        "/graphql": {
          post: {
            operationId: "sub",
            "x-protocol": "graphql",
            "x-response-stream": true,
            "x-graphql": { endpoint: "http://example.com/graphql", query: "subscription { x }" },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const prepared = client.prepare({
      spec,
      target: { path: "/graphql", method: "post" },
    });
    expect(prepared.stream.kind).toBe("graphql-stream");
    expect(prepared.display.mode).toBe("event-list");
  });
});
