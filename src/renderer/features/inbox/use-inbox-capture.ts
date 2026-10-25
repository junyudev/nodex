import { useLayoutEffect, useRef, useState } from "react";
import { InboxSendInputSchema } from "../../../shared/schemas/inbox";
import type { InboxScope, InboxSendInput, InboxSendResult } from "../../../shared/inbox";
import {
  persistedAtom,
  usePersistedAtomValue,
  useSetPersistedAtom,
  useMaitaiStore,
  getConcretePersistedAtom,
  retryPersistedAtom,
  type PersistedAtomDefinition,
} from "@/lib/maitai";
import { readableIpcError } from "@/lib/ipc-error-message";
import { inboxReceiptNeedsReview } from "./inbox-presentation";
import {
  EMPTY_INBOX_CAPTURE_STATE,
  changeInboxDraft,
  isEmptyInboxDraft,
  recoverInboxDraft,
  consumeInboxDraft,
  createInboxCapture,
  decodeInboxCaptureState,
  inboxCaptureStorageKey,
  observeInboxCaptures,
  retainInboxCapture,
  settleInboxCapture,
  type InboxCaptureState,
  type InboxDraft,
  type PendingInboxCapture,
} from "./inbox-capture-state";

const definitions = new Map<string, PersistedAtomDefinition<InboxCaptureState>>();

export function inboxCaptureAtom(windowSessionId: string, scope: InboxScope) {
  const key = inboxCaptureStorageKey(windowSessionId, scope);
  const existing = definitions.get(key);
  if (existing) return existing;
  const definition = persistedAtom({
    debugLabel: key,
    storageKey: key,
    defaultValue: EMPTY_INBOX_CAPTURE_STATE,
    hydration: "eager",
    synchronization: "same-window",
    writeFailure: "retain-and-error",
    decode: decodeInboxCaptureState,
  });
  definitions.set(key, definition);
  return definition;
}

export function useInboxCaptureState(windowSessionId: string, scope: InboxScope) {
  const definition = inboxCaptureAtom(windowSessionId, scope);
  const state = usePersistedAtomValue(definition);
  const write = useSetPersistedAtom(definition);
  const store = useMaitaiStore();
  const read = () => store.jotaiStore.get(getConcretePersistedAtom(store, definition)).value;
  return { state, write, read, retryPersistence: () => retryPersistedAtom(store, definition) };
}

export function useInboxCapture({
  windowSessionId,
  scope,
  storeEpoch,
  visiblePageIds,
  onSend,
}: {
  readonly windowSessionId: string;
  readonly scope: InboxScope;
  readonly storeEpoch: string | null;
  readonly visiblePageIds: readonly string[];
  readonly onSend: (intent: InboxSendInput) => Promise<InboxSendResult>;
}) {
  const { state, write, read, retryPersistence } = useInboxCaptureState(windowSessionId, scope);
  const [validationError, setValidationError] = useState<string | null>(null);
  const preparing = useRef(false);
  const inFlight = useRef(new Set<string>());

  useLayoutEffect(() => {
    if (!storeEpoch) return;
    const visible = new Set(visiblePageIds);
    if (
      !state.value.captures.some(
        (capture) => capture.intent.storeEpoch === storeEpoch && visible.has(capture.intent.pageId),
      )
    )
      return;
    void write((current) => observeInboxCaptures(current, visible, storeEpoch)).catch(
      () => undefined,
    );
  }, [visiblePageIds, storeEpoch, state.value.captures, write]);

  const deliver = async (capture: PendingInboxCapture) => {
    const { intent } = capture;
    if (
      capture.status === "needs_review" ||
      intent.storeEpoch !== storeEpoch ||
      inFlight.current.has(intent.pageId)
    )
      return;
    inFlight.current.add(intent.pageId);
    try {
      // Retry may follow a failed local write. Admission always waits for the envelope's disk write.
      await write((current) => retainInboxCapture(current, capture));
      await write((current) => consumeInboxDraft(current, capture));
      const result = await onSend(intent);
      if (result.pageId !== intent.pageId)
        throw new Error("The saved message did not match this capture. Retry to check it.");
      await write((current) =>
        result.state === "deleted"
          ? observeInboxCaptures(current, new Set([intent.pageId]), intent.storeEpoch)
          : settleInboxCapture(current, intent.pageId, null),
      );
    } catch (error) {
      await write((current) =>
        settleInboxCapture(
          current,
          intent.pageId,
          inboxReceiptNeedsReview(error)
            ? "Could not verify whether this capture was saved. Check the Inbox before recovering it."
            : readableIpcError(error, "Message not saved — retry"),
          inboxReceiptNeedsReview(error),
        ),
      ).catch(() => undefined);
    } finally {
      inFlight.current.delete(intent.pageId);
    }
  };

  const submit = async () => {
    if (preparing.current || !storeEpoch || state.status !== "ready") return;
    const current = read();
    if (isEmptyInboxDraft(current.draft)) return;
    preparing.current = true;
    const capture =
      current.captures.find((entry) => entry.draftRevision === current.draftRevision) ??
      createInboxCapture(current, scope, storeEpoch);
    if (capture.status === "needs_review" || capture.intent.storeEpoch !== storeEpoch) {
      setValidationError("Review the earlier capture before sending again.");
      preparing.current = false;
      return;
    }
    const validation = InboxSendInputSchema.safeParse(capture.intent);
    if (!validation.success) {
      setValidationError(validation.error.issues[0]?.message ?? "Message could not be saved");
      preparing.current = false;
      return;
    }
    try {
      await write((latest) => retainInboxCapture(latest, capture));
      await write((latest) => consumeInboxDraft(latest, capture));
    } catch {
      return;
    } finally {
      preparing.current = false;
    }
    await deliver(capture);
  };

  return {
    draft: state.value.draft,
    pending: state.value.captures.filter(
      (entry) =>
        entry.intent.storeEpoch !== storeEpoch || !visiblePageIds.includes(entry.intent.pageId),
    ),
    error: state.error,
    validationError,
    canEdit: state.status === "ready" || state.pendingMutationCount > 0,
    ready: state.status === "ready" && storeEpoch !== null,
    /** Applies to the draft as it is when written, so a finished image import never drops text. */
    changeDraft: (change: (draft: InboxDraft) => InboxDraft) => {
      setValidationError(null);
      void write((current) => changeInboxDraft(current, change)).catch(() => undefined);
    },
    submit,
    retry: deliver,
    retryPersistence,
    recover: (capture: PendingInboxCapture) =>
      write((current) => ({
        ...changeInboxDraft(current, (draft) => recoverInboxDraft(draft, capture.draft)),
        captures: current.captures.filter((entry) => entry.intent.pageId !== capture.intent.pageId),
      })),
  };
}
