import * as Predicate from "effect/Predicate";
import type { FileSearchIncomplete, FileSearchResult } from "../../shared/file-search";

/** Main and the worker ship in one bundle, so the message shapes change together. */
export interface FileIndexWorkerData {
  readonly epoch: number;
  /** The verified ripgrep executable Main resolved for this computer. */
  readonly ripgrepPath: string;
  readonly environment: Readonly<Record<string, string>>;
}

export type FileIndexWorkerHostMessage =
  | {
      readonly type: "open";
      readonly sessionId: string;
      readonly roots: readonly string[];
    }
  | {
      /** An empty query stops the session's ranking without a reply. */
      readonly type: "query";
      readonly sessionId: string;
      readonly seq: number;
      readonly query: string;
    }
  | { readonly type: "close"; readonly sessionId: string }
  | { readonly type: "shutdown" };

export type FileIndexSessionOutcome =
  | { readonly kind: "updated"; readonly files: readonly FileSearchResult[] }
  | { readonly kind: "completed"; readonly incomplete?: FileSearchIncomplete };

export type FileIndexWorkerThreadMessage =
  | { readonly type: "ready"; readonly epoch: number }
  | {
      readonly type: "session";
      readonly sessionId: string;
      /** The query sequence number this outcome answers. */
      readonly seq: number;
      readonly outcome: FileIndexSessionOutcome;
    };

const isSequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isSessionId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;

function isResult(value: unknown): value is FileSearchResult {
  return (
    Predicate.isObject(value) &&
    typeof value.root === "string" &&
    typeof value.path === "string" &&
    typeof value.file_name === "string" &&
    (value.match_type === "file" || value.match_type === "directory") &&
    typeof value.score === "number" &&
    (value.indices === null || Array.isArray(value.indices))
  );
}

function isOutcome(value: unknown): value is FileIndexSessionOutcome {
  if (!Predicate.isObject(value)) return false;
  if (value.kind === "completed") {
    const incomplete = value.incomplete;
    if (incomplete === undefined) return true;
    return (
      Predicate.isObject(incomplete) &&
      (incomplete.reason === "too-large" ||
        incomplete.reason === "missing" ||
        incomplete.reason === "unreadable" ||
        incomplete.reason === "unavailable") &&
      (incomplete.root === undefined || typeof incomplete.root === "string")
    );
  }
  return value.kind === "updated" && Array.isArray(value.files) && value.files.every(isResult);
}

export function isFileIndexWorkerHostMessage(value: unknown): value is FileIndexWorkerHostMessage {
  if (!Predicate.isObject(value)) return false;
  switch (value.type) {
    case "open":
      return (
        isSessionId(value.sessionId) &&
        Array.isArray(value.roots) &&
        value.roots.length > 0 &&
        value.roots.every((root) => typeof root === "string" && root.length > 0)
      );
    case "query":
      return (
        isSessionId(value.sessionId) && isSequence(value.seq) && typeof value.query === "string"
      );
    case "close":
      return isSessionId(value.sessionId);
    case "shutdown":
      return true;
    default:
      return false;
  }
}

export function isFileIndexWorkerThreadMessage(
  value: unknown,
): value is FileIndexWorkerThreadMessage {
  if (!Predicate.isObject(value)) return false;
  if (value.type === "ready")
    return typeof value.epoch === "number" && Number.isSafeInteger(value.epoch) && value.epoch >= 1;
  return (
    value.type === "session" &&
    isSessionId(value.sessionId) &&
    isSequence(value.seq) &&
    isOutcome(value.outcome)
  );
}
