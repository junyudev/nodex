import type { Dirent } from "node:fs";
import { copyFile, open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type {
  WorkspaceDirectoryEntriesInput,
  WorkspaceDirectoryEntriesResult,
  WorkspaceFileBinaryReadResult,
  WorkspaceFileDirectoryEntry,
  WorkspaceFileMetadata,
  WorkspaceFileMetadataInput,
  WorkspaceFileReadResult,
  WorkspaceFileRequest,
  WorkspaceFileSearchInput,
  WorkspaceFileSearchMatch,
  WorkspaceFileSearchResult,
  WorkspaceFileTextReadInput,
  WorkspaceFileWriteInput,
  WorkspaceFileWriteResult,
} from "../shared/types";

const DEFAULT_CONTENT_SAMPLE_BYTES = 8_192;
const DEFAULT_SEARCH_MAX_RESULTS = 200;
const DEFAULT_SEARCH_MAX_VISITED_ENTRIES = 100_000;
const EXPECTED_FILE_SYSTEM_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EDQUOT",
  "EISDIR",
  "ELOOP",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
]);

export type WorkspaceFileUserErrorCode =
  | "invalid_directory"
  | "invalid_path"
  | "not_found"
  | "outside_workspace"
  | "too_large"
  | "unauthorized_sender"
  | "unsupported_host";

export class WorkspaceFileUserError extends Error {
  readonly code: WorkspaceFileUserErrorCode;

  constructor(code: WorkspaceFileUserErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceFileUserError";
    this.code = code;
  }
}

function readErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

export function toWorkspaceFileIpcError(error: unknown): unknown {
  if (error instanceof WorkspaceFileUserError) return error;
  if (error instanceof Error && error.name === "ZodError") {
    return new WorkspaceFileUserError("invalid_path", error.message, { cause: error });
  }
  const code = readErrorCode(error);
  if (!code || !EXPECTED_FILE_SYSTEM_ERROR_CODES.has(code)) return error;
  const message = error instanceof Error ? error.message : "Unable to access file";
  return new WorkspaceFileUserError(code === "ENOENT" ? "not_found" : "invalid_path", message, {
    cause: error,
  });
}

function normalizeHostId(value: WorkspaceFileHostInput): "local" {
  if (value && value !== "local") {
    throw new WorkspaceFileUserError(
      "unsupported_host",
      `Unsupported workspace file host: ${value}`,
    );
  }
  return "local";
}

type WorkspaceFileHostInput = WorkspaceDirectoryEntriesInput["hostId"];

function normalizeAbsolutePath(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new WorkspaceFileUserError("invalid_path", `${label} is required`);
  }
  return resolve(trimmed);
}

