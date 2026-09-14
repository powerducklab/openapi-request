import { loadGrpc, requireCapability } from "./loader.js";
import { buildCredentialsChecked } from "./credentials.js";
import { scanProtoFiles, deriveIncludeDirsDetailed } from "./proto-dir.js";
import { fetchFullDescriptorSet } from "./reflection.js";
import {
  decodeFileDescriptorProto,
  decodeFileDescriptorSet,
  DescriptorDecodeError,
  type DecodedFile,
} from "./file-descriptor.js";
import { isMapEntry, pick } from "./descriptor-types.js";
import type { GrpcEndpoint } from "./types.js";

/**
 * Loader options are part of the contract, not an implementation detail:
 * `keepCase` decides whether request JSON keys are snake_case or camelCase, and
 * `enums`/`longs` decide the JSON form of values. template.ts derives the shape
 * it generates from these, so the two can never drift.
 */
export const LOADER_OPTIONS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
} as const;

export type SymbolKind = "service" | "message" | "enum";

export interface SymbolEntry {
  kind: SymbolKind;
  /**
   * The decoded descriptor. Always present — a symbol we cannot describe is not
   * registered at all, because an entry with an absent descriptor is exactly the
   * failure mode that made method lists silently empty.
   */
  type: unknown;
  /**
   * File the symbol was declared in. Unnamed descriptors get a stable synthetic
   * label ("(unnamed #1)"), never a shared placeholder: duplicate-definition
   * diagnostics compare these labels, and a constant would make every pair of
   * duplicates look like the same declaration seen twice.
   */
  file: string;
}

export interface Catalog {
  source: "proto" | "reflection";
  /** Fully-qualified name (no leading dot) -> entry. Map entries excluded. */
  symbols: Map<string, SymbolEntry>;
  /** Service names known from descriptors, sorted. */
  services: string[];
  /** Service names the runtime can actually dial, sorted. */
  invocableServices: string[];
  /** Fully-qualified service name -> ServiceDescriptorProto. */
  serviceDescriptors: Map<string, unknown>;
  /** Non-fatal facts worth surfacing to the user. */
  notes: string[];
  /** Proto files loaded, or descriptor file names when source is reflection. */
  files?: string[];
  /**
   * File names carried by the descriptors that were decoded and indexed.
   *
   * Deliberately separate from `files`: under the proto source `files` is what
   * was found on disk. Note that the two are not always the same *kind* of
   * name — see crossCheckFiles.
   */
  descriptorFiles: string[];
  /**
   * Fully-qualified names of synthetic map-entry messages.
   *
   * They are deliberately absent from `symbols` — a user can never name one —
   * but anything resolving a field's `type_name` still has to tell "this is a
   * map entry" apart from "this type is missing".
   */
  mapEntries: Set<string>;
  /**
   * True when none of the decoded descriptors carried a file name.
   *
   * Diagnostic wording only. It is deliberately NOT a switch for any check:
   * treating "names exist" as "names are comparable to paths" is what produced
   * a confidently false coverage warning for two files whose symbols were all
   * present.
   */
  descriptorFilesUnnamed: boolean;
}

function qualify(pkg: string, name: string): string {
  return pkg ? `${pkg}.${name}` : name;
}

function stripDot(name: string): string {
  return name.startsWith(".") ? name.slice(1) : name;
}

/* ------------------------------------------------------------------ *
 * Type reference resolution
 * ------------------------------------------------------------------ */

/**
 * Resolves a descriptor type reference to a fully-qualified symbol name.
 *
 * `FieldDescriptorProto.type_name` is *specified* to be fully qualified with a
 * leading dot, but that only holds for descriptors produced by protoc.
 * protobufjs — which synthesises both the descriptors @grpc/proto-loader
 * attaches and the ones many servers answer reflection with — emits the
 * reference exactly as written in the .proto source, i.e. relative. Treating
 * those as absolute is what made an entire package's types look missing while
 * they sat in the symbol table under their real names.
 *
 * The search follows protoc's scoping rule: for a reference used inside scope
 * `S`, try `S.ref`, then the enclosing scope, and so on out to the top level.
 *
 * Known deviation: protoc resolves the reference's *first component* and then
 * requires the remainder to exist beneath it, so a nested type shadowing a
 * package name makes an outer reference an error rather than a fallthrough.
 * This resolver falls through. That difference can only surface on schemas
 * protoc itself would reject, where refusing to resolve helps nobody.
 */
