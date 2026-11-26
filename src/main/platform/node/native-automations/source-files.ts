// @effect-diagnostics asyncFunction:off -- Filesystem reads are the Node capability boundary.
import { opendir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type {
  NativeAutomationCandidate,
  NativeAutomationOrigin,
} from "../../../../shared/native-automation-import";
import { openRegularFile } from "../open-regular-file";

export const NATIVE_AUTOMATION_TASK_LIMIT = 200;
export const NATIVE_AUTOMATION_DIRECTORY_SCAN_LIMIT = 20_000;
export const NATIVE_AUTOMATION_TEXT_LIMIT = 2 * 1024 * 1024;

type NativeAutomationStore =
  | "codex-home"
  | "codex-database"
  | "codex-legacy"
  | "codex-memory"
  | "codex-runs"
  | "claude-desktop"
  | "claude-history"
  | "claude-tasks"
  | "claude-skill"
  | "claude-runs";

export type NativeAutomationReadReason = "missing" | "unreadable" | "invalid" | "limit";

export interface NativeAutomationReadIssue {
  readonly store: NativeAutomationStore;
  readonly reason: NativeAutomationReadReason;
  readonly sourceHome: NativeAutomationOrigin["sourceHome"];
}

export interface NativeAutomationReadResult {
  readonly candidates: readonly NativeAutomationCandidate[];
  readonly issues: readonly NativeAutomationReadIssue[];
}

export function sourceReadReason(error: unknown): "missing" | "unreadable" {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
    ? "missing"
    : "unreadable";
}

/** Coalesce row-level failures without exposing prompts, titles, or external error messages. */
export function reportSourceIssues(sourceHome: string, issues: NativeAutomationReadIssue[]) {
  const seen = new Set<string>();
  return (store: NativeAutomationStore, reason: NativeAutomationReadReason) => {
    const key = `${store}:${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ store, reason, sourceHome });
  };
}

export async function sourceEntries(input: {
  readonly directory: string;
  readonly accept: (entry: Dirent) => boolean;
  readonly signal: AbortSignal;
  readonly maxEntries?: number;
}) {
  const entries: string[] = [];
  const maxEntries = input.maxEntries ?? NATIVE_AUTOMATION_DIRECTORY_SCAN_LIMIT;
  let scanned = 0;
  for await (const entry of await opendir(input.directory)) {
    input.signal.throwIfAborted();
    if (scanned++ >= maxEntries) return { entries, limited: true, scanned: maxEntries };
    if (input.accept(entry)) entries.push(join(input.directory, entry.name));
  }
  return { entries, limited: false, scanned };
}

/** Open one regular file and read at most its observed size, even if it grows. */
export async function readSourceText(filePath: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const file = await openRegularFile(filePath);
  try {
    const before = await file.stat({ bigint: true });
    if (before.size > BigInt(NATIVE_AUTOMATION_TEXT_LIMIT)) return null;
    const size = Number(before.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
      if (!bytesRead) throw new Error("The source file shrank during the read");
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error("The source file changed during the read");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await file.close();
  }
}
