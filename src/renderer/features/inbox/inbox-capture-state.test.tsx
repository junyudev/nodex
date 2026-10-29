import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  PersistedAtomEvent,
  PersistedAtomMutation,
  PersistedAtomSnapshot,
} from "../../../shared/ipc-api";
import type { PersistedAtomTransport } from "@/lib/persisted-atom-store";
import {
  createMaitaiStore,
  disposeMaitaiStore,
  MaitaiProvider,
  setMaitaiPersistenceTransport,
} from "@/lib/maitai";
import {
  LIBRARY_INBOX,
  projectInbox,
  type InboxSendInput,
  type InboxSendResult,
} from "../../../shared/inbox";
import {
  decodeInboxCaptureState,
  EMPTY_INBOX_CAPTURE_STATE,
  inboxCaptureStorageKey,
} from "./inbox-capture-state";
import { useInboxCapture, useInboxCaptureState } from "./use-inbox-capture";
import { useInboxActions } from "./use-inbox-actions";
import { prepareInboxConfirmation, dispatchInboxEntries } from "@/lib/inbox-runtime";
import { createBoundedOperationId } from "../../../shared/operation-identity";
import { CoreApiError } from "@/lib/core-api-error";
import { createUuidV7 } from "../../../shared/uuid-v7";

vi.mock("@/lib/inbox-runtime", () => ({
  prepareInboxConfirmation: vi.fn(),
  dispatchInboxEntries: vi.fn(),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn(), danger: vi.fn() } }));
const saved = async (input: InboxSendInput): Promise<InboxSendResult> => ({
  pageId: input.pageId,
  state: "saved",
});

const expiredReceipt = () =>
  new CoreApiError({
    code: "idempotency_window_expired",
    message: "Receipt expired",
    retryable: false,
    recovery: { kind: "none" },
  });
beforeEach(() => vi.resetAllMocks());

class MemoryPersistence implements PersistedAtomTransport {
  snapshot: PersistedAtomSnapshot = { revision: 0, values: {} };
  failNext = false;
  readonly listeners = new Set<(event: PersistedAtomEvent) => void>();
  readSnapshot = async () => this.snapshot;
  mutate = async (input: PersistedAtomMutation): Promise<PersistedAtomEvent> => {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("disk unavailable");
    }
    const event = { ...input, revision: this.snapshot.revision + 1, originRendererId: "test" };
    this.snapshot = {
      revision: event.revision,
      values: { ...this.snapshot.values, [event.key]: event.value },
    };
    this.listeners.forEach((listener) => listener(event));
    return event;
  };
  subscribe = (listener: (event: PersistedAtomEvent) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

function setup(
  persistence: MemoryPersistence,
  windowSessionId: string,
  onSend: (input: InboxSendInput) => Promise<InboxSendResult>,
  epoch = "epoch:1",
) {
  const store = createMaitaiStore();
  setMaitaiPersistenceTransport(store, persistence);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MaitaiProvider store={store}>{children}</MaitaiProvider>
  );
  const hook = renderHook(
    ({ visiblePageIds, storeEpoch }) =>
      useInboxCapture({
        windowSessionId,
        scope: LIBRARY_INBOX,
        storeEpoch,
        visiblePageIds,
        onSend,
      }),
    {
      wrapper,
      initialProps: { visiblePageIds: [] as string[], storeEpoch: epoch },
    },
  );
  return {
    ...hook,
    dispose: () => {
      hook.unmount();
      disposeMaitaiStore(store);
    },
  };
}