export function resolveTypeName(
  catalog: Pick<Catalog, "symbols" | "mapEntries">,
  scope: string,
  ref: string,
): string | undefined {
  if (ref === "") return undefined;

  const known = (fq: string): boolean =>
    catalog.symbols.has(fq) || catalog.mapEntries.has(fq);

  // A leading dot means the reference is already absolute. No search is
  // permitted: falling back to a scoped guess would silently bind a different
  // type than the author named.
  if (ref.startsWith(".")) {
    const fq = ref.slice(1);
    return known(fq) ? fq : undefined;
  }

  let prefix = scope;
  for (;;) {
    const candidate = prefix ? `${prefix}.${ref}` : ref;
    if (known(candidate)) return candidate;
    if (prefix === "") return undefined;
    const cut = prefix.lastIndexOf(".");
    prefix = cut === -1 ? "" : prefix.slice(0, cut);
  }
}

/* ------------------------------------------------------------------ *
 * Symbol table, built from decoded FileDescriptorProtos.
 *
 * This is the metadata view. It is the only source of method signatures,
 * field types and oneof structure; proto-loader's package definition cannot
 * provide any of them.
 * ------------------------------------------------------------------ */

interface IndexState {
  symbols: Map<string, SymbolEntry>;
  serviceDescriptors: Map<string, unknown>;
  mapEntries: Set<string>;
  notes: string[];
  /** Numbers the unnamed descriptors, so their labels stay distinguishable. */
  unnamedSeq: number;
}

function children(container: unknown, camel: string, snake: string): unknown[] {
  const raw = pick<unknown>(container, camel, snake);
  return Array.isArray(raw) ? raw : [];
}

/**
 * Reports a redefinition unconditionally.
 *
 * The earlier version suppressed the note when both declarations claimed the
 * same file, as a defence against indexing one descriptor twice. With unnamed
 * descriptors every file compares equal, so the guard silenced every duplicate
 * enum in the tree — the symbols were dropped in total silence. Double-indexing
 * is a bug in this module and would be caught by its own tests; a schema
 * conflict is the user's to see.
 */
function noteDuplicate(
  state: IndexState,
  kind: SymbolKind,
  fq: string,
  firstFile: string,
  secondFile: string,
): void {
  state.notes.push(
    `duplicate definition of ${kind} "${fq}" (${firstFile} and ` +
      `${secondFile}); the first one was kept.`,
  );
}

function registerMessage(
  state: IndexState,
  file: string,
  scope: string,
  message: unknown,
): void {
  const name = String(pick(message, "name", "name") ?? "");
  if (!name) {
    state.notes.push(`${file}: a message with no name was skipped.`);
    return;
  }
  const fq = qualify(scope, name);

  // Map fields are modelled as a repeated synthetic message with
  // map_entry=true. It is an implementation detail of the encoding, never a
  // type the user can name, so it must not appear in the symbol table — but it
  // must still be remembered, or reference resolution cannot tell it apart
  // from a genuinely missing type.
  if (isMapEntry(message)) {
    state.mapEntries.add(fq);
  } else {
    const existing = state.symbols.get(fq);
    if (existing) {
      noteDuplicate(state, "message", fq, existing.file, file);
    } else {
      state.symbols.set(fq, { kind: "message", type: message, file });
    }
  }

  for (const nested of children(message, "nestedType", "nested_type")) {
    registerMessage(state, file, fq, nested);
  }
  for (const nestedEnum of children(message, "enumType", "enum_type")) {
    registerEnum(state, file, fq, nestedEnum);
  }
}

function registerEnum(
  state: IndexState,
  file: string,
  scope: string,
  enumType: unknown,
): void {
  const name = String(pick(enumType, "name", "name") ?? "");
  if (!name) {
    state.notes.push(`${file}: an enum with no name was skipped.`);
    return;
  }
  const fq = qualify(scope, name);
  const existing = state.symbols.get(fq);
  if (existing) {
    noteDuplicate(state, "enum", fq, existing.file, file);
    return;
  }
  state.symbols.set(fq, { kind: "enum", type: enumType, file });
}

