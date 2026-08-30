import type { components } from "@nodex/core-protocol";
import type { LocalCommitCommandSuccess } from "./local-commit-delivery";

/**
 * Transport envelope for Core-backed IPC channels. Electron may flatten
 * thrown errors into plain strings, so typed Core errors travel inside the
 * successful IPC payload and are rethrown by the renderer boundary.
 */
export type CoreErrorDetail = Pick<
  components["schemas"]["CoreError"],
  "code" | "message" | "retryable" | "recovery"
>;

export type CoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CoreErrorDetail };

export type CoreResultFailure = Extract<CoreResult<never>, { readonly ok: false }>;

export type CoreLocalCommitResult<Value, Failure = never> =
  | LocalCommitCommandSuccess<Value>
  | CoreResultFailure
  | Failure;

/** Core error codes whose cursors/read state should be silently rebuilt. */
const CURSOR_REJECTION_CODES = new Set<CoreErrorDetail["code"]>([
  "revision_conflict",
  "stale_store_epoch",
]);

/**
 * True when a windowed read failed because its continuation cursor is no
 * longer honored. The caller owns the knowledge that invalid input came from
 * a cursor-bearing request rather than from another field.
 */
export const isCursorRejectionCode = (
  code: CoreErrorDetail["code"],
  options: { readonly requestHadCursor: boolean },
): boolean =>
  CURSOR_REJECTION_CODES.has(code) || (options.requestHadCursor && code === "invalid_input");
