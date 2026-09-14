import type {
  GraphQLArg,
  GraphQLNamedType,
  GraphQLTypeRef,
  IntrospectedSchema,
  GeneratedOperation,
} from "../../core/types";

/** Unwrap NON_NULL / LIST wrappers down to the named type at the core. */
function unwrap(ref: GraphQLTypeRef): {
  named?: string;
  nullable: boolean;
  listDepth: number;
} {
  let cur: GraphQLTypeRef | null | undefined = ref;
  let nullable = true;
  let listDepth = 0;
  // The wrapper immediately enclosing the named type decides nullability;
  // track it as we descend so `[String!]!` and `[String]` are told apart.
  let sawNonNullAtCurrentLevel = false;

  while (cur) {
    if (cur.kind === "NON_NULL") {
      sawNonNullAtCurrentLevel = true;
      cur = cur.ofType ?? null;
      continue;
    }
    if (cur.kind === "LIST") {
      listDepth += 1;
      nullable = !sawNonNullAtCurrentLevel;
      sawNonNullAtCurrentLevel = false;
      cur = cur.ofType ?? null;
      continue;
    }
    // Named type reached.
    if (listDepth === 0) nullable = !sawNonNullAtCurrentLevel;
    return { named: cur.name ?? undefined, nullable, listDepth };
  }
  return { nullable: true, listDepth };
}

const SCALAR_JSON_SCHEMA: Record<string, any> = {
  ID: { type: "string" },
  String: { type: "string" },
  Int: { type: "integer" },
  Float: { type: "number" },
  Boolean: { type: "boolean" },
};

function jsonSchemaForArg(
  arg: GraphQLArg,
  schema: IntrospectedSchema,
  notes: string[],
): any {
  const { named, nullable, listDepth } = unwrap(arg.type);
  let inner: any;

  const namedType = named ? schema.types.get(named) : undefined;
  if (named && SCALAR_JSON_SCHEMA[named]) {
    inner = { ...SCALAR_JSON_SCHEMA[named] };
  } else if (namedType?.kind === "ENUM") {
    inner = {
      type: "string",
      enum: (namedType.enumValues ?? []).map((v) => v.name),
    };
  } else if (namedType?.kind === "INPUT_OBJECT") {
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const field of namedType.inputFields ?? []) {
      properties[field.name] = jsonSchemaForArg(field, schema, notes);
      const unwrapped = unwrap(field.type);
      if (!unwrapped.nullable && field.defaultValue == null) {
        required.push(field.name);
      }
    }
    inner = { type: "object", properties, ...(required.length ? { required } : {}) };
  } else {
    // Custom scalar (e.g. DateTime, JSON) with no further shape to describe.
    if (named && !SCALAR_JSON_SCHEMA[named]) {
      notes.push(`Argument "${arg.name}" has custom scalar type "${named}"; sampled as a string.`);
    }
    inner = { type: "string" };
  }

  for (let i = 0; i < listDepth; i += 1) {
    inner = { type: "array", items: inner };
  }
  if (nullable) inner.nullable = true;
  return inner;
}

/** Depth of selection-set expansion for object-typed return fields. */
const SELECTION_DEPTH = 2;