function indexFile(state: IndexState, fileDescriptor: DecodedFile): void {
  const rawName = pick<unknown>(fileDescriptor, "name", "name");
  const file =
    typeof rawName === "string" && rawName !== ""
      ? rawName
      : `(unnamed #${++state.unnamedSeq})`;
  const pkg = String(pick(fileDescriptor, "package", "package") ?? "");

  for (const message of children(
    fileDescriptor,
    "messageType",
    "message_type",
  )) {
    registerMessage(state, file, pkg, message);
  }
  for (const enumType of children(fileDescriptor, "enumType", "enum_type")) {
    registerEnum(state, file, pkg, enumType);
  }
  for (const service of children(fileDescriptor, "service", "service")) {
    const name = String(pick(service, "name", "name") ?? "");
    if (!name) {
      state.notes.push(`${file}: a service with no name was skipped.`);
      continue;
    }
    const fq = qualify(pkg, name);

    // Checked against `symbols`, not only against `serviceDescriptors`: a name
    // collision with a message would otherwise overwrite that message's entry
    // and turn a describable type into a service. The input here can be
    // reflection bytes from a server, so "the proto must be valid" is not an
    // assumption this layer is allowed to make.
    const existing = state.symbols.get(fq);
    if (existing) {
      if (existing.kind === "service") {
        noteDuplicate(state, "service", fq, existing.file, file);
      } else {
        state.notes.push(
          `"${fq}" is declared both as a service (${file}) and as a ` +
            `${existing.kind} (${existing.file}); the ${existing.kind} was ` +
            `kept and the service is not callable through this catalog.`,
        );
      }
      continue;
    }
    state.symbols.set(fq, { kind: "service", type: service, file });
    state.serviceDescriptors.set(fq, service);
  }
}

/**
 * Reports type references that no symbol satisfies.
 *
 * Every `type_name` in a descriptor must resolve, and until this check existed
 * the first thing to notice a broken reference was template generation — which
 * reported it as a template warning the moment a user opened one method, long
 * after the catalog that dropped the symbol had been declared healthy.
 * Checking here attributes the failure to the layer that caused it.
 */
function checkClosure(state: IndexState): void {
  const view = { symbols: state.symbols, mapEntries: state.mapEntries };
  const missing = new Map<string, string[]>();

  const record = (ref: string, user: string): void => {
    const users = missing.get(ref) ?? [];
    if (!users.includes(user)) users.push(user);
    missing.set(ref, users);
  };

  // The scope of a field's reference is the message declaring it; of a method's,
  // the service. Resolution walks outwards from there, so passing the innermost
  // scope is both correct and necessary.
  const visitFields = (
    scope: string,
    owner: string,
    message: unknown,
  ): void => {
    for (const field of children(message, "field", "field")) {
      const raw = pick<unknown>(field, "typeName", "type_name");
      if (typeof raw !== "string" || raw === "") continue;
      if (resolveTypeName(view, scope, raw) === undefined) record(raw, owner);
    }
    for (const nested of children(message, "nestedType", "nested_type")) {
      const name = String(pick(nested, "name", "name") ?? "");
      if (!name) continue;
      visitFields(`${scope}.${name}`, owner, nested);
    }
  };

  for (const [fq, entry] of state.symbols) {
    if (entry.kind === "message") visitFields(fq, fq, entry.type);
  }

  for (const [fq, service] of state.serviceDescriptors) {
    for (const method of children(service, "method", "method")) {
      for (const [camel, snake] of [
        ["inputType", "input_type"],
        ["outputType", "output_type"],
      ] as const) {
        const raw = pick<unknown>(method, camel, snake);
        if (typeof raw !== "string" || raw === "") continue;
        if (resolveTypeName(view, fq, raw) === undefined) record(raw, fq);
      }
    }
  }

  if (missing.size === 0) return;

  const shown = [...missing.keys()].sort().slice(0, 12);
  const users = [...new Set([...missing.values()].flat())].sort();
  state.notes.push(
    `${missing.size} type reference(s) do not resolve against the symbol ` +
      `table: ${shown.join(", ")}` +
      (missing.size > shown.length
        ? ` ...+${missing.size - shown.length}`
        : "") +
      `. Request templates for the messages using them will be incomplete. ` +
      `Referenced from: ${users.slice(0, 6).join(", ")}` +
      (users.length > 6 ? ` ...+${users.length - 6}` : "") +
      `.`,
  );
}

/* ------------------------------------------------------------------ *
 * Runtime view, from proto-loader's package definition.
 *
 * This is the only source of codecs and method paths — the things needed to
 * actually place a call. It carries no method metadata whatsoever, which is
 * why it can never be the source of a method list.
 * ------------------------------------------------------------------ */

