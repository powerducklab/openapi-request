// ── proto-dir.ts ────────────────────────────────────────────────────
import { readdir, realpath, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface CollectProtoOptions {
  paths: string[];
  /** Directory names skipped during traversal. Defaults below. */
  ignoreDirs?: string[];
  /**
   * Follow symlinks. Off by default: a link cycle is common in monorepos and
   * following one silently doubles or hangs the scan. Cycles are detected by
   * real path either way, so enabling this is safe.
   */
  followSymlinks?: boolean;
  /** Cap on files collected, to bound a mistakenly broad root. Default 5000. */
  maxFiles?: number;
}

export interface ProtoScanResult {
  /** Absolute .proto paths, de-duplicated, sorted by byte order. */
  files: string[];
  /** Roots as given, resolved to absolute directories. */
  rootDirs: string[];
  /** Roots that pointed at a single file rather than a tree. */
  fileRoots: string[];
  /** Non-fatal facts: skipped links, unreadable dirs, caps hit. */
  notes: string[];
}

const DEFAULT_IGNORES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".venv",
];
const DEFAULT_MAX_FILES = 5000;

/**
 * Cap on notes. A tree full of symlinks can produce one per entry, and these
 * travel all the way into every result's warnings; a thousand copies of the
 * same sentence buries whatever else that result had to say. The cap itself is
 * reported, so a truncated list never reads as a complete one.
 */
const MAX_NOTES = 40;

function isProtoName(name: string): boolean {
  // Case-insensitive: on a case-insensitive filesystem a mixed-case name exists
  // but would never match a strict suffix test, so the file would vanish.
  return name.toLowerCase().endsWith(".proto");
}

/** Turns an fs error into a sentence that says what to fix. */
function explainFsError(path: string, error: unknown): string {
  const code = (error as { code?: string } | undefined)?.code;
  switch (code) {
    case "ENOENT":
      return `proto path does not exist: ${path}`;
    case "EACCES":
    case "EPERM":
      return `proto path is not readable (permission denied): ${path}`;
    case "ENOTDIR":
      return `a component of the proto path is not a directory: ${path}`;
    case "ELOOP":
      return `proto path contains a symlink loop: ${path}`;
    case "ENAMETOOLONG":
      return `proto path is too long: ${path}`;
    default:
      return (
        `proto path could not be read: ${path}` +
        (code ? ` (${code})` : "") +
        (error instanceof Error ? ` — ${error.message}` : "")
      );
  }
}

/**
 * Validates the options before touching the filesystem.
 *
 * Every one of these mistakes used to surface as a filesystem complaint about a
 * path the caller never wrote: a string passed where an array was expected is
 * iterated character by character, so `paths: "/srv/proto"` reported that "/"
 * does not exist. And `maxFiles: 0` swallowed every file, then threw "no .proto
 * files found", advising a narrower protoPaths — the opposite of the fix.
 */
function assertOptions(options: CollectProtoOptions): void {
  if (!options || typeof options !== "object") {
    throw new TypeError("scanProtoFiles requires an options object.");
  }
  if (!Array.isArray(options.paths)) {
    throw new TypeError(
      `protoPaths must be an array of strings; received ` +
        `${typeof options.paths}. A single path must still be wrapped in an ` +
        `array, or it is iterated one character at a time.`,
    );
  }
  options.paths.forEach((path, i) => {
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError(
        `protoPaths[${i}] must be a non-empty string; received ` +
          `${path === undefined ? "undefined" : typeof path}.`,
      );
    }
  });
  if (options.paths.length === 0) {
    throw new Error("protoPaths is empty; nothing to load.");
  }

  if (options.ignoreDirs !== undefined) {
    if (!Array.isArray(options.ignoreDirs)) {
      throw new TypeError(
        `ignoreDirs must be an array of directory names; received ` +
          `${typeof options.ignoreDirs}.`,
      );
    }
    options.ignoreDirs.forEach((name, i) => {
      if (typeof name !== "string") {
        throw new TypeError(
          `ignoreDirs[${i}] must be a string; received ${typeof name}.`,
        );
      }
      // Names, not paths: the traversal compares against a single path segment,
      // so "src/generated" can never match and would silently do nothing.
      if (name.includes("/") || name.includes("\\")) {
        throw new TypeError(
          `ignoreDirs[${i}] ("${name}") looks like a path, but ignoreDirs ` +
            `matches single directory names only; a path never matches and ` +
            `would be silently ignored.`,
        );
      }
    });
  }

  if (options.maxFiles !== undefined) {
    if (!Number.isInteger(options.maxFiles) || options.maxFiles < 1) {
      throw new TypeError(
        `maxFiles must be a positive integer; received ` +
          `${String(options.maxFiles)}. A cap of 0 would collect nothing and ` +
          `report it as an empty proto tree.`,
      );
    }
  }

  if (
    options.followSymlinks !== undefined &&
    typeof options.followSymlinks !== "boolean"
  ) {
    throw new TypeError(
      `followSymlinks must be a boolean; received ${typeof options.followSymlinks}.`,
    );
  }
}

