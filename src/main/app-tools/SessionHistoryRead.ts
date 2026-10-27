import {
  readHistory,
  readHistoryProgress,
  type HistoryInput,
  type HistorySource,
} from "@nodex/agent-runtime/history-read";
import type { SessionHistory, SessionProgress } from "../../shared/nodex-app-tools/session-history";
import * as Effect from "effect/Effect";
export {
  HistoryReadError as SessionHistoryReadError,
  HISTORY_READ_MAX_BYTES as SESSION_READ_MAX_BYTES,
} from "@nodex/agent-runtime/history-read";
export type {
  HistoryItemReference as SessionItemReference,
  HistoryItemLocator as SessionItemLocator,
  HistorySourceContent as SessionSourceContent,
} from "@nodex/agent-runtime/history-read";
export type SessionHistorySource = HistorySource;
export type SessionHistoryInput = Omit<HistoryInput, "ownerId"> & {
  readonly sessionId: string;
  readonly execution?: { readonly threadId: string };
  readonly runLimit?: number;
  readonly runCursor?: string;
};
/** Main binds the product Session; Runtime owns the shared history presentation algorithm. */
export const readSessionHistory = (input: {
  readonly request: SessionHistoryInput;
  readonly binding: string;
  readonly source: SessionHistorySource;
  readonly wrap: (history: SessionHistory) => Record<string, unknown>;
}) =>
  readHistory({
    ...input,
    request: { ...input.request, ownerId: input.request.sessionId },
    wrap: (history) => input.wrap(history as SessionHistory),
  }).pipe(Effect.map((result) => ({ ...result, history: result.history as SessionHistory })));
export const readSessionProgress = (input: {
  readonly sessionId: string;
  readonly binding: string;
  readonly source: SessionHistorySource;
}) =>
  readHistoryProgress({ ...input, ownerId: input.sessionId }).pipe(
    Effect.map((progress) => progress as SessionProgress),
  );