export function normalizeWorkspaceDirectoryPath(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === ".") return "";
  if (isAbsolute(trimmed) || win32.isAbsolute(trimmed)) {
    throw new WorkspaceFileUserError(
      "invalid_directory",
      "directoryPath must be relative to workspaceRoot",
    );
  }
  return trimmed
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function isPathInsideRoot(workspaceRoot: string, targetPath: string): boolean {
  const pathFromRoot = relative(workspaceRoot, targetPath);
  return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

function assertPathInsideRoot(workspaceRoot: string, targetPath: string): void {
  if (isPathInsideRoot(workspaceRoot, targetPath)) return;
  throw new WorkspaceFileUserError(
    "outside_workspace",
    "directoryPath must stay within workspaceRoot",
  );
}

function toCanonicalRelativePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function getParentDirectoryPath(directoryPath: string): string | null {
  if (!directoryPath) return null;
  const parts = directoryPath.split("/").filter(Boolean);
  return parts.length === 1 ? "" : parts.slice(0, -1).join("/");
}

async function resolveWorkspaceDirectory(input: WorkspaceDirectoryEntriesInput): Promise<{
  directoryPath: string;
  realWorkspaceRoot: string;
  resolvedDirectoryPath: string;
  resolvedWorkspaceRoot: string;
}> {
  normalizeHostId(input.hostId);
  const resolvedWorkspaceRoot = normalizeAbsolutePath(input.workspaceRoot, "workspaceRoot");
  const requestedDirectoryPath = normalizeWorkspaceDirectoryPath(input.directoryPath);
  const resolvedDirectoryPath = resolve(resolvedWorkspaceRoot, requestedDirectoryPath);
  const directoryPath = toCanonicalRelativePath(
    relative(resolvedWorkspaceRoot, resolvedDirectoryPath),
  );
  assertPathInsideRoot(resolvedWorkspaceRoot, resolvedDirectoryPath);

  const workspaceStats = await stat(resolvedWorkspaceRoot);
  if (!workspaceStats.isDirectory()) {
    throw new WorkspaceFileUserError("invalid_directory", "workspaceRoot must be a directory");
  }

  const realWorkspaceRoot = await realpath(resolvedWorkspaceRoot);
  const realDirectoryPath = await realpath(resolvedDirectoryPath);
  assertPathInsideRoot(realWorkspaceRoot, realDirectoryPath);

  const directoryStats = await stat(resolvedDirectoryPath);
  if (!directoryStats.isDirectory()) {
    throw new WorkspaceFileUserError(
      "invalid_directory",
      "directoryPath must point to a directory",
    );
  }

  return {
    directoryPath,
    realWorkspaceRoot,
    resolvedDirectoryPath,
    resolvedWorkspaceRoot,
  };
}

function scoreWorkspaceFileSearchMatch(path: string, normalizedQuery: string): number | null {
  const normalizedPath = path.toLocaleLowerCase();
  const normalizedName = basename(path).toLocaleLowerCase();
  if (normalizedName === normalizedQuery) return 0;
  if (normalizedName.startsWith(normalizedQuery)) return 10 + normalizedName.length;
  const nameIndex = normalizedName.indexOf(normalizedQuery);
  if (nameIndex >= 0) return 100 + nameIndex * 4 + normalizedName.length;
  const pathIndex = normalizedPath.indexOf(normalizedQuery);
  if (pathIndex < 0) return null;
  return 1_000 + pathIndex * 2 + normalizedPath.length;
}

function addWorkspaceFileSearchAncestors(path: string, target: Set<string>): void {
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    target.add(segments.slice(0, index).join("/"));
  }
}

export async function searchWorkspaceFiles(
  input: WorkspaceFileSearchInput,
): Promise<WorkspaceFileSearchResult> {
  const normalizedQuery = input.query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return { matches: [], ancestorDirectories: [], truncated: false };
  }

  const maxResults = input.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS;
  const maxVisitedEntries = input.maxVisitedEntries ?? DEFAULT_SEARCH_MAX_VISITED_ENTRIES;
  const root = await resolveWorkspaceDirectory({
    hostId: input.hostId,
    workspaceRoot: input.workspaceRoot,
    directoryPath: "",
    includeHidden: true,
  });
  const queue: Array<{ directoryPath: string; resolvedPath: string }> = [
    {
      directoryPath: "",
      resolvedPath: root.resolvedDirectoryPath,
    },
  ];
  const matches: WorkspaceFileSearchMatch[] = [];
  const ancestorDirectories = new Set<string>();
  const visitedRealDirectories = new Set<string>([root.realWorkspaceRoot]);
  let visitedEntries = 0;
  let truncated = false;
  let traversalLimitReached = false;
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const directory = queue[queueIndex];
    queueIndex += 1;
    if (!directory) break;
    const entries = await readdir(directory.resolvedPath, { withFileTypes: true }).catch(
      (error: unknown) => {
        const code = readErrorCode(error);
        if (code && EXPECTED_FILE_SYSTEM_ERROR_CODES.has(code)) return [];
        throw error;
      },
    );
    entries.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );

    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > maxVisitedEntries) {
        truncated = true;
        traversalLimitReached = true;
        break;
      }

      const relativePath = directory.directoryPath
        ? `${directory.directoryPath}/${entry.name}`
        : entry.name;
      const resolvedPath = join(directory.resolvedPath, entry.name);
      const mappedEntry = await mapDirectoryEntry({
        entry,
        realWorkspaceRoot: root.realWorkspaceRoot,
        resolvedDirectoryPath: directory.resolvedPath,
        resolvedWorkspaceRoot: root.resolvedWorkspaceRoot,
      });
      if (!mappedEntry) continue;

      if (mappedEntry.type === "directory") {
        const realDirectoryPath = await realpath(resolvedPath).catch(() => null);
        if (!realDirectoryPath || visitedRealDirectories.has(realDirectoryPath)) continue;
        visitedRealDirectories.add(realDirectoryPath);
        queue.push({ directoryPath: relativePath, resolvedPath });
        continue;
      }

      const score = scoreWorkspaceFileSearchMatch(relativePath, normalizedQuery);
      if (score === null) continue;
      matches.push({ path: relativePath, kind: "file", score });
      matches.sort(
        (left, right) => left.score - right.score || left.path.localeCompare(right.path),
      );
      if (matches.length > maxResults) {
        matches.pop();
        truncated = true;
      }
    }
    if (traversalLimitReached) break;
  }

  for (const match of matches) {
    addWorkspaceFileSearchAncestors(match.path, ancestorDirectories);
  }
  return {
    matches,
    ancestorDirectories: [...ancestorDirectories].sort(),
    truncated,
  };
}