/**
 * Resolves an entry to file/directory/other when the dirent cannot say.
 *
 * readdir returns DT_UNKNOWN on several filesystems — some network mounts,
 * XFS/overlay in certain configurations — and there both isFile() and
 * isDirectory() answer false. The previous traversal fell off the end of its
 * if-chain in that case, so an entire subtree contributed zero files and zero
 * notes: the scan reported success with a schema that was quietly missing
 * types. One extra stat per unknown entry is the price of not doing that.
 */
async function classifyUnknown(
  path: string,
): Promise<"file" | "dir" | "other" | "error"> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return "dir";
    if (info.isFile()) return "file";
    return "other";
  } catch {
    return "error";
  }
}

/**
 * Expands a mix of files and directories into a de-duplicated, sorted list of
 * absolute .proto paths.
 *
 * The sort is load-order significant: when two files declare the same
 * fully-qualified symbol, proto-loader lets one of them win without complaint,
 * so a stable order is what makes such a conflict reproducible rather than
 * dependent on directory iteration order.
 */
export async function scanProtoFiles(
  options: CollectProtoOptions,
): Promise<ProtoScanResult> {
  assertOptions(options);

  const ignore = new Set(options.ignoreDirs ?? DEFAULT_IGNORES);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const files = new Set<string>();
  const rootDirs: string[] = [];
  const fileRoots: string[] = [];
  const notes: string[] = [];
  /** Real paths of directories already walked, so symlink cycles terminate. */
  const visitedDirs = new Set<string>();
  /**
   * Real paths of files already collected. Directories were de-duplicated by
   * real path but files were not, so with followSymlinks on, a link to a shared
   * definitions tree yielded the same .proto under two absolute paths.
   * proto-loader then loaded it twice and the catalog reported "duplicate
   * definition of demo.common.Meta" — blaming the schema for a scanner bug.
   */
  const visitedFiles = new Map<string, string>();
  let capped = false;
  let notesDropped = 0;

  const note = (message: string): void => {
    if (notes.length >= MAX_NOTES) {
      notesDropped++;
      return;
    }
    notes.push(message);
  };

  /**
   * Records a file. `viaLink` distinguishes a genuine duplicate reachable two
   * ways from the ordinary case, so the note only appears when it is actionable.
   */
  const addFile = async (abs: string, viaLink: boolean): Promise<void> => {
    if (files.has(abs)) return;
    if (files.size >= maxFiles) {
      if (!capped) {
        capped = true;
        note(
          `stopped after ${maxFiles} .proto files; pass maxFiles or a narrower ` +
            `protoPaths if the tree really is this large. The file set is ` +
            `truncated, so symbols may be missing.`,
        );
      }
      return;
    }

    // Only pay for realpath when links are in play; without them two distinct
    // paths cannot name one file, and the syscall would be pure overhead on
    // every file in the tree.
    if (viaLink || options.followSymlinks) {
      let real: string;
      try {
        real = await realpath(abs);
      } catch (error) {
        note(explainFsError(abs, error));
        return;
      }
      const seen = visitedFiles.get(real);
      if (seen !== undefined) {
        if (seen !== abs) {
          note(
            `skipped ${abs}: it is the same file as ${seen} (both resolve to ` +
              `${real}). Loading it twice would be reported as a duplicate ` +
              `symbol definition.`,
          );
        }
        return;
      }
      visitedFiles.set(real, abs);
    }

    files.add(abs);
  };

  const walkDir = async (abs: string, viaLink: boolean): Promise<void> => {
    let real: string;
    try {
      real = await realpath(abs);
    } catch (error) {
      note(explainFsError(abs, error));
      return;
    }
    if (visitedDirs.has(real)) {
      if (viaLink) {
        note(
          `skipped ${abs}: it resolves to ${real}, which was already scanned.`,
        );
      }
      return;
    }
    visitedDirs.add(real);

    // Annotated explicitly: readdir has a Buffer-returning overload, and
    // inferring from ReturnType picks it, which types entry.name as a Buffer.
    let entries: Dirent[];
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (error) {
      // One unreadable subdirectory must not void the whole scan; the files we
      // did find are still usable, and the gap is reported.
      note(explainFsError(abs, error));
      return;
    }

    for (const entry of entries) {
      if (capped) return;
      const child = join(abs, entry.name);

      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) {
          note(
            `skipped symlink ${child} (followSymlinks is off). If your proto ` +
              `tree links to shared definitions, enable followSymlinks or add ` +
              `the target to protoPaths.`,
          );
          continue;
        }
        let info: Stats;
        try {
          info = await stat(child);
        } catch (error) {
          note(explainFsError(child, error));
          continue;
        }
        if (info.isDirectory()) {
          if (!ignore.has(entry.name)) await walkDir(child, true);
        } else if (info.isFile() && isProtoName(entry.name)) {
          await addFile(resolve(child), true);
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (!ignore.has(entry.name)) await walkDir(child, viaLink);
        continue;
      }
      if (entry.isFile()) {
        if (isProtoName(entry.name)) await addFile(resolve(child), viaLink);
        continue;
      }

      // Neither link, dir, nor file: either a device/socket/fifo, or — the case
      // that matters — a filesystem that answered DT_UNKNOWN. Sockets and the
      // like are never .proto files, so only named candidates and directories
      // are worth a stat.
      if (
        entry.isFIFO() ||
        entry.isSocket() ||
        entry.isBlockDevice() ||
        entry.isCharacterDevice()
      ) {
        continue;
      }
      const kind = await classifyUnknown(child);
      if (kind === "dir") {
        if (!ignore.has(entry.name)) await walkDir(child, viaLink);
      } else if (kind === "file") {
        if (isProtoName(entry.name)) await addFile(resolve(child), viaLink);
      } else if (kind === "error" && isProtoName(entry.name)) {
        // Only worth reporting for something that looked like a proto: an
        // unreadable socket is noise, an unreadable .proto is a missing symbol.
        note(
          `could not determine the type of ${child}; it was skipped even ` +
            `though its name suggests a proto file.`,
        );
      }
    }
  };

  for (const path of options.paths) {
    const abs = resolve(path);
    let info: Stats;
    try {
      info = await stat(abs);
    } catch (error) {
      // A root that cannot be read is fatal: the caller named it explicitly, so
      // silently producing a smaller file set would be answering a different
      // question than the one asked.
      throw new Error(explainFsError(path, error), { cause: error });
    }

    if (info.isFile()) {
      if (!isProtoName(abs)) {
        throw new Error(
          `not a .proto file: ${path}. protoPaths accepts .proto files and ` +
            `directories containing them.`,
        );
      }
      await addFile(abs, false);
      if (!fileRoots.includes(abs)) fileRoots.push(abs);
      continue;
    }
    if (!info.isDirectory()) {
      throw new Error(`proto path is neither a file nor a directory: ${path}`);
    }
    if (!rootDirs.includes(abs)) rootDirs.push(abs);
    await walkDir(abs, false);
  }

  if (notesDropped > 0) {
    notes.push(
      `${notesDropped} further scan note(s) were suppressed; the ones above ` +
        `are representative.`,
    );
  }

  if (files.size === 0) {
    const hint = notes.length
      ? ` Some entries were skipped: ${notes[0]}`
      : ` Checked for *.proto, skipping ${[...ignore].join(", ")}.`;
    throw new Error(
      `no .proto files found under: ${options.paths.join(", ")}.${hint}`,
    );
  }

  return { files: [...files].sort(), rootDirs, fileRoots, notes };
}

