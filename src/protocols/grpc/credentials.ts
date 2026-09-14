import { loadGrpc, type LoadedGrpc } from "./loader.js";
import type { GrpcCredentialsOptions } from "./types.js";

/** Reported alongside a result so a relaxed check is never silent. */
export interface CredentialsBuildResult {
  credentials: import("@grpc/grpc-js").ChannelCredentials;
  /**
   * What was actually built, derived from the inputs rather than from intent:
   * "tls-system-roots" is also what you get from `tls: { skipHostnameVerification: true }`
   * with no rootCerts, which is a very different configuration than it looks.
   */
  mode: "insecure" | "tls-system-roots" | "tls-custom-roots" | "mtls";
  warnings: string[];
}

function assertBuffer(value: unknown, field: string): Buffer | null {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") {
    throw new TypeError(
      `tls.${field} must be PEM bytes, not a string. ` +
        `A file path is not accepted — read it first, e.g. ` +
        `await readFile(path). Passing a path would fail later during the ` +
        `handshake with an unrelated error.`,
    );
  }
  throw new TypeError(
    `tls.${field} must be a Buffer or Uint8Array of PEM bytes; ` +
      `received ${typeof value}.`,
  );
}

/**
 * Builds channel credentials, reporting what was actually built.
 *
 * The reported mode is derived from the inputs rather than from the caller's
 * intent, so a config that silently degrades to system roots (or to plaintext)
 * is visible in the result instead of being discovered at the first failed
 * handshake.
 */
export function buildCredentialsChecked(
  source: GrpcCredentialsOptions,
  { grpc }: LoadedGrpc,
): CredentialsBuildResult {
  const warnings: string[] = [];
  const tls = source.tls;

  if (tls === undefined || tls === false) {
    return {
      credentials: grpc.credentials.createInsecure(),
      mode: "insecure",
      warnings,
    };
  }

  if (tls === true) {
    return {
      credentials: grpc.credentials.createSsl(),
      mode: "tls-system-roots",
      warnings,
    };
  }

  const root = assertBuffer(tls.rootCerts, "rootCerts");
  const key = assertBuffer(tls.privateKey, "privateKey");
  const chain = assertBuffer(tls.certChain, "certChain");

  // Client certificates are only meaningful as a pair; grpc-js accepts one
  // alone and then fails opaquely during the handshake.
  if ((key === null) !== (chain === null)) {
    throw new Error(
      `mutual TLS requires both tls.privateKey and tls.certChain; ` +
        `only ${key ? "privateKey" : "certChain"} was provided.`,
    );
  }

  const mode: CredentialsBuildResult["mode"] =
    key !== null
      ? "mtls"
      : root !== null
        ? "tls-custom-roots"
        : "tls-system-roots";

  if (tls.skipHostnameVerification) {
    warnings.push(
      "skipHostnameVerification is on: the server certificate chain is still " +
        "verified, but its hostname is not checked against the address. " +
        "This permits connecting to an impostor holding any trusted " +
        "certificate. Use it for local debugging only.",
    );
    return {
      credentials: grpc.credentials.createSsl(root, key, chain, {
        // Returning undefined signals "identity accepted". Only the hostname
        // check is bypassed; chain validation is unaffected.
        checkServerIdentity: () => undefined,
      }),
      mode,
      warnings,
    };
  }

  return {
    credentials: grpc.credentials.createSsl(root, key, chain),
    mode,
    warnings,
  };
}

/**
 * Convenience wrapper for call sites that have nowhere to put warnings.
 *
 * Prefer `buildCredentialsChecked` anywhere the warnings can reach the user;
 * dropping them is a deliberate loss, not a free simplification.
 */
export function buildCredentials(
  source: GrpcCredentialsOptions,
  loaded: LoadedGrpc,
): import("@grpc/grpc-js").ChannelCredentials {
  return buildCredentialsChecked(source, loaded).credentials;
}

export async function buildCredentialsAsync(
  source: GrpcCredentialsOptions,
): Promise<import("@grpc/grpc-js").ChannelCredentials> {
  return buildCredentials(source, await loadGrpc());
}

export async function buildCredentialsCheckedAsync(
  source: GrpcCredentialsOptions,
): Promise<CredentialsBuildResult> {
  return buildCredentialsChecked(source, await loadGrpc());
}
