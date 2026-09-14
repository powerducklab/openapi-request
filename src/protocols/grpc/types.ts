/**
 * Re-export shim for the gRPC type family. The canonical definitions live in
 * "../../types" (the single public type surface); this path stays for the
 * grpc/* modules that import from "./types.js".
 */
export * from "../../types";
