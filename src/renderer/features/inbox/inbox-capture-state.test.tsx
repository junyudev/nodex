import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
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
  inboxNewChatAction,
  LIBRARY_INBOX,
  projectInbox,
  type InboxSendInput,
  type InboxSendResult,
} from "../../../shared/inbox";
import {
  decodeInboxCaptureState,
  changeInboxDraft,
  consumeInboxDraft,
  createInboxCapture,
  EMPTY_INBOX_DRAFT,
  EMPTY_INBOX_CAPTURE_STATE,
  inboxCaptureStorageKey,
  isEmptyInboxDraft,
  recoverInboxDraft,
} from "./inbox-capture-state";
import {
  useInboxCapture,
  useInboxCaptureState,
  type InboxSubmitOutcome,
} from "./use-inbox-capture";
import { useInboxActions } from "./use-inbox-actions";
import { prepareInboxConfirmation, dispatchInboxEntries } from "@/lib/inbox-runtime";
import { createBoundedOperationId } from "../../../shared/operation-identity";
import { CoreApiError } from "@/lib/core-api-error";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { InboxCaptureRecovery } from "./inbox-capture-recovery";
import { InboxComposer } from "./inbox-composer";

vi.mock("./use-inbox-reply-destination", () => ({ useInboxReplyDestination: () => null }));

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
  failAtMutation: number | null = null;
  mutationCount = 0;
  readonly listeners = new Set<(event: PersistedAtomEvent) => void>();
  readSnapshot = async () => this.snapshot;
  mutate = async (input: PersistedAtomMutation): Promise<PersistedAtomEvent> => {
    this.mutationCount += 1;
    if (this.failNext || this.failAtMutation === this.mutationCount) {
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
  epoch: string | null = "epoch:1",
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
  test.each(["saved", "failed"] as const)(
    "a reply being saved never offers Retry before its %s receipt, without entering the open stream",
    async (outcome) => {
      const store = createMaitaiStore();
      const persistence = new MemoryPersistence();
      const draft = {
        ...EMPTY_INBOX_DRAFT,
        text: "Cedar",
        replyTo: { pageId: "post", label: "Choose a label" },
      };
      persistence.snapshot = {
        revision: 0,
        values: {
          [inboxCaptureStorageKey("window:reply", LIBRARY_INBOX)]: {
            ...EMPTY_INBOX_CAPTURE_STATE,
            draft,
          },
        },
      };
      setMaitaiPersistenceTransport(store, persistence);
      let finish!: (result: InboxSendResult) => void;
      let fail!: (error: Error) => void;
      const onSend = vi.fn(
        () =>
          new Promise<InboxSendResult>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      );
      function Form() {
        const input = {
          windowSessionId: "window:reply",
          scope: LIBRARY_INBOX,
          storeEpoch: "epoch:1",
          visiblePageIds: [],
          onSend,
        };
        const capture = useInboxCapture(input);
        const observer = useInboxCapture(input);
        return (
          <>
            <InboxCaptureRecovery
              captures={observer.pending}
              storeEpoch="epoch:1"
              ready={capture.ready}
              onRetry={capture.retry}
              onRecover={capture.recover}
            />
            <InboxComposer
              draft={capture.draft}
              onDraftChange={capture.changeDraft}
              images={null}
              disabled={!capture.ready || capture.savingDraft}
              readOnly={!capture.canEdit || capture.savingDraft}
              onSend={capture.submit}
            />
          </>
        );
      }
      const view = render(
        <MaitaiProvider store={store}>
          <Form />
        </MaitaiProvider>,
      );
      try {
        await waitFor(() =>
          expect(
            (screen.getByRole("button", { name: "Send to Inbox" }) as HTMLButtonElement).disabled,
          ).toBe(false),
        );
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Send to Inbox" }));
          await Promise.resolve();
        });
        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
        expect(
          (screen.getByRole("textbox", { name: "Message your Inbox" }) as HTMLTextAreaElement)
            .value,
        ).toBe("Cedar");
        expect(
          (screen.getByRole("button", { name: "Send to Inbox" }) as HTMLButtonElement).disabled,
        ).toBe(true);
        const savedCapture = decodeInboxCaptureState(
          persistence.snapshot.values[inboxCaptureStorageKey("window:reply", LIBRARY_INBOX)],
        ).captures[0]!;
        if (outcome === "failed") {
          await act(async () => fail(new Error("Save response lost")));
          const retry = await screen.findByRole("button", { name: "Retry" });
          await act(async () => {
            fireEvent.click(retry);
            await Promise.resolve();
          });
          await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
          expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
          expect(
            decodeInboxCaptureState(
              persistence.snapshot.values[inboxCaptureStorageKey("window:reply", LIBRARY_INBOX)],
            ).captures[0]?.intent,
          ).toEqual(savedCapture.intent);
        }
        await act(async () => finish({ pageId: savedCapture.intent.pageId, state: "saved" }));
        await waitFor(() =>
          expect(
            (screen.getByRole("textbox", { name: "Message your Inbox" }) as HTMLTextAreaElement)
              .value,
          ).toBe(""),
        );
        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      } finally {
        view.unmount();
        disposeMaitaiStore(store);
      }
    },
  );

  test("carries a trimmed title into a capture, clears it on consume, and restores it on recovery", () => {
    const draft = { title: "  *Release* [notes]  ", text: "Prepare the release", images: [] };
    const state = { ...EMPTY_INBOX_CAPTURE_STATE, draft };
    const capture = createInboxCapture(state, LIBRARY_INBOX, "epoch:1");
    expect(capture.intent.title).toBe("*Release* [notes]");
    expect(consumeInboxDraft(state, capture).draft).toEqual(EMPTY_INBOX_DRAFT);
    expect(recoverInboxDraft(EMPTY_INBOX_DRAFT, capture.draft)).toEqual(draft);

    const newer = changeInboxDraft(state, (current) => ({ ...current, title: "New title" }));
    expect(consumeInboxDraft(newer, capture).draft).toEqual(newer.draft);
    expect(recoverInboxDraft(newer.draft, capture.draft).title).toBe("New title");
  });

  test("a reply carries the post it answers into its capture and back on recovery", () => {
    const replyTo = { pageId: "page:post", label: "README typo fixed" };
    const draft = { ...EMPTY_INBOX_DRAFT, text: "Also fix CONTRIBUTING", replyTo };
    const state = { ...EMPTY_INBOX_CAPTURE_STATE, draft };
    const capture = createInboxCapture(state, LIBRARY_INBOX, "epoch:1");
    expect(capture.intent.replyToPageId).toBe("page:post");
    expect(consumeInboxDraft(state, capture).draft.replyTo).toBeUndefined();
    expect(recoverInboxDraft(EMPTY_INBOX_DRAFT, capture.draft).replyTo).toEqual(replyTo);
    // A reply alone says nothing yet, and an ordinary message names no post.
    expect(isEmptyInboxDraft({ ...EMPTY_INBOX_DRAFT, replyTo })).toBe(true);
    expect(
      createInboxCapture(
        { ...EMPTY_INBOX_CAPTURE_STATE, draft: { ...EMPTY_INBOX_DRAFT, text: "Hi" } },
        LIBRARY_INBOX,
        "epoch:1",
      ).intent,
    ).not.toHaveProperty("replyToPageId");
  });

  test("a title alone is empty and blank titles are omitted from capture intents", () => {
    expect(isEmptyInboxDraft({ ...EMPTY_INBOX_DRAFT, title: "A label" })).toBe(true);
    expect(
      isEmptyInboxDraft({
        ...EMPTY_INBOX_DRAFT,
        title: "A label",
        images: [{ fileId: "shot", name: "shot.png" }],
      }),
    ).toBe(false);
    const state = {
      ...EMPTY_INBOX_CAPTURE_STATE,
      draft: { ...EMPTY_INBOX_DRAFT, title: " \t ", text: "Message" },
    };
    expect(createInboxCapture(state, LIBRARY_INBOX, "epoch:1").intent).not.toHaveProperty("title");
  });

  test("decodes saved drafts and pending captures written before titles were available", () => {
    const draft = { text: "Older draft", images: [] };
    const capture = createInboxCapture(
      { ...EMPTY_INBOX_CAPTURE_STATE, draft: { ...draft, title: "" } },
      LIBRARY_INBOX,
      "epoch:1",
    );
    const decoded = decodeInboxCaptureState({
      ...EMPTY_INBOX_CAPTURE_STATE,
      draft,
      captures: [{ ...capture, draft }],
    });
    expect(decoded.draft).toEqual({ ...draft, title: "" });
    expect(decoded.captures[0]?.draft).toEqual({ ...draft, title: "" });
    expect(decoded.captures[0]?.intent).toEqual(capture.intent);
  });

  test("reports unsent for unready, title-only, and invalid drafts, then sent after saving", async () => {
    const onSend = vi.fn(saved);
    const hook = setup(new MemoryPersistence(), "window:submit-outcome", onSend, null);
    try {
      await waitFor(() => expect(hook.result.current.canEdit).toBe(true));
      await act(async () => {
        expect(await hook.result.current.submit()).toBe("unsent");
      });
      hook.rerender({ visiblePageIds: [], storeEpoch: "epoch:1" });
      await act(async () => {
        hook.result.current.changeDraft((draft) => ({ ...draft, title: "A label" }));
      });
      await act(async () => {
        expect(await hook.result.current.submit()).toBe("unsent");
      });
      await act(async () => {
        hook.result.current.changeDraft((draft) => ({
          ...draft,
          title: "Two\nlines",
          text: "A message",
        }));
      });
      await act(async () => {
        expect(await hook.result.current.submit()).toBe("unsent");
      });
      expect(hook.result.current.validationError).toBeTruthy();
      expect(onSend).not.toHaveBeenCalled();
      await act(async () => {
        hook.result.current.changeDraft((draft) => ({ ...draft, title: "  *Final* [label]  " }));
      });
      await act(async () => {
        expect(await hook.result.current.submit()).toBe("sent");
      });
      expect(onSend).toHaveBeenCalledWith(
        expect.objectContaining({ title: "*Final* [label]", body: "A message" }),
      );
      expect(hook.result.current.draft).toEqual(EMPTY_INBOX_DRAFT);
      expect(hook.result.current.pending).toEqual([]);
    } finally {
      hook.dispose();
    }
  });

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
      let first!: Promise<InboxSubmitOutcome>;
      await act(async () => {
        first = hook.result.current.submit();
        await Promise.resolve();
      });
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
      expect(hook.result.current.draft.text).toBe("");
      await act(async () => {
        hook.result.current.changeDraft((draft) => ({ ...draft, text: "B" }));
        rejectFirst(new Error("response lost"));
        expect(await first).toBe("failed");
      });
      expect(hook.result.current.draft.text).toBe("B");
      expect(hook.result.current.pending[0]?.intent.body).toBe("A");
      await act(async () => {
        await hook.result.current.retry(hook.result.current.pending[0]!);
      });
      expect(onSend.mock.calls[1]?.[0]).toEqual(onSend.mock.calls[0]?.[0]);
      // The receipt is sufficient even when delivery moves A out of the visible stream.
      expect(hook.result.current.pending).toEqual([]);
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
        expect(await hook.result.current.submit()).toBe("unsent");
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
      expect(hook.result.current.pending).toEqual([]);
      await act(async () => {
        await hook.result.current.submit();
      });
      expect(onSend).toHaveBeenCalledTimes(1);
    } finally {
      hook.dispose();
    }
  });

  test("reports failed when clearing the captured draft could not be persisted, then retries it", async () => {
    const persistence = new MemoryPersistence();
    const onSend = vi.fn(saved);
    const hook = setup(persistence, "window:consume-disk-failure", onSend);
    try {
      await waitFor(() => expect(hook.result.current.ready).toBe(true));
      await act(async () => {
        hook.result.current.changeDraft((draft) => ({
          ...draft,
          title: "A captured label",
          text: "A captured message",
        }));
      });
      persistence.failAtMutation = persistence.mutationCount + 2;
      await act(async () => {
        expect(await hook.result.current.submit()).toBe("failed");
      });
      expect(onSend).not.toHaveBeenCalled();
      expect(hook.result.current.draft).toEqual(EMPTY_INBOX_DRAFT);
      expect(hook.result.current.pending).toHaveLength(1);
      expect(hook.result.current.error?.message).toBe("disk unavailable");
      await act(async () => {
        await hook.result.current.retryPersistence();
      });
      await act(async () => {
        expect(await hook.result.current.retry(hook.result.current.pending[0]!)).toBe("sent");
      });
      expect(onSend).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ title: "A captured label", body: "A captured message" }),
      );
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
      title: "",
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
        expect(await hook.result.current.submit()).toBe("sent");
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
          title: "Check this capture",
          text: "Check whether this was saved",
          images: [{ fileId: "shot", name: "shot.png" }],
        }));
      });
      await act(async () => {
        expect(await hook.result.current.submit()).toBe("failed");
      });
      const capture = hook.result.current.pending[0]!;
      expect(capture.status).toBe("needs_review");
      // The images lead the message body, as they show above its text.
      expect(capture.intent.body).toBe("![](nodex://files/shot)\n\nCheck whether this was saved");
      await act(async () => {
        await hook.result.current.retry(capture);
      });
      expect(onSend).toHaveBeenCalledTimes(1);
      await act(async () => {
        await hook.result.current.recover(capture);
      });
      expect(hook.result.current.draft).toEqual({
        title: "Check this capture",
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
      const action = inboxNewChatAction(null, "The edited prompt");
      vi.mocked(prepareInboxConfirmation).mockImplementation(async (draft) => ({
        ...draft,
        operationId: createBoundedOperationId("inbox.confirm"),
        proposalId: createUuidV7(),
        sessionId: createUuidV7(),
        executionSelection: {
          modelSelection: { instanceId: "codex", model: "frozen-model" },
          interactionMode: "default",
          worktree: true,
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
