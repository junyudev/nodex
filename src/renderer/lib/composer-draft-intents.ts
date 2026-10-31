import { useSyncExternalStore } from "react";
import type { CodexComposerIntent } from "../../shared/types";

/** Root Sessions survive first-Turn attachment; children and unmaterialized forms need their own identity. */
export type ComposerChatKey =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "session-thread"; readonly sessionId: string; readonly threadId: string }
  | { readonly kind: "project-draft"; readonly projectId: string; readonly draftId: string }
  | { readonly kind: "remote-thread"; readonly hostId: string; readonly threadId: string };

type Listener = () => void;
const keyOf = (chat: ComposerChatKey): string => {
  if (chat.kind === "session") return JSON.stringify([chat.kind, chat.sessionId]);
  if (chat.kind === "session-thread")
    return JSON.stringify([chat.kind, chat.sessionId, chat.threadId]);
  if (chat.kind === "project-draft")
    return JSON.stringify([chat.kind, chat.projectId, chat.draftId]);
  return JSON.stringify([chat.kind, chat.hostId, chat.threadId]);
};

/** Renderer-window handoffs, independent of conversation hydration or execution ownership. */
function createComposerDraftIntents() {
  const pending = new Map<
    string,
    { readonly intent: CodexComposerIntent; readonly revision: number }
  >();
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
  return {
    set(chat: ComposerChatKey, intent: CodexComposerIntent): void {
      const key = resolve(keyOf(chat));
      if (pending.get(key)?.intent === intent) return;
      pending.set(key, { intent, revision: ++revision });
      notify(key);
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
    consume(chat: ComposerChatKey, focusNonce: number): void {
      const key = resolve(keyOf(chat));
      const current = pending.get(key);
      if (!current || current.intent.focusNonce !== focusNonce) return;
      pending.delete(key);
      notify(key);
    },
    /** Binds a local Project form to its admitted Session, preserving pending and captured handoffs. */
    materializeProjectDraft(
      chat: Extract<ComposerChatKey, { kind: "project-draft" }>,
      sessionId: string,
    ): void {
      const source = keyOf(chat);
      const target = keyOf({ kind: "session", sessionId });
      if (materializedDrafts.has(source)) return;
      const draft = pending.get(source);
      const session = pending.get(target);
      materializedDrafts.set(source, target);
      if (draft && (!session || draft.revision > session.revision)) pending.set(target, draft);
      pending.delete(source);
      notify(target);
    },
  };
}

export const composerDraftIntents = createComposerDraftIntents();

export function useComposerDraftIntent(chat: ComposerChatKey | null): CodexComposerIntent | null {
  return useSyncExternalStore(
    (listener) => (chat ? composerDraftIntents.subscribe(chat, listener) : () => {}),
    () => (chat ? composerDraftIntents.read(chat) : null),
  );
}
