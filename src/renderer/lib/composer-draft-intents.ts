import { useSyncExternalStore } from "react";
import type { CodexComposerIntent } from "../../shared/types";
import { classifyKeyboardActionPath } from "./keyboard-action-runtime";

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]';

interface FocusActivity {
  revision: number;
  editableRevision: number;
  editableTarget: WeakRef<HTMLElement> | null;
}

const documentFocus = new WeakMap<Document, FocusActivity>();

function trackFocus(document: Document): FocusActivity {
  const current = documentFocus.get(document);
  if (current) return current;
  const activity: FocusActivity = { revision: 0, editableRevision: 0, editableTarget: null };
  documentFocus.set(document, activity);
  document.addEventListener(
    "focusin",
    ({ target }) => {
      if (!(target instanceof HTMLElement)) return;
      const editable = classifyKeyboardActionPath([target]) === "editable";
      // Modal focus traps may move focus through their controls before releasing it.
      if (!editable && target.closest(DIALOG_SELECTOR)) return;
      activity.revision += 1;
      if (!editable) return;
      activity.editableRevision += 1;
      activity.editableTarget = new WeakRef(target);
    },
    true,
  );
  return activity;
}

export interface ComposerFocusTransfer {
  readonly editor: HTMLElement;
  readonly selection?: { from: number; to: number } | null;
  readonly isCurrent: () => boolean;
}

/** A replacement editor inherits focus only while the original interaction still owns it. */
export function captureComposerFocus(
  editor: HTMLElement | null | undefined,
  selection?: ComposerFocusTransfer["selection"],
): ComposerFocusTransfer | null {
  if (!editor || editor.ownerDocument.activeElement !== editor) return null;
  const activity = trackFocus(editor.ownerDocument);
  const revision = activity.revision;
  return { editor, selection, isCurrent: () => activity.revision === revision };
}

export function hasOpenComposerBlockingDialog(document: Document): boolean {
  return [...document.querySelectorAll(DIALOG_SELECTOR)].some(
    (dialog) =>
      !dialog.closest('[hidden], [aria-hidden="true"], [inert], [data-base-ui-inert]') &&
      dialog.checkVisibility?.({ visibilityProperty: true }) !== false,
  );
}

interface PendingComposerIntent {
  readonly intent: CodexComposerIntent;
  readonly revision: number;
  readonly transfer?: ComposerFocusTransfer;
  readonly reveal?: boolean;
  readonly firstSend?: "awaiting" | "ready";
  readonly focus: { activity: FocusActivity; editableRevision: number } | null;
}

/** Root Sessions survive first-Turn attachment; children and unmaterialized forms need their own identity. */
export type ComposerChatKey =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "session-thread"; readonly sessionId: string; readonly threadId: string }
  | { readonly kind: "project-draft"; readonly projectId: string; readonly draftId: string }
  | { readonly kind: "pending-worktree"; readonly clientThreadId: string }
  | { readonly kind: "remote-thread"; readonly hostId: string; readonly threadId: string };

type Listener = () => void;
const keyOf = (chat: ComposerChatKey): string => {
  if (chat.kind === "session") return JSON.stringify([chat.kind, chat.sessionId]);
  if (chat.kind === "session-thread")
    return JSON.stringify([chat.kind, chat.sessionId, chat.threadId]);
  if (chat.kind === "project-draft")
    return JSON.stringify([chat.kind, chat.projectId, chat.draftId]);
  if (chat.kind === "pending-worktree") return JSON.stringify([chat.kind, chat.clientThreadId]);
  return JSON.stringify([chat.kind, chat.hostId, chat.threadId]);
};

