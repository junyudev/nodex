import type {
  AgentRuntimeLaunchResult,
  AgentRuntimeSideChatSaveInput,
} from "../../shared/agent-runtime-api";
import type { ComposerDraftCaptureLease } from "../features/local-conversation/view/composer/composer-draft-capture";
import type { ComposerDraftTransfer } from "../features/local-conversation/view/composer/composer-draft-state";
import { createUuidV7 } from "../../shared/uuid-v7";

type SavedChat = AgentRuntimeLaunchResult & { readonly sourceSessionId: string };
interface SaveEntry {
  head: string | null;
  draftKey: string | null;
  transferred: boolean;
  savedHead: string | null;
  request: AgentRuntimeSideChatSaveInput | null;
  promise: Promise<SavedChat> | null;
  closingTabId: string | null;
}

export interface SideChatSavePorts {
  readonly sessionId: string;
  readonly threadId: string;
  readonly tabId: string;
  readonly acquireDraft: () => ComposerDraftCaptureLease;
  readonly readSourceHead: () => Promise<string>;
  readonly readSavedHead: (saved: SavedChat) => Promise<string>;
  readonly isSourceCurrent: () => boolean;
  readonly save: (input: AgentRuntimeSideChatSaveInput) => Promise<SavedChat>;
  readonly refresh: (projectId: string | null) => Promise<unknown>;
  readonly publishDraft: (transfer: ComposerDraftTransfer) => void;
  readonly open: (saved: SavedChat, isCurrent: () => boolean) => Promise<boolean>;
  readonly close: () => Promise<void>;
}

/** A retry retains its destination; only the exact saved tab receives a close permit. */
export function createSideChatSaveStore() {
  const entries = new Map<string, SaveEntry>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const store = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pending(sessionId: string) {
      return Boolean(entries.get(sessionId)?.promise);
    },
    closeDecision(sessionId: string, tabId: string): "normal" | "saved" | "defer" {
      const entry = entries.get(sessionId);
      if (!entry?.promise) return "normal";
      return entry.closingTabId === tabId ? "saved" : "defer";
    },
    save(ports: SideChatSavePorts): Promise<SavedChat> {
      const entry = entries.get(ports.sessionId) ?? {
        head: null,
        draftKey: null,
        transferred: false,
        savedHead: null,
        request: null,
        promise: null,
        closingTabId: null,
      };
      if (entry.promise) return entry.promise;
      entries.set(ports.sessionId, entry);
      entry.promise = Promise.resolve()
        .then(async () => {
          const draft = ports.acquireDraft();
          try {
            const assertCurrent = () => {
              if (!ports.isSourceCurrent())
                throw new Error("Return to the side chat to finish saving it.");
              const captured = draft.capture();
              if (captured.status !== "ready") throw new Error(captured.message);
              return JSON.stringify(captured.snapshot);
            };
            assertCurrent();
            const head = await ports.readSourceHead();
            const draftKey = assertCurrent();
            if (!entry.request || entry.head !== head || entry.draftKey !== draftKey) {
              entry.head = head;
              entry.draftKey = draftKey;
              entry.transferred = false;
              entry.savedHead = null;
              entry.request = {
                source: { sessionId: ports.sessionId, threadId: ports.threadId },
                sessionId: createUuidV7(),
                requestId: createUuidV7(),
                acceptedAt: Date.now(),
              };
            }
            const saved = await ports.save(entry.request);
            if (!entry.transferred) {
              const savedHead = await ports.readSavedHead(saved);
              if (entry.savedHead !== null && entry.savedHead !== savedHead)
                throw new Error(
                  "The saved chat has newer work. Continue there; your side chat has been kept open.",
                );
              entry.savedHead = savedHead;
              const transfer = await draft.persistTransfer(saved.threadId);
              entry.draftKey = assertCurrent();
              ports.publishDraft(transfer);
              draft.commitTransfer(transfer);
              entry.transferred = true;
            }
            await ports.refresh(saved.projectId);
            assertCurrent();
            const opened = await ports.open(saved, () => {
              if (!ports.isSourceCurrent()) return false;
              return draft.capture().status === "ready";
            });
            if (!opened)
              throw new Error(
                "The chat was saved, but could not be opened. Your side chat is still available.",
              );
            if ((await ports.readSourceHead()) !== head)
              throw new Error(
                "The chat was saved. Your side chat has newer changes and has been kept open.",
              );
            entry.closingTabId = ports.tabId;
            await ports.close();
            entries.delete(ports.sessionId);
            return saved;
          } finally {
            await draft.release();
          }
        })
        .finally(() => {
          entry.promise = null;
          entry.closingTabId = null;
          notify();
        });
      notify();
      return entry.promise;
    },
  };
  return store;
}

export const sideChatSaveStore = createSideChatSaveStore();
