// GraphQL demo: introspect the schema, write operations into an OpenAPI
// document, then send one query through createClient and write the response
// back into the document.
//
//   node examples/graphql/demo.mjs
//   (start examples/graphql/server.mjs first)
import { createClient, discoverAndWriteGraphQLSchema } from "../../dist/index.js";

const spec = {
  openapi: "3.2.0",
  info: { title: "graphql-demo", version: "1.0.0" },
  servers: [{ url: "http://127.0.0.1:4300" }],
  paths: {},
};

const { spec: withOp, operations } = await discoverAndWriteGraphQLSchema(
  spec,
  "http://127.0.0.1:4300/graphql",
);
console.log("generated operations:", operations.map((op) => op.operationType + " " + op.fieldName).join(", "));

const target = { path: "/graphql/query/hello", method: "post" };
const client = createClient();

const prepared = client.prepare({ spec: withOp, target });
console.log("prepare:", prepared.display.mode, prepared.stream.kind);

const result = await client.send({
  spec: withOp,
  target,
  graphql: { variables: { name: "Ada" } },
});
console.log("response:", JSON.stringify(result.response.body));

const patched = client.writeback(withOp, prepared, result);
console.log(
  "writeback status keys:",
  Object.keys(patched.paths["/graphql/query/hello"].post.responses ?? {}).join(", "),
);
