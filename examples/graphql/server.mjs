// GraphQL fixture server for the graphql example and tests.
// Serves a tiny schema over POST /graphql. A stream endpoint (SSE) is also
// exposed so the client can show event-list rendering for GraphQL streams.
import http from "node:http";
import { graphql, buildSchema } from "graphql";

const schema = buildSchema(`
  type Greeting { text: String!, language: String! }
  type Query {
    hello(name: String!): String!
    greeting(name: String!): Greeting!
  }
  type Mutation {
    setGreeting(language: String!): Boolean!
  }
`);

const root = {
  hello: ({ name }) => `Hello, ${name}!`,
  greeting: ({ name }) => ({
    text: `Hello, ${name}!`,
    language: "en",
  }),
  setGreeting: () => true,
};

function writeEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/stream-hello" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const name = url.searchParams.get("name") ?? "world";
    writeEvent(res, "next", { data: { hello: `Hello, ${name} (1)!` } });
    writeEvent(res, "next", { data: { hello: `Hello, ${name} (2)!` } });
    writeEvent(res, "complete", { data: null });
    res.end();
    return;
  }

  if (url.pathname === "/graphql" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let query = "";
    let variables = {};
    try {
      const parsed = JSON.parse(body);
      query = parsed.query ?? "";
      variables = parsed.variables ?? {};
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "bad json body" }] }));
      return;
    }
    const result = await graphql({ schema, source: query, rootValue: root, variableValues: variables });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const port = Number(process.env.PORT ?? 4300);
server.listen(port, "127.0.0.1", () => {
  console.log(`graphql server listening on http://127.0.0.1:${port}/graphql`);
});