/** Renderer-window handoffs, independent of conversation hydration or execution ownership. */
function createComposerDraftIntents() {
  const pending = new Map<string, PendingComposerIntent>();
  const listeners = new Map<string, Set<Listener>>();
  const materializedDrafts = new Map<string, string>();
  let revision = 0;
  const resolve = (key: string) => materializedDrafts.get(key) ?? key;
  const notify = (key: string) => {
    for (const [source, callbacks] of listeners) {
      if (resolve(source) !== key) continue;
      for (const listener of callbacks) listener();
    }
  };
  const move = (source: string, target: string) => {
    if (source === target) return;
    const draft = pending.get(source);
    const destination = pending.get(target);
    if (draft && (!destination || draft.revision > destination.revision))
      pending.set(target, draft);
    pending.delete(source);
    notify(source);
    notify(target);
  };
  const acknowledge = (chat: ComposerChatKey, intent: CodexComposerIntent): void => {
    const key = resolve(keyOf(chat));
    if (pending.get(key)?.intent !== intent) return;
    pending.delete(key);
    notify(key);
  };
  return {
    set(
      chat: ComposerChatKey,
      intent: CodexComposerIntent,
      options?: {
        readonly transfer?: ComposerFocusTransfer;
        readonly reveal?: boolean;
        readonly firstSend?: "awaiting";
      },
    ): void {
      const key = resolve(keyOf(chat));
      if (pending.get(key)?.intent === intent) return;
      const activity = typeof document === "undefined" ? null : trackFocus(document);
      const focus = activity ? { activity, editableRevision: activity.editableRevision } : null;
      pending.set(key, { intent, revision: ++revision, ...options, focus });
      notify(key);
    },
    moveFocusTransfer(source: ComposerChatKey, target: ComposerChatKey): void {
      const key = resolve(keyOf(source));
      if (pending.get(key)?.transfer) move(key, resolve(keyOf(target)));
    },
    completeFirstSend(chat: ComposerChatKey): void {
      const key = resolve(keyOf(chat));
      const entry = pending.get(key);
      if (entry?.firstSend !== "awaiting") return;
      // A new snapshot wakes the mounted editor even when the same Session owns both surfaces.
      pending.set(key, { ...entry, intent: { ...entry.intent }, firstSend: "ready" });
      notify(key);
    },
    resolvePendingWorktree(clientThreadId: string, hostId: string, threadId: string): void {
      const source = keyOf({ kind: "pending-worktree", clientThreadId });
      const entry = pending.get(source);
      if (!entry) return;
      if (entry.firstSend === "awaiting") pending.set(source, { ...entry, firstSend: "ready" });
      move(source, JSON.stringify(["resolved-worktree", hostId, threadId]));
    },
    adoptResolvedWorktree(chat: ComposerChatKey, hostId: string, threadId: string): void {
      const source = JSON.stringify(["resolved-worktree", hostId, threadId]);
      if (pending.has(source)) move(source, resolve(keyOf(chat)));
    },
    shouldReveal(chat: ComposerChatKey, intent: CodexComposerIntent): boolean {
      const entry = pending.get(resolve(keyOf(chat)));
      return entry?.intent === intent && entry.revision === revision && entry.reveal === true;
    },
    focusFor(
      chat: ComposerChatKey,
      intent: CodexComposerIntent,
      editor: HTMLElement,
      conversationReady: boolean,
    ) {
      const entry = pending.get(resolve(keyOf(chat)));
      if (entry?.intent !== intent) return { status: "superseded" } as const;
      if (entry.revision !== revision || (entry.transfer && !entry.transfer.isCurrent()))
        return { status: "abandoned" } as const;
      if (
        entry.firstSend === "awaiting" ||
        (entry.firstSend === "ready" && !conversationReady) ||
        (entry.firstSend === undefined && entry.transfer?.editor === editor)
      )
        return { status: "waiting" } as const;
      const { focus } = entry;
      if (
        focus &&
        focus.activity.editableRevision > focus.editableRevision &&
        focus.activity.editableTarget?.deref() !== editor
      )
        return { status: "abandoned" } as const;
      return { status: "ready", selection: entry.transfer?.selection } as const;
    },
    acknowledge,
    consume(chat: ComposerChatKey, focusNonce: number): void {
      const intent = pending.get(resolve(keyOf(chat)))?.intent;
      if (intent?.focusNonce === focusNonce) acknowledge(chat, intent);
    },
    read(chat: ComposerChatKey): CodexComposerIntent | null {
      return pending.get(resolve(keyOf(chat)))?.intent ?? null;
    },
    subscribe(chat: ComposerChatKey, listener: Listener): () => void {
      const key = keyOf(chat);
      const callbacks = listeners.get(key) ?? new Set<Listener>();
      listeners.set(key, callbacks);
      callbacks.add(listener);
      return () => {
        callbacks.delete(listener);
        if (callbacks.size === 0) listeners.delete(key);
      };
    },
    /** Binds a local Project form to its admitted Session, preserving pending and captured handoffs. */
    materializeProjectDraft(
      chat: Extract<ComposerChatKey, { kind: "project-draft" }>,
      sessionId: string,
    ): void {
      const source = keyOf(chat);
      const target = keyOf({ kind: "session", sessionId });
      if (materializedDrafts.has(source)) return;
      materializedDrafts.set(source, target);
      move(source, target);
    },
  };
}

export const composerDraftIntents = createComposerDraftIntents();

const focusOnlyIntent = () =>
  ({ prompt: "", attachmentMode: "append", focusNonce: Date.now() }) as const;

/** Requests the caret without changing the destination draft. */
export function requestComposerFocus(chat: ComposerChatKey, transfer?: ComposerFocusTransfer) {
  const intent = focusOnlyIntent();
  composerDraftIntents.set(chat, intent, { transfer });
  return intent;
}

/** Holds the submitting editor's focus through the provisional first-send surface. */
export function holdComposerFocusForFirstSend(
  chat: ComposerChatKey,
  transfer: ComposerFocusTransfer,
) {
  const intent = focusOnlyIntent();
  composerDraftIntents.set(chat, intent, { transfer, firstSend: "awaiting" });
  return intent;
}

export function useComposerDraftIntent(chat: ComposerChatKey | null): CodexComposerIntent | null {
  return useSyncExternalStore(
    (listener) => (chat ? composerDraftIntents.subscribe(chat, listener) : () => {}),
    () => (chat ? composerDraftIntents.read(chat) : null),
  );
}