/** Back-compatible shape for callers that only want the paths. */
export async function collectProtoFiles(
  options: CollectProtoOptions,
): Promise<string[]> {
  return (await scanProtoFiles(options)).files;
}

export interface IncludeDirsResult {
  includeDirs: string[];
  notes: string[];
}

function isUnder(child: string, parent: string): boolean {
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(p);
}

/**
 * Derives include dirs so that `import "common/types.proto"` resolves.
 *
 * A bare directory scan without this loads files that cannot resolve their own
 * imports. But note what the fallback costs: adding every containing directory
 * makes `import "types.proto"` resolve from any directory in the tree, so a
 * proto that `protoc -I <root>` would reject can load here. That is a guess in
 * the user's favour, and guesses that loosen resolution have to be announced —
 * otherwise this library reports a proto tree as healthy when the real build
 * will fail. Pass includeDirs explicitly to switch the guess off.
 */
export function deriveIncludeDirsDetailed(
  scan: ProtoScanResult,
): IncludeDirsResult {
  const notes: string[] = [];
  const includeDirs = new Set<string>();

  for (const dir of scan.rootDirs) includeDirs.add(dir);
  // A root that names a single file contributes its parent, not itself: a file
  // path is not a search root, and adding one silently does nothing.
  for (const file of scan.fileRoots) includeDirs.add(dirname(file));

  const roots = [...includeDirs];
  const extra: string[] = [];
  for (const file of scan.files) {
    const dir = dirname(file);
    if (roots.some((root) => isUnder(dir, root))) continue;
    if (includeDirs.has(dir)) continue;
    includeDirs.add(dir);
    extra.push(dir);
  }

  if (extra.length > 0) {
    notes.push(
      `${extra.length} directory(ies) outside the given protoPaths were added ` +
        `as include roots so their imports resolve: ` +
        `${extra.slice(0, 3).join(", ")}${extra.length > 3 ? ", …" : ""}. ` +
        `Imports are therefore resolved more loosely than protoc would; ` +
        `pass includeDirs explicitly for exact behaviour.`,
    );
  }

  return { includeDirs: [...includeDirs].sort(), notes };
}

/** Back-compatible signature. Prefer the detailed variant to keep the notes. */
export function deriveIncludeDirs(
  protoFiles: string[],
  roots: string[],
): string[] {
  const rootDirs: string[] = [];
  const fileRoots: string[] = [];
  for (const root of roots) {
    const abs = resolve(root);
    if (isProtoName(abs)) fileRoots.push(abs);
    else rootDirs.push(abs);
  }
  return deriveIncludeDirsDetailed({
    files: protoFiles,
    rootDirs,
    fileRoots,
    notes: [],
  }).includeDirs;
}