/** Build a `{ a b c }` selection set for an object return type, recursing a bounded depth. */
function buildSelectionSet(
  typeName: string | undefined,
  schema: IntrospectedSchema,
  depth: number,
  seen: Set<string>,
): string {
  if (!typeName) return "__typename";
  const type = schema.types.get(typeName);
  if (!type || !Array.isArray(type.fields) || !type.fields.length) {
    return "__typename";
  }
  // A cycle (Type A referencing itself) stops expansion at the next level.
  if (seen.has(typeName) || depth <= 0) return "__typename";
  seen.add(typeName);

  const lines: string[] = [];
  for (const field of type.fields) {
    if (field.isDeprecated) continue;
    // Only select fields that take no required arguments, to keep the
    // generated document valid without also having to invent nested variables.
    const hasRequiredArg = (field.args ?? []).some((a) => !unwrap(a.type).nullable);
    if (hasRequiredArg) continue;

    const { named, listDepth } = unwrap(field.type);
    const namedType = named ? schema.types.get(named) : undefined;
    const isScalarOrEnum =
      !namedType || namedType.kind === "SCALAR" || namedType.kind === "ENUM" || !!SCALAR_JSON_SCHEMA[named ?? ""];

    if (isScalarOrEnum) {
      lines.push(field.name);
    } else if (namedType?.kind === "OBJECT" || namedType?.kind === "INTERFACE" || namedType?.kind === "UNION") {
      if (depth <= 1) continue; // Bound recursion; omit deeply nested object fields.
      const nested = buildSelectionSet(named, schema, depth - 1, new Set(seen));
      lines.push(`${field.name} { ${nested} }`);
      void listDepth;
    }
    if (lines.length >= 12) break; // Keep generated documents readable.
  }

  return lines.length ? lines.join(" ") : "__typename";
}

/**
 * Generate a complete, runnable operation document plus a variables schema
 * for one root field (a query, mutation or subscription).
 *
 * This is the GraphQL analogue of the gRPC adapter's `buildMessageTemplate`:
 * a schema was just fetched, and this turns it into something a caller can
 * send immediately without hand-writing GraphQL.
 */
export function generateOperation(
  operationType: "query" | "mutation" | "subscription",
  field: { name: string; args: GraphQLArg[]; type: GraphQLTypeRef },
  schema: IntrospectedSchema,
): GeneratedOperation {
  const notes: string[] = [];
  const properties: Record<string, any> = {};
  const required: string[] = [];
  const argDecls: string[] = [];
  const argUses: string[] = [];

  for (const arg of field.args ?? []) {
    const { named, nullable, listDepth } = unwrap(arg.type);
    let gqlType = named ?? "String";
    for (let i = 0; i < listDepth; i += 1) gqlType = `[${gqlType}]`;
    if (!nullable) gqlType += "!";

    argDecls.push(`$${arg.name}: ${gqlType}`);
    argUses.push(`${arg.name}: $${arg.name}`);
    properties[arg.name] = jsonSchemaForArg(arg, schema, notes);
    if (!nullable && arg.defaultValue == null) required.push(arg.name);
  }

  const { named: returnNamed, listDepth: returnListDepth } = unwrap(field.type);
  const returnType = returnNamed ? schema.types.get(returnNamed) : undefined;
  const isObjectReturn =
    returnType && (returnType.kind === "OBJECT" || returnType.kind === "INTERFACE" || returnType.kind === "UNION");
  const selection = isObjectReturn
    ? ` { ${buildSelectionSet(returnNamed, schema, SELECTION_DEPTH, new Set())} }`
    : "";
  void returnListDepth;

  const operationName = `${capitalize(operationType)}_${capitalize(field.name)}`;
  const argDeclClause = argDecls.length ? `(${argDecls.join(", ")})` : "";
  const argUseClause = argUses.length ? `(${argUses.join(", ")})` : "";

  const query =
    `${operationType} ${operationName}${argDeclClause} {\n` +
    `  ${field.name}${argUseClause}${selection}\n` +
    `}`;

  return {
    operationType,
    fieldName: field.name,
    operationName,
    query,
    variablesSchema: { type: "object", properties, required },
    notes,
  };
}

/** Enumerate every generatable operation across Query/Mutation/Subscription. */
export function generateAllOperations(schema: IntrospectedSchema): GeneratedOperation[] {
  const out: GeneratedOperation[] = [];
  const roots: Array<[string | undefined, "query" | "mutation" | "subscription"]> = [
    [schema.queryType, "query"],
    [schema.mutationType, "mutation"],
    [schema.subscriptionType, "subscription"],
  ];
  for (const [typeName, operationType] of roots) {
    if (!typeName) continue;
    const type = schema.types.get(typeName);
    for (const field of type?.fields ?? []) {
      out.push(generateOperation(operationType, field, schema));
    }
  }
  return out;
}

function capitalize(name: string): string {
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}
