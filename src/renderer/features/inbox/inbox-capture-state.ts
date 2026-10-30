import { z } from "zod";
import type { MessageDraftImage } from "@/components/message/message-images-input";
import type { InboxPreparedConfirmation, InboxScope, InboxSendInput } from "../../../shared/inbox";
import { inboxScopeKey } from "../../../shared/inbox";
import {
  InboxSendInputSchema,
  InboxPreparedConfirmationSchema,
} from "../../../shared/schemas/inbox";
import { parseFileSource } from "../../../shared/file-resources";
import {
  composeMessageText,
  isComposerImage,
  messageImageBlock,
  serializeMessageText,
  splitMessageContent,
} from "../../../shared/message-content";
import { readMarkdown } from "../../../shared/nodex-markdown";
import { createBoundedOperationId } from "../../../shared/operation-identity";
import { createUuidV7 } from "../../../shared/uuid-v7";

/** What the composer holds: the text as typed, read as message text, and its images. */
export interface InboxDraft {
  readonly text: string;
  readonly images: readonly MessageDraftImage[];
}

export const EMPTY_INBOX_DRAFT: InboxDraft = { text: "", images: [] };

export const isEmptyInboxDraft = (draft: InboxDraft): boolean =>
  draft.text.trim().length === 0 && draft.images.length === 0;

/** How a draft is named while it waits to be saved: its text, else its images. */
export const inboxDraftLabel = (draft: InboxDraft): string =>
  draft.text.trim() || (draft.images.length === 1 ? "1 image" : `${draft.images.length} images`);

export const inboxDraftBody = (draft: InboxDraft): string =>
  composeMessageText(
    draft.text,
    draft.images.map((image) => messageImageBlock(image.fileId)),
  );

/**
 * Every stored message is editable as exact Markdown, with ordinary File images as attachments.
 * Saving writes them first, where a Composer keeps them, even for a message that ended with them.
 */
export function inboxDraftFromBody(body: string): InboxDraft {
  const { text, attachments } = splitMessageContent(readMarkdown(body));
  const written = serializeMessageText(text);
  if (
    !attachments.every(
      (block) => isComposerImage(block) && parseFileSource(String(block.props?.url ?? "")),
    )
  )
    return { text: body, images: [] };
  return {
    text: written,
    images: attachments.flatMap((block) => {
      const fileId = parseFileSource(String(block.props?.url ?? ""));
      return fileId ? [{ fileId, name: "" }] : [];
    }),
  };
}

export interface PendingInboxCapture {
  readonly intent: InboxSendInput;
  /** The draft it was sent from, so recovering it restores the text and images exactly. */
  readonly draft: InboxDraft;
  readonly draftRevision: number;
  readonly status: "pending" | "accepted" | "failed" | "needs_review";
  readonly error: string | null;
}

export interface InboxCaptureState {
  readonly version: 2;
  readonly draft: InboxDraft;
  readonly draftRevision: number;
  readonly captures: readonly PendingInboxCapture[];
  readonly decisions: Readonly<Record<string, InboxPreparedConfirmation>>;
}

export const EMPTY_INBOX_CAPTURE_STATE: InboxCaptureState = {
  version: 2,
  draft: EMPTY_INBOX_DRAFT,
  draftRevision: 0,
  captures: [],
  decisions: {},
};

const draftSchema = z.object({
  text: z.string(),
  images: z.array(
    z.object({
      fileId: z.string().min(1),
      name: z.string(),
      importedRevision: z.number().int().nonnegative().optional(),
    }),
  ),
});

const stateSchema = z.object({
  version: z.literal(2),
  draft: draftSchema,
  draftRevision: z.number().int().nonnegative(),
  captures: z.array(
    z.object({
      intent: InboxSendInputSchema,
      draft: draftSchema,
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
  `inbox-capture-v2:${JSON.stringify([windowSessionId, inboxScopeKey(scope)])}`;

export const changeInboxDraft = (
  state: InboxCaptureState,
  change: (draft: InboxDraft) => InboxDraft,
): InboxCaptureState => ({
  ...state,
  draft: change(state.draft),
  draftRevision: state.draftRevision + 1,
});

/** A capture that may not have been saved goes back into the draft, after what is there. */
export const recoverInboxDraft = (draft: InboxDraft, recovered: InboxDraft): InboxDraft => ({
  text: [draft.text, recovered.text].filter((text) => text.trim()).join("\n\n"),
  images: [
    ...draft.images,
    ...recovered.images.filter(
      (image) => !draft.images.some((existing) => existing.fileId === image.fileId),
    ),
  ],
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
      body: inboxDraftBody(state.draft),
    },
    draft: state.draft,
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
    : { ...state, draft: EMPTY_INBOX_DRAFT, draftRevision: state.draftRevision + 1 };

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