function isRuntimeMethodEntry(m: unknown): boolean {
  return (
    m !== null &&
    typeof m === "object" &&
    typeof (m as { path?: unknown }).path === "string"
  );
}

function collectInvocableServices(
  packageDefinition: Record<string, unknown>,
  notes: string[],
): string[] {
  const out: string[] = [];
  const empty: string[] = [];

  for (const [name, value] of Object.entries(packageDefinition)) {
    if (!value || typeof value !== "object") continue;
    // Message/enum entries carry `type` / `fileDescriptorProtos`; a
    // ServiceDefinition is a flat record whose every value is a method
    // definition with a string `path`.
    if ("fileDescriptorProtos" in (value as object)) continue;

    const methods = Object.values(value as Record<string, unknown>);
    if (methods.length === 0) {
      // A service with no rpcs is legal. Left to fall through it would be
      // reported as "described but not invocable (no codecs)", which is the
      // wrong cause and sends the reader looking for a loader problem.
      empty.push(name);
      continue;
    }
    if (methods.every(isRuntimeMethodEntry)) out.push(name);
  }

  if (empty.length > 0) {
    notes.push(
      `${empty.length} service(s) declare no methods and cannot be called: ` +
        `${empty.sort().join(", ")}.`,
    );
  }
  return out.sort();
}

/**
 * Extracts the raw FileDescriptorProto bytes proto-loader attaches to the
 * message and enum entries it produces.
 *
 * Service entries carry no descriptor bytes, so the search cannot assume the
 * first level of the package definition contains a type entry: one nesting
 * level below is inspected as well. Getting this wrong does not degrade
 * gracefully — it reports "your proto-loader is too old", a false accusation
 * that costs an afternoon.
 */
function harvestFileDescriptors(packageDefinition: Record<string, unknown>): {
  buffers: Buffer[];
  /** True when the `fileDescriptorProtos` key was seen at all. */
  found: boolean;
  /** How many entries carried it, for diagnostics. */
  carriers: number;
} {
  const seen = new Set<string>();
  const buffers: Buffer[] = [];
  let found = false;
  let carriers = 0;

  const take = (value: unknown): boolean => {
    const protos = (value as { fileDescriptorProtos?: unknown } | null)
      ?.fileDescriptorProtos;
    if (!Array.isArray(protos)) return false;
    found = true;
    carriers++;
    for (const raw of protos) {
      if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) continue;
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const key = buffer.toString("base64");
      if (seen.has(key)) continue;
      seen.add(key);
      buffers.push(buffer);
    }
    return true;
  };

  for (const value of Object.values(packageDefinition)) {
    if (!value || typeof value !== "object") continue;
    if (take(value)) continue;
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child && typeof child === "object") take(child);
    }
  }
  return { buffers, found, carriers };
}

/**
 * Reports disagreement between the two views.
 *
 * A service present in one view and absent from the other is not cosmetic: one
 * direction means "listed but not callable", the other means "callable but
 * undescribable". Both used to be invisible.
 */
function crossCheckServices(
  described: string[],
  invocable: string[],
  notes: string[],
): void {
  const describedSet = new Set(described);
  const invocableSet = new Set(invocable);

  const onlyDescribed = described.filter((n) => !invocableSet.has(n));
  const onlyInvocable = invocable.filter((n) => !describedSet.has(n));

  if (onlyDescribed.length > 0) {
    notes.push(
      `${onlyDescribed.length} service(s) are described but not invocable ` +
        `(no codecs were generated): ${onlyDescribed.join(", ")}.`,
    );
  }
  if (onlyInvocable.length > 0) {
    notes.push(
      `${onlyInvocable.length} service(s) are invocable but have no descriptor, ` +
        `so no request template can be generated: ${onlyInvocable.join(", ")}.`,
    );
  }
}

/**
 * Decodes harvested descriptor bytes.
 *
 * A partial failure is a note, because the surviving files still describe real
 * symbols. A total failure is an error: "zero descriptors" and "a healthy
 * catalog" are indistinguishable downstream, and that indistinguishability is
 * what let a whole file's symbols vanish quietly.
 */
