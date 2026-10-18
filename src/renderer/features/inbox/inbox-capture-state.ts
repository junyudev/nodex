import { z } from "zod";
import type { InboxPreparedConfirmation, InboxScope, InboxSendInput } from "../../../shared/inbox";
import { inboxScopeKey } from "../../../shared/inbox";
import {
  InboxSendInputSchema,
  InboxPreparedConfirmationSchema,
} from "../../../shared/schemas/inbox";
import { createBoundedOperationId } from "../../../shared/operation-identity";
import { createUuidV7 } from "../../../shared/uuid-v7";

export interface PendingInboxCapture {
  readonly intent: InboxSendInput;
  readonly draftRevision: number;
  readonly status: "pending" | "accepted" | "failed" | "needs_review";
  readonly error: string | null;
}

export interface InboxCaptureState {
  readonly version: 1;
  readonly draft: string;
  readonly draftRevision: number;
  readonly captures: readonly PendingInboxCapture[];
  readonly decisions: Readonly<Record<string, InboxPreparedConfirmation>>;
}

export const EMPTY_INBOX_CAPTURE_STATE: InboxCaptureState = {
  version: 1,
  draft: "",
  draftRevision: 0,
  captures: [],
  decisions: {},
};

const stateSchema = z.object({
  version: z.literal(1),
  draft: z.string(),
  draftRevision: z.number().int().nonnegative(),
  captures: z.array(
    z.object({
      intent: InboxSendInputSchema,
      draftRevision: z.number().int().nonnegative(),
      status: z.enum(["pending", "accepted", "failed", "needs_review"]),
      error: z.string().nullable(),
    }),
  ),
  decisions: z.record(z.string(), InboxPreparedConfirmationSchema),
});

export const decodeInboxCaptureState = (value: unknown): InboxCaptureState =>
  stateSchema.parse(value);

/** Profile storage supplies the outer boundary; each writable window form gets its own key. */
export const inboxCaptureStorageKey = (windowSessionId: string, scope: InboxScope): string =>
  `inbox-capture-v1:${JSON.stringify([windowSessionId, inboxScopeKey(scope)])}`;

export const changeInboxDraft = (state: InboxCaptureState, draft: string): InboxCaptureState => ({
  ...state,
  draft,
  draftRevision: state.draftRevision + 1,
});

export function createInboxCapture(
  state: InboxCaptureState,
  scope: InboxScope,
  storeEpoch: string,
): PendingInboxCapture {
  const issuedAt = Date.now();
  return {
    intent: {
      operationId: createBoundedOperationId("inbox.capture", issuedAt),
      pageId: createUuidV7(),
      documentId: createUuidV7(),
      issuedAt,
      storeEpoch,
      scope,
      text: state.draft,
    },
    draftRevision: state.draftRevision,
    status: "pending",
    error: null,
  };
}

export const retainInboxCapture = (
  state: InboxCaptureState,
  capture: PendingInboxCapture,
): InboxCaptureState =>
  state.captures.some((value) => value.intent.pageId === capture.intent.pageId)
    ? state
    : { ...state, captures: [...state.captures, capture] };

/** Clearing A is conditional: a late persistence acknowledgement must never erase B. */
export const consumeInboxDraft = (
  state: InboxCaptureState,
  capture: PendingInboxCapture,
): InboxCaptureState =>
  state.draftRevision !== capture.draftRevision
    ? state
    : { ...state, draft: "", draftRevision: state.draftRevision + 1 };

export const settleInboxCapture = (
  state: InboxCaptureState,
  pageId: string,
  error: string | null,
  requiresReview = false,
): InboxCaptureState => ({
  ...state,
  captures: state.captures.map((capture) =>
    capture.intent.pageId === pageId
      ? {
          ...capture,
          status: requiresReview ? "needs_review" : error ? "failed" : "accepted",
          error,
        }
      : capture,
  ),
});

/** A rendered Core Page takes over; an unrelated acknowledgement cannot consume the envelope. */
export const observeInboxCaptures = (
  state: InboxCaptureState,
  pageIds: ReadonlySet<string>,
  storeEpoch: string,
): InboxCaptureState => ({
  ...state,
  captures: state.captures.filter(
    (capture) => capture.intent.storeEpoch !== storeEpoch || !pageIds.has(capture.intent.pageId),
  ),
});