describe("Inbox capture ownership", () => {
  test("retains A across a lost response while B remains editable, and reuses A's identity", async () => {
    const persistence = new MemoryPersistence();
    let rejectFirst!: (error: Error) => void;
    const onSend = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementation(saved);
    const hook = setup(persistence, "window:continuous", onSend);
    try {
      await waitFor(() => expect(hook.result.current.ready).toBe(true));
      await act(async () => {
        hook.result.current.changeDraft((draft) => ({ ...draft, text: "A" }));
      });
      let first!: Promise<void>;
      await act(async () => {
        first = hook.result.current.submit();
        await Promise.resolve();
      });
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
      expect(hook.result.current.draft.text).toBe("");
      await act(async () => {
        hook.result.current.changeDraft((draft) => ({ ...draft, text: "B" }));
        rejectFirst(new Error("response lost"));
        await first;
      });
      expect(hook.result.current.draft.text).toBe("B");
      expect(hook.result.current.pending[0]?.intent.body).toBe("A");
      await act(async () => {
        await hook.result.current.retry(hook.result.current.pending[0]!);
      });
      expect(onSend.mock.calls[1]?.[0]).toEqual(onSend.mock.calls[0]?.[0]);
      expect(hook.result.current.pending[0]?.status).toBe("accepted");
      const pageId = hook.result.current.pending[0]!.intent.pageId;
      hook.rerender({ visiblePageIds: [pageId], storeEpoch: "epoch:1" });
      await waitFor(() => expect(hook.result.current.pending).toEqual([]));
      expect(hook.result.current.draft.text).toBe("B");
    } finally {
      hook.dispose();
    }
  });

  test("never clears or sends text when persisting its capture fails", async () => {
    const persistence = new MemoryPersistence();
    const onSend = vi.fn(saved);
    const hook = setup(persistence, "window:disk-failure", onSend);
    try {
      await waitFor(() => expect(hook.result.current.ready).toBe(true));
      await act(async () => {
        hook.result.current.changeDraft((draft) => ({ ...draft, text: "Keep this text" }));
      });
      persistence.failNext = true;
      await act(async () => {
        await hook.result.current.submit();
      });
      expect(onSend).not.toHaveBeenCalled();
      expect(hook.result.current.draft.text).toBe("Keep this text");
      expect(hook.result.current.error?.message).toBe("disk unavailable");
      await act(async () => {
        await hook.result.current.retryPersistence();
      });
      await act(async () => {
        await hook.result.current.retry(hook.result.current.pending[0]!);
      });
      expect(hook.result.current.draft.text).toBe("");
      const pageId = hook.result.current.pending[0]!.intent.pageId;
      hook.rerender({ visiblePageIds: [pageId], storeEpoch: "epoch:1" });
      await waitFor(() => expect(hook.result.current.pending).toEqual([]));
      await act(async () => {
        await hook.result.current.submit();
      });
      expect(onSend).toHaveBeenCalledTimes(1);
    } finally {
      hook.dispose();
    }
  });

  test("rehydrates the same pending identity and blocks replay after a Store restore", async () => {
    const persistence = new MemoryPersistence();
    const first = setup(
      persistence,
      "window:reopen",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    await act(async () => {
      first.result.current.changeDraft((draft) => ({ ...draft, text: "A" }));
    });
    await act(async () => {
      await first.result.current.submit();
    });
    const intent = first.result.current.pending[0]!.intent;
    first.dispose();
    const onSend = vi.fn(saved);
    const reopened = setup(persistence, "window:reopen", onSend, "epoch:2");
    try {
      await waitFor(() => expect(reopened.result.current.pending).toHaveLength(1));
      expect(reopened.result.current.pending[0]!.intent).toEqual(intent);
      reopened.rerender({ visiblePageIds: [intent.pageId], storeEpoch: "epoch:2" });
      await waitFor(() => expect(reopened.result.current.pending).toHaveLength(1));
      await act(async () => {
        await reopened.result.current.retry(reopened.result.current.pending[0]!);
      });
      expect(onSend).not.toHaveBeenCalled();
      await act(async () => {
        await reopened.result.current.recover(reopened.result.current.pending[0]!);
      });
      expect(reopened.result.current.draft.text).toBe("A");
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      reopened.dispose();
    }
  });

  test("a saved draft still knows which images it imported, so it can discard them later", () => {
    const draft = {
      text: "",
      images: [
        { fileId: "pasted", name: "pasted.png", importedRevision: 1 },
        { fileId: "kept", name: "" },
      ],
    };
    const saved = JSON.parse(JSON.stringify({ ...EMPTY_INBOX_CAPTURE_STATE, draft }));
    expect(decodeInboxCaptureState(saved).draft).toEqual(draft);
  });

  test("separates writable window and Inbox scopes", () => {
    const keys = [
      inboxCaptureStorageKey("window:1", LIBRARY_INBOX),
      inboxCaptureStorageKey("window:2", LIBRARY_INBOX),
      inboxCaptureStorageKey("window:1", projectInbox("A")),
      inboxCaptureStorageKey("window:1", projectInbox("B")),
    ];
    expect(new Set(keys).size).toBe(4);
  });
  test("clears a saved capture when its idempotent receipt says the Page was deleted", async () => {
    const persistence = new MemoryPersistence();
    const onSend = vi.fn(async (input: InboxSendInput): Promise<InboxSendResult> => ({
      pageId: input.pageId,
      state: "deleted",
    }));
    const hook = setup(persistence, "window:deleted", onSend);
    try {
      await waitFor(() => expect(hook.result.current.ready).toBe(true));
      await act(async () => {
        hook.result.current.changeDraft((draft) => ({ ...draft, text: "Deleted elsewhere" }));
      });
      await act(async () => {
        await hook.result.current.submit();
      });
      expect(hook.result.current.pending).toEqual([]);
      expect(onSend).toHaveBeenCalledTimes(1);
    } finally {
      hook.dispose();
    }
  });

  test("an expired capture keeps its text and images for explicit recovery without resending", async () => {
    const persistence = new MemoryPersistence();
    const onSend = vi.fn(async (): Promise<InboxSendResult> => {
      throw expiredReceipt();
    });
    const hook = setup(persistence, "window:expired", onSend);
    try {
      await waitFor(() => expect(hook.result.current.ready).toBe(true));
      await act(async () => {
        hook.result.current.changeDraft(() => ({
          text: "Check whether this was saved",
          images: [{ fileId: "shot", name: "shot.png" }],
        }));
      });
      await act(async () => {
        await hook.result.current.submit();
      });
      const capture = hook.result.current.pending[0]!;
      expect(capture.status).toBe("needs_review");
      // The images follow the text in the message body, as the message shape requires.
      expect(capture.intent.body).toBe("Check whether this was saved\n\n![](nodex://files/shot)");
      await act(async () => {
        await hook.result.current.retry(capture);
      });
      expect(onSend).toHaveBeenCalledTimes(1);
      await act(async () => {
        await hook.result.current.recover(capture);
      });
      expect(hook.result.current.draft).toEqual({
        text: "Check whether this was saved",
        images: [{ fileId: "shot", name: "shot.png" }],
      });
      expect(hook.result.current.pending).toEqual([]);
      expect(onSend).toHaveBeenCalledTimes(1);
    } finally {
      hook.dispose();
    }
  });

  test.each(["response_lost", "receipt_expired"] as const)(
    "retains the prepared handoff across %s and blocks a second decision for its Page",
    async (failure) => {
      const persistence = new MemoryPersistence();
      const pageId = createUuidV7();
      const basis = [{ pageId, contentHash: "4".repeat(64) }];
      const action = {
        type: "new_chat" as const,
        projectId: null,
        prompt: "The edited prompt",
        agent: null,
        delegates: [],
        plan: null,
      };
      vi.mocked(prepareInboxConfirmation).mockImplementation(async (draft) => ({
        ...draft,
        operationId: createBoundedOperationId("inbox.confirm"),
        proposalId: createUuidV7(),
        sessionId: createUuidV7(),
        executionSelection: {
          modelSelection: { instanceId: "codex", model: "frozen-model" },
          interactionMode: "default",
        },
      }));
      vi.mocked(dispatchInboxEntries)
        .mockRejectedValueOnce(
          failure === "receipt_expired" ? expiredReceipt() : new Error("response lost"),
        )
        .mockResolvedValue({
          value: { undoToken: null },
          acknowledgement: {
            status: "no_op",
            observed: { store_epoch: "epoch:1", commit_head: 1 },
          },
        });
      const mount = () => {
        const store = createMaitaiStore();
        setMaitaiPersistenceTransport(store, persistence);
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const hook = renderHook(
          () => ({
            actions: useInboxActions([], LIBRARY_INBOX, "window:handoff", "epoch:1", []),
            saved: useInboxCaptureState("window:handoff", LIBRARY_INBOX),
          }),
          {
            wrapper: ({ children }: { children: ReactNode }) => (
              <MaitaiProvider store={store}>
                <QueryClientProvider client={client}>{children}</QueryClientProvider>
              </MaitaiProvider>
            ),
          },
        );
        return {
          ...hook,
          dispose: () => {
            hook.unmount();
            disposeMaitaiStore(store);
            client.clear();
          },
        };
      };
      const first = mount();
      await waitFor(() => expect(first.result.current.saved.state.status).toBe("ready"));
      await act(async () => {
        const submitted = first.result.current.actions.dispatch([pageId], action, basis);
        const repeated = first.result.current.actions.dispatch([pageId], action, basis);
        const conflicting = first.result.current.actions.dispatch(
          [pageId],
          { ...action, prompt: "Another handoff before preparation completes" },
          basis,
        );
        expect(await Promise.all([submitted, repeated, conflicting])).toEqual([
          false,
          false,
          false,
        ]);
      });
      const submitted = vi.mocked(dispatchInboxEntries).mock.calls[0]![0];
      expect(first.result.current.actions.pendingDecisions).toHaveLength(1);
      first.dispose();
      const second = mount();
      try {
        await waitFor(() => expect(second.result.current.actions.pendingDecisions).toHaveLength(1));
        await act(async () => {
          expect(
            await second.result.current.actions.dispatch(
              [pageId],
              { ...action, prompt: "Changed after restart" },
              basis,
            ),
          ).toBe(false);
        });
        expect(dispatchInboxEntries).toHaveBeenCalledTimes(1);
        const key = second.result.current.actions.pendingDecisions[0]!.key;
        expect(second.result.current.saved.state.value.decisions[key]?.operationId).toBe(
          submitted.operationId,
        );
        if (failure === "receipt_expired") return;
        await act(async () => {
          expect(await second.result.current.actions.retryDecision(key)).toBe(true);
        });
        expect(prepareInboxConfirmation).toHaveBeenCalledTimes(1);
        expect(vi.mocked(dispatchInboxEntries).mock.calls[1]![0]).toEqual(submitted);
        expect(second.result.current.actions.pendingDecisions).toEqual([]);
      } finally {
        second.dispose();
      }
    },
  );
});