function decodeSet(buffers: Buffer[], notes: string[]): DecodedFile[] {
  const files: DecodedFile[] = [];
  const failures: string[] = [];

  for (const buffer of buffers) {
    try {
      files.push(decodeFileDescriptorProto(buffer));
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (failures.length > 0 && files.length === 0) {
    throw new Error(
      `none of the ${buffers.length} FileDescriptorProto(s) attached by ` +
        `@grpc/proto-loader could be decoded, so no method or field metadata ` +
        `is available. First failure: ${failures[0]}`,
    );
  }
  if (failures.length > 0) {
    notes.push(
      `${failures.length} of ${buffers.length} FileDescriptorProto(s) could ` +
        `not be decoded and their symbols are unavailable. ` +
        `First failure: ${failures[0]}`,
    );
  }
  return files;
}

/**
 * Compares what was read from disk against what the descriptors describe.
 *
 * This check can only ever produce a NEGATIVE conclusion — "this .proto
 * contributed no symbols" — and a negative conclusion requires that the
 * evidence be comparable in the first place. It is not, in general:
 * FileDescriptorProto.name is only an import path when protoc produced the
 * descriptor. protobufjs (which synthesises what @grpc/proto-loader attaches)
 * emits a name derived from the *package*, so `proto/common/types.proto`
 * declaring `package demo.common` arrives as `demo_common.proto`. The name is
 * present and non-empty — so no "unnamed" test can catch this — and matches
 * nothing on disk. Suffix-matching against it reported every scanned file as
 * missing while their symbols sat in the table, which is the worst kind of
 * diagnostic: confidently false.
 *
 * So the match rate is what licenses the conclusion:
 *   - zero matches  -> the naming scheme is not filesystem paths. Nothing can
 *                      be concluded about coverage; say only that.
 *   - some matches  -> the names ARE import paths (proven by the ones that
 *                      matched), so the unmatched ones are a real gap and can
 *                      be named.
 *   - all matches   -> silence.
 */
function crossCheckFiles(
  scanned: string[],
  descriptorFiles: string[],
  unnamed: boolean,
  notes: string[],
): void {
  if (descriptorFiles.length === 0) {
    notes.push(
      unnamed
        ? `the descriptors attached by @grpc/proto-loader carry no file names, ` +
            `so symbols cannot be attributed to the .proto they were declared ` +
            `in. This affects diagnostics only.`
        : `no descriptor file names were recovered, so symbols cannot be ` +
            `attributed to their .proto files. This affects diagnostics only.`,
    );
    return;
  }

  // Descriptor names, when genuine, are proto-import paths ("common/types.proto")
  // while scanned paths are absolute. Suffix matching is the only sound
  // comparison — but see above: it is only *meaningful* if something matches.
  const matches = (abs: string): boolean => {
    const normalized = abs.split("\\").join("/");
    return descriptorFiles.some(
      (d) => normalized === d || normalized.endsWith(`/${d}`),
    );
  };

  const missing = scanned.filter((p) => !matches(p));
  if (missing.length === 0) return;

  if (missing.length === scanned.length) {
    // Not a gap: the two sides are not the same kind of name. Reported once, as
    // a limitation, because a user who sees "0 of 2 files matched" must not be
    // sent looking for a loading failure that did not happen.
    notes.push(
      `descriptor file names do not correspond to the .proto paths that were ` +
        `scanned (descriptors report ${descriptorFiles.slice(0, 3).join(", ")}` +
        `${descriptorFiles.length > 3 ? ", …" : ""}), so symbols cannot be ` +
        `attributed to the file that declared them. This is how ` +
        `protobufjs-generated descriptors name files and affects diagnostics ` +
        `only — the symbol table itself is unaffected.`,
    );
    return;
  }

  // Mixed: the naming scheme is demonstrably path-based, so these are real.
  notes.push(
    `${missing.length} of ${scanned.length} scanned .proto file(s) are not ` +
      `represented in the decoded descriptors, so nothing they declare is in ` +
      `the symbol table: ${missing.join(", ")}.`,
  );
}

/* ------------------------------------------------------------------ *
 * Input validation
 * ------------------------------------------------------------------ */

/**
 * Validates the descriptor source before anything is dialled or read.
 *
 * `buildCatalog` is a public entry point, so it owes the caller an explanation
 * rather than delegating it to whichever private helper dereferences the
 * missing field first — that produced `Cannot read properties of undefined
 * (reading 'length')`, which names neither the option nor the fix.
 *
 * `Array.isArray` rather than a truthy `.length`: a bare string has a length,
 * would pass, and would then be iterated character by character.
 */
function assertDescriptorSource(endpoint: GrpcEndpoint): void {
  if (endpoint.reflection === true) return;

  const paths: unknown = endpoint.protoPaths;
  if (paths === undefined || paths === null) {
    throw new Error(
      `a gRPC endpoint needs a descriptor source: either set ` +
        `reflection: true, or pass protoPaths: string[] pointing at your ` +
        `.proto files or directories. Neither was provided.`,
    );
  }
  if (!Array.isArray(paths)) {
    throw new TypeError(
      `protoPaths must be an array of paths; received ` +
        `${
          typeof paths === "string"
            ? `the string "${paths}" — wrap it: ["${paths}"]`
            : typeof paths
        }.`,
    );
  }
  if (paths.length === 0) {
    throw new Error(
      `protoPaths is empty. Pass at least one .proto file or directory, or ` +
        `set reflection: true to obtain descriptors from the server.`,
    );
  }
  const bad = paths.findIndex((p) => typeof p !== "string" || p === "");
  if (bad !== -1) {
    throw new TypeError(
      `protoPaths[${bad}] is not a non-empty string ` +
        `(got ${typeof paths[bad]}).`,
    );
  }

  const include: unknown = endpoint.includeDirs;
  if (include !== undefined && include !== null && !Array.isArray(include)) {
    throw new TypeError(
      `includeDirs must be an array of directories; received ` +
        `${
          typeof include === "string"
            ? `the string "${include}" — wrap it: ["${include}"]`
            : typeof include
        }.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

export async function buildCatalog(
  endpoint: GrpcEndpoint,
): Promise<{ catalog: Catalog; packageDefinition: Record<string, unknown> }> {
  assertDescriptorSource(endpoint);

  const loaded = await loadGrpc();
  const { protoLoader } = loaded;
  const notes: string[] = [];

  let packageDefinition: Record<string, unknown>;
  let fileDescriptors: DecodedFile[];
  let source: "proto" | "reflection";
  let files: string[] | undefined;

  // Narrowed on `reflection`, the discriminant of GrpcDescriptorSource. Each
  // branch therefore sees only the options that belong to it, which is what
  // removes the old "reflection wins, protoPaths ignored" note: that state can
  // no longer be constructed.
  if (endpoint.reflection === true) {
    requireCapability(loaded, "descriptorSetFromBuffer");

    const { credentials, mode, warnings } = buildCredentialsChecked(
      endpoint,
      loaded,
    );
    notes.push(...warnings);

    const reflected = await fetchFullDescriptorSet({
      address: endpoint.address,
      credentials,
      metadata: endpoint.metadata,
      timeoutMs: endpoint.reflectionTimeoutMs ?? 5000,
      channelOptions: endpoint.channelOptions,
      version: endpoint.reflectionVersion,
      host: endpoint.reflectionHost,
      maxFiles: endpoint.maxReflectionFiles,
      maxBytes: endpoint.maxReflectionBytes,
    });
    notes.push(...reflected.notes);

    if (reflected.services.length === 0) {
      throw new Error(
        `reflection is available at ${endpoint.address} (${reflected.version}) ` +
          `but no services are registered on it. Either the server registered ` +
          `only the reflection service itself, or the services you expect were ` +
          `never added to it.`,
      );
    }

    packageDefinition = protoLoader.loadFileDescriptorSetFromBuffer(
      reflected.descriptorSet,
      LOADER_OPTIONS,
    ) as unknown as Record<string, unknown>;

    // The bytes are already in hand here, so this source needs no harvesting.
    // The failure is wrapped: a bare DescriptorDecodeError does not say the
    // bytes came off the wire, which is the one fact that tells the user
    // whether to suspect their proto tree or the server.
    try {
      fileDescriptors = decodeFileDescriptorSet(reflected.descriptorSet);
    } catch (e) {
      if (!(e instanceof DescriptorDecodeError)) throw e;
      throw new Error(
        `reflection at ${endpoint.address} returned ` +
          `${reflected.descriptorSet.length} byte(s) that could not be decoded ` +
          `as a FileDescriptorSet: ${e.message}. The server may be answering ` +
          `the reflection method with a non-standard payload.`,
      );
    }
    if (fileDescriptors.length === 0) {
      throw new Error(
        `reflection at ${endpoint.address} reported ` +
          `${reflected.services.length} service(s) but its descriptor set ` +
          `decoded to zero files, so nothing can be described.`,
      );
    }

    source = "reflection";
    files = reflected.files;
    notes.push(
      `reflection (${reflected.version}, ${mode}) returned ` +
        `${reflected.services.length} service(s) across ` +
        `${reflected.files.length} file(s).`,
    );
  } else {
    // assertDescriptorSource has established that protoPaths is a non-empty
    // array of non-empty strings.
    const protoPaths = endpoint.protoPaths as string[];

    const scan = await scanProtoFiles({
      paths: protoPaths,
      ignoreDirs: endpoint.ignoreDirs,
      followSymlinks: endpoint.followSymlinks,
      maxFiles: endpoint.maxProtoFiles,
    });
    notes.push(...scan.notes);
    files = scan.files;

    // An explicit includeDirs switches the derivation off entirely: the point of
    // passing it is to get protoc's resolution rules, and silently adding to it
    // would defeat that.
    let includeDirs: string[];
    if (
      Array.isArray(endpoint.includeDirs) &&
      endpoint.includeDirs.length > 0
    ) {
      includeDirs = endpoint.includeDirs;
    } else {
      const derived = deriveIncludeDirsDetailed(scan);
      includeDirs = derived.includeDirs;
      notes.push(...derived.notes);
    }

    packageDefinition = (await protoLoader.load(scan.files, {
      ...LOADER_OPTIONS,
      includeDirs,
    })) as unknown as Record<string, unknown>;

    const harvested = harvestFileDescriptors(packageDefinition);
    if (!harvested.found) {
      throw new Error(
        `@grpc/proto-loader did not attach fileDescriptorProtos to any of the ` +
          `${Object.keys(packageDefinition).length} entries it produced, so no ` +
          `method or field metadata can be read. Upgrade to ` +
          `@grpc/proto-loader >= 0.6.0.`,
      );
    }
    if (harvested.buffers.length === 0) {
      // The key existed but held nothing usable. Treating this as success is
      // how an empty symbol table used to masquerade as a working catalog.
      throw new Error(
        `@grpc/proto-loader attached fileDescriptorProtos to ` +
          `${harvested.carriers} entry/entries, but none of them contained ` +
          `descriptor bytes. The loader output cannot be interpreted; this is ` +
          `a version incompatibility rather than a problem with your protos.`,
      );
    }

    fileDescriptors = decodeSet(harvested.buffers, notes);
    source = "proto";

    if (scan.files.length > 1) {
      notes.push(
        `merged ${scan.files.length} .proto file(s) from ` +
          `${protoPaths.length} path(s).`,
      );
    }
  }

  const state: IndexState = {
    symbols: new Map<string, SymbolEntry>(),
    serviceDescriptors: new Map<string, unknown>(),
    mapEntries: new Set<string>(),
    notes,
    unnamedSeq: 0,
  };
  for (const fileDescriptor of fileDescriptors) {
    indexFile(state, fileDescriptor);
  }

  const { symbols, serviceDescriptors, mapEntries } = state;

  const rawNames = fileDescriptors.map((f) => {
    const n = pick<unknown>(f, "name", "name");
    return typeof n === "string" && n !== "" ? n : undefined;
  });
  // Wording only. Coverage is decided by the match rate against scanned paths,
  // not by whether names exist — see crossCheckFiles. The length guard matters
  // because `every` is vacuously true on an empty array, which would report
  // "no descriptor carries a name" when there were no descriptors at all.
  const descriptorFilesUnnamed =
    rawNames.length > 0 && rawNames.every((n) => n === undefined);
  const descriptorFiles = [
    ...new Set(rawNames.filter((n): n is string => n !== undefined)),
  ].sort();

  if (source === "proto" && files) {
    crossCheckFiles(files, descriptorFiles, descriptorFilesUnnamed, notes);
  }
  checkClosure(state);

  const services = [...serviceDescriptors.keys()].sort();
  const invocableServices = collectInvocableServices(packageDefinition, notes);
  crossCheckServices(services, invocableServices, notes);

  if (services.length === 0 && invocableServices.length === 0) {
    notes.push(
      source === "proto"
        ? `the ${files?.length ?? 0} .proto file(s) loaded declare no services.`
        : "reflection returned descriptors that declare no services.",
    );
  }

  return {
    catalog: {
      source,
      symbols,
      services,
      invocableServices,
      serviceDescriptors,
      notes,
      files,
      descriptorFiles,
      mapEntries,
      descriptorFilesUnnamed,
    },
    packageDefinition,
  };
}
