/**
 * Re-export shim: the canonical public type surface lives in "../types".
 * Keeping this path stable means protocol modules can import shared types
 * without knowing where the definition sits, and the single-file rule for
 * public types is preserved.
 */
export * from "../types";