async function mapDirectoryEntry(input: {
  entry: Dirent;
  realWorkspaceRoot: string;
  resolvedDirectoryPath: string;
  resolvedWorkspaceRoot: string;
}): Promise<WorkspaceFileDirectoryEntry | null> {
  const entryPath = join(input.resolvedDirectoryPath, input.entry.name);
  const isSymlink = input.entry.isSymbolicLink();
  let type: WorkspaceFileDirectoryEntry["type"] = input.entry.isDirectory() ? "directory" : "file";

  if (isSymlink) {
    const entryStats = await stat(entryPath).catch(() => null);
    if (entryStats?.isDirectory()) {
      const realEntryPath = await realpath(entryPath).catch(() => null);
      if (!realEntryPath || !isPathInsideRoot(input.realWorkspaceRoot, realEntryPath)) return null;
      type = "directory";
    }
  }

  return {
    isSymlink,
    name: input.entry.name,
    path: toCanonicalRelativePath(relative(input.resolvedWorkspaceRoot, entryPath)),
    type,
  };
}

function sortDirectoryEntries(
  left: WorkspaceFileDirectoryEntry,
  right: WorkspaceFileDirectoryEntry,
): number {
  if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
}

export async function listWorkspaceDirectoryEntries(
  input: WorkspaceDirectoryEntriesInput,
): Promise<WorkspaceDirectoryEntriesResult> {
  const resolved = await resolveWorkspaceDirectory(input);
  const directoryEntries = await readdir(resolved.resolvedDirectoryPath, { withFileTypes: true });
  const visibleEntries = directoryEntries.filter(
    (entry) => input.includeHidden === true || !entry.name.startsWith("."),
  );
  const mappedEntries = await Promise.all(
    visibleEntries.map((entry) =>
      mapDirectoryEntry({
        entry,
        realWorkspaceRoot: resolved.realWorkspaceRoot,
        resolvedDirectoryPath: resolved.resolvedDirectoryPath,
        resolvedWorkspaceRoot: resolved.resolvedWorkspaceRoot,
      }),
    ),
  );
  const entries = mappedEntries
    .filter((entry): entry is WorkspaceFileDirectoryEntry => entry !== null)
    .filter((entry) => input.directoriesOnly !== true || entry.type === "directory")
    .sort(sortDirectoryEntries);

  return {
    directoryPath: resolved.directoryPath,
    entries,
    parentPath: getParentDirectoryPath(resolved.directoryPath),
  };
}

function resolveFileRequestPath(input: WorkspaceFileRequest): string {
  normalizeHostId(input.hostId);
  return normalizeAbsolutePath(input.path, "File path");
}

function isProbablyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  if (buffer.includes(0)) return true;

  let suspicious = 0;
  for (const byte of buffer) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte >= 32) continue;
    suspicious += 1;
  }
  return suspicious / buffer.length > 0.08;
}

async function readFileSample(filePath: string, byteLimit: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(byteLimit);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

function detectMimeType(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const prefix = bytes.subarray(0, 12).toString("ascii");
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "image/gif";
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") return "image/webp";
  if (prefix.startsWith("%PDF-")) return "application/pdf";
  if (prefix.startsWith("BM")) return "image/bmp";

  const textPrefix = bytes
    .subarray(0, 1_024)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (
    textPrefix.startsWith("<svg") ||
    (textPrefix.startsWith("<?xml") && textPrefix.includes("<svg"))
  ) {
    return "image/svg+xml";
  }
  return undefined;
}

export async function readWorkspaceFile(
  input: WorkspaceFileTextReadInput,
): Promise<WorkspaceFileReadResult> {
  const filePath = resolveFileRequestPath(input);
  const handle = await open(filePath, "r");
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) {
      throw new WorkspaceFileUserError("invalid_path", `${filePath} is not a file`);
    }
    if (fileStats.size > input.maxBytes) {
      throw new WorkspaceFileUserError(
        "too_large",
        `${basename(filePath)} exceeds the ${input.maxBytes.toLocaleString()} byte text limit`,
      );
    }

    const buffer = Buffer.alloc(input.maxBytes + 1);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead > input.maxBytes) {
      throw new WorkspaceFileUserError(
        "too_large",
        `${basename(filePath)} changed while reading and now exceeds the text limit`,
      );
    }
    return { contents: buffer.subarray(0, result.bytesRead).toString("utf8") };
  } finally {
    await handle.close();
  }
}

export async function readWorkspaceFileMetadata(
  input: WorkspaceFileMetadataInput,
): Promise<WorkspaceFileMetadata> {
  const filePath = resolveFileRequestPath(input);
  const fileStats = await stat(filePath);
  const isFile = fileStats.isFile();
  const shouldReadSample =
    input.contentSampleByteLimit !== undefined &&
    isFile &&
    (input.contentSampleMaxFileBytes === undefined ||
      fileStats.size <= input.contentSampleMaxFileBytes);
  const contentSampleByteLimit = input.contentSampleByteLimit ?? DEFAULT_CONTENT_SAMPLE_BYTES;
  const sample = shouldReadSample ? await readFileSample(filePath, contentSampleByteLimit) : null;
  const mimeType = sample === null ? undefined : detectMimeType(sample);

  return {
    isFile,
    createdAtMs: fileStats.birthtimeMs > 0 ? fileStats.birthtimeMs : null,
    mtimeMs: Number.isFinite(fileStats.mtimeMs) ? fileStats.mtimeMs : null,
    sizeBytes: Number.isFinite(fileStats.size) ? fileStats.size : null,
    ...(sample === null
      ? {}
      : {
          contentKind: isProbablyBinary(sample) ? "binary" : "text",
          ...(mimeType ? { mimeType } : {}),
        }),
  };
}

export async function readWorkspaceFileBinary(
  input: WorkspaceFileRequest,
): Promise<WorkspaceFileBinaryReadResult> {
  const filePath = resolveFileRequestPath(input);
  const bytes = await readFile(filePath);
  const mimeType = detectMimeType(bytes);
  return {
    contentsBase64: bytes.toString("base64"),
    ...(mimeType === undefined ? {} : { mimeType }),
  };
}

/** Copies bytes only after a native destination picker; selecting the source is a no-op. */
export async function saveWorkspaceFileCopy(
  input: WorkspaceFileRequest,
  selectDestination: (defaultPath: string) => Promise<string | null>,
): Promise<{ path: string | null }> {
  const source = resolveFileRequestPath(input);
  const sourceStats = await stat(source);
  if (!sourceStats.isFile())
    throw new WorkspaceFileUserError("invalid_path", `${source} is not a file`);
  const destination = await selectDestination(basename(source));
  if (!destination) return { path: null };
  if (resolve(destination) === source) return { path: destination };
  const destinationStats = await stat(destination).catch((error: unknown) => {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (destinationStats?.dev === sourceStats.dev && destinationStats.ino === sourceStats.ino)
    return { path: destination };
  await copyFile(source, destination);
  return { path: destination };
}

export async function writeWorkspaceFile(
  input: WorkspaceFileWriteInput,
): Promise<WorkspaceFileWriteResult> {
  const filePath = resolveFileRequestPath(input);
  const currentStats = await stat(filePath).catch((error: unknown) => {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  const currentMtimeMs =
    currentStats && Number.isFinite(currentStats.mtimeMs) ? currentStats.mtimeMs : null;
  if (currentMtimeMs !== input.expectedMtimeMs) {
    return { outcome: "conflict", mtimeMs: currentMtimeMs };
  }

  await writeFile(filePath, input.content, "utf8");
  const savedStats = await stat(filePath);
  return {
    outcome: "saved",
    mtimeMs: Number.isFinite(savedStats.mtimeMs) ? savedStats.mtimeMs : null,
  };
}
