import { expect, it, describe, test, afterEach, vi } from "vite-plus/test";
import {
  INITIAL_CONVERSATION_RESUME_RETRY,
  conversationResumeTimeoutMs,
  nextConversationResumeRetry,
  conversationResumeRequestOptions,
} from "./codex-conversation-resume-retry";
import {
  shouldKeepCodexConversationLoaded,
  projectCodexConversationAfterUnsubscribe,
  canReleasePassiveCodexHistory,
  projectCodexConversationWithoutHistory,
} from "./codex-conversation-retention";
import type { CodexConversationSnapshot } from "./types";
import { applyPatches, enablePatches, type Patch } from "immer";
import { ConversationStream, type ConversationStreamOptions } from "./codex-conversation-stream";
import type { ConversationFollowerRequest } from "./codex-client-coordination";
import {
  ConversationCoordinationViewTarget,
  type ConversationCoordinationManager,
} from "./codex-coordination-view";

describe("codex conversation resume retry", () => {
  const closing = "thread thread is closing; retry thread/resume after the thread is closed";

  it.each([undefined, 0, 250_000])(
    "reconnect timeout retries stay with the recovery controller despite caller deadline %s",
    (callerDeadline) => {
      const options = conversationResumeRequestOptions(true, callerDeadline);
      expect(options).toEqual({ priority: "interactive", timeoutMs: 30_000 });
      expect(
        nextConversationResumeRetry(
          INITIAL_CONVERSATION_RESUME_RETRY,
          "thread",
          "Timeout",
          options.timeoutMs,
        ),
      ).toBeNull();
      expect(
        nextConversationResumeRetry(
          INITIAL_CONVERSATION_RESUME_RETRY,
          "thread",
          closing,
          options.timeoutMs,
        )?.delayMs,
      ).toBe(750);
    },
  );

  it("keeps closing and timeout retry budgets independent when failures alternate", () => {
    let state = INITIAL_CONVERSATION_RESUME_RETRY;
    const observed: number[][] = [];
    for (const error of [closing, "Timeout", closing, "Timeout", closing, closing]) {
      const next = nextConversationResumeRetry(state, "thread", error);
      if (!next) throw new Error("Expected another admitted resume attempt");
      state = next.state;
      observed.push([next.delayMs, conversationResumeTimeoutMs(state)]);
    }
    expect(observed).toEqual([
      [750, 120_000],
      [750, 240_000],
      [1500, 240_000],
      [750, 480_000],
      [3000, 480_000],
      [6000, 480_000],
    ]);
    expect(nextConversationResumeRetry(state, "thread", closing)).toBeNull();
    expect(nextConversationResumeRetry(state, "thread", "Timeout")).toBeNull();
  });

  it.each([0, 30_000])(
    "preserves an explicit %i ms deadline and only retries closing",
    (timeoutMs) => {
      expect(conversationResumeTimeoutMs(INITIAL_CONVERSATION_RESUME_RETRY, timeoutMs)).toBe(
        timeoutMs,
      );
      expect(
        nextConversationResumeRetry(
          INITIAL_CONVERSATION_RESUME_RETRY,
          "thread",
          "Timeout",
          timeoutMs,
        ),
      ).toBeNull();
      const next = nextConversationResumeRetry(
        INITIAL_CONVERSATION_RESUME_RETRY,
        "thread",
        closing,
        timeoutMs,
      )!;
      expect(next.delayMs).toBe(750);
      expect(conversationResumeTimeoutMs(next.state, timeoutMs)).toBe(timeoutMs);
    },
  );

  it.each([
    "request timed out",
    "timeout",
    "Host unavailable",
    "Canceled",
    "thread other is closing; retry thread/resume after the thread is closed",
  ])("does not retry a different failure: %s", (message) => {
    expect(
      nextConversationResumeRetry(INITIAL_CONVERSATION_RESUME_RETRY, "thread", message),
    ).toBeNull();
  });
});

describe("codex conversation retention", () => {
  const snapshot = (patch: Partial<CodexConversationSnapshot> = {}): CodexConversationSnapshot =>
    ({
      threadId: "thread",
      statusType: "idle",
      statusActiveFlags: [],
      resumeState: "resumed",
      turns: [{ threadId: "thread", turnId: "turn", status: "completed", items: [], itemIds: [] }],
      requests: [],
      pendingSteers: [],
      ...patch,
    }) as CodexConversationSnapshot;

  describe("conversation history retention", () => {
    test("protects steering until its server message echo, even after command acknowledgement", () => {
      const conversation = snapshot();
      const canonical = {
        ...{ rolloutPath: "/rollout" },
        requests: [],
        turns: [
          {
            items: [
              {
                type: "steeringUserMessage",
                status: "accepted",
                serverUserMessageId: null as string | null,
              },
            ],
          },
        ],
      };
      conversation.canonicalState = canonical as unknown as NonNullable<
        CodexConversationSnapshot["canonicalState"]
      >;
      expect(shouldKeepCodexConversationLoaded(conversation)).toBe(true);
      canonical.turns[0]!.items[0]!.serverUserMessageId = "echo";
      expect(shouldKeepCodexConversationLoaded(conversation)).toBe(false);
    });
    test("protects a proven empty unpersisted conversation but not an unloaded history window", () => {
      const conversation = snapshot({
        turns: [],
        canonicalState: {
          ...{ rolloutPath: null },
          turns: [],
          requests: [],
        } as unknown as NonNullable<CodexConversationSnapshot["canonicalState"]>,
      });
      expect(shouldKeepCodexConversationLoaded(conversation)).toBe(true);
      conversation.turnPagination = {
        olderCursor: null,
        backwardsCursor: null,
        oldestLoadedTurnId: null,
        isLoadingOlder: false,
        hasLoadedOldest: false,
        loadedTurnCount: 0,
        itemsView: "full",
      };
      expect(shouldKeepCodexConversationLoaded(conversation)).toBe(false);
    });
    test("allows a persistent waiting turn to unsubscribe while retaining the question and status", () => {
      const conversation = snapshot({
        turns: [
          { threadId: "thread", turnId: "turn", status: "inProgress", items: [], itemIds: [] },
        ],
        requests: [
          {
            type: "userInput",
            requestId: 1,
            threadId: "thread",
            turnId: "turn",
            questions: [],
            isBlocking: true,
          } as unknown as CodexConversationSnapshot["requests"][number],
        ],
      });
      expect(shouldKeepCodexConversationLoaded(conversation)).toBe(false);
      const after = projectCodexConversationAfterUnsubscribe(conversation, false);
      expect(after.turns).toEqual([]);
      expect(after.requests).toBe(conversation.requests);
      expect(after.statusActiveFlags).toEqual(["waitingOnUserInput"]);
      expect(after.resumeState).toBe("needs_resume");
      expect(
        shouldKeepCodexConversationLoaded({
          ...conversation,
          ephemeral: true,
          source: { parentThreadId: "parent", sideConversation: true },
        }),
      ).toBe(true);
    });
  });

  test("releases passive content but preserves explicit pagination, active hydration, requests and fork-only history", () => {
    const conversation = snapshot({
      turns: [
        {
          threadId: "thread",
          turnId: "turn",
          status: "completed",
          itemIds: ["message"],
          items: [
            {
              threadId: "passive",
              turnId: "turn",
              itemId: "message",
              type: "agentMessage",
              kind: "assistantMessage",
              markdownText: "history",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      ],
    } as Partial<CodexConversationSnapshot>);
    expect(canReleasePassiveCodexHistory(conversation)).toBe(true);
    const released = projectCodexConversationWithoutHistory(conversation);
    expect(released.turns).toEqual([]);
    expect(released.statusType).toBe(conversation.statusType);
    expect(released.turnPagination?.hasLoadedOldest).toBe(false);
    expect(canReleasePassiveCodexHistory({ ...conversation, resumeState: "resuming" })).toBe(false);
    expect(canReleasePassiveCodexHistory({ ...conversation, resumeState: "needs_resume" })).toBe(
      false,
    );
    const pagination = released.turnPagination!;
    expect(
      canReleasePassiveCodexHistory({
        ...conversation,
        resumeState: "needs_resume",
        turnPagination: pagination,
      }),
    ).toBe(true);
    expect(
      canReleasePassiveCodexHistory({
        ...conversation,
        resumeState: "needs_resume",
        turnPagination: { ...pagination, olderCursor: "explicit-read" },
      }),
    ).toBe(false);
    expect(
      canReleasePassiveCodexHistory({
        ...conversation,
        turnPagination: { ...pagination, isLoadingOlder: true },
      }),
    ).toBe(false);
    expect(canReleasePassiveCodexHistory({ ...conversation, statusType: "active" })).toBe(false);
    expect(
      canReleasePassiveCodexHistory({
        ...conversation,
        turns: [
          {
            ...conversation.turns[0]!,
            items: [{ ...conversation.turns[0]!.items[0]!, type: "forkedFromConversation" }],
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("codex conversation stream", () => {
  enablePatches();
  type Document = { id: string; text: string };
  const snapshot = (revision: number, text = "initial") => ({
    type: "snapshot" as const,
    revision,
    conversationState: { id: "thread", text },
  });
  const patch = (baseRevision: number, revision: number, text = "updated") => ({
    type: "patches" as const,
    baseRevision,
    revision,
    patches: [{ op: "replace", path: ["text"], value: text }] satisfies Patch[],
  });

  function setup() {
    const documents = new Map<string, Document>([["thread", { id: "thread", text: "initial" }]]);
    const options = {
      hostId: "local",
      isLocalHost: true,
      canHandleOwnerlessDynamicTool: () => false,
      transport: {
        sendState:
          vi.fn<ConversationStreamOptions<Document, Patch, never>["transport"]["sendState"]>(),
        sendFollowing: vi.fn(),
        requestFollowingStatus: vi.fn(),
        setThreadOwnership: vi.fn(),
      },
      getConversation: (id: string) => documents.get(id),
      normalizeSnapshot: (document: Document) => document,
      applyPatches: (document: Document, patches: readonly Patch[]) =>
        applyPatches(document, [...patches]),
      setConversation: (document: Document) => {
        documents.set(document.id, document);
      },
      notifyConversation: vi.fn(),
      onRoleChanged: vi.fn(),
      onFollowersChanged: vi.fn(),
      onOwnerUnavailable: vi.fn(),
      onError: vi.fn(),
      schedule: (callback: () => void, ms: number) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    } satisfies ConversationStreamOptions<Document, Patch, never>;
    return { stream: new ConversationStream(options), documents, ...options };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("conversation stream ownership and publication", () => {
    it("installs the follower role before snapshot callbacks and settles matching waiters", async () => {
      const base = setup();
      const observations: unknown[] = [];
      const stream = new ConversationStream({
        ...base,
        normalizeSnapshot: (document) => {
          observations.push(["normalize", stream.getRole(document.id)]);
          return document;
        },
        setConversation: (document) => {
          observations.push(["install", stream.getRole(document.id)]);
          base.setConversation(document);
        },
        notifyConversation: (id) => {
          observations.push(["notify", stream.getRole(id), stream.getRevision(id)]);
        },
      });
      stream.setFollowing("thread", true);
      stream.setRole("thread", { role: "owner" });
      stream.receiveState("thread", "new-owner", snapshot(2));
      expect(observations).toEqual([
        ["normalize", { role: "owner" }],
        ["install", { role: "follower", ownerClientId: "new-owner" }],
        ["notify", { role: "follower", ownerClientId: "new-owner" }, 2],
      ]);
      expect(stream.ownsConversationHistoryStream("thread")).toBe(false);
      const result = stream.waitForRevision("thread", "new-owner", 3, 100);
      stream.receiveState("thread", "new-owner", snapshot(3));
      await result;
      stream.receiveState("thread", "other-owner", snapshot(1, "replacement"));
      expect(stream.getRevision("thread")).toBe(1);
      expect(base.documents.get("thread")?.text).toBe("replacement");
      stream.dispose();
    });
    it("selects the first window that can acquire a stream, otherwise the last registered activity", () => {
      const { stream } = setup();
      const changed = vi.fn();
      const hidden = {
        canAcquireThreadStream: false,
        routePath: "/a",
        visibilityState: "hidden" as const,
      };
      const a = stream.registerWindowActivity(hidden, changed);
      const b = stream.registerWindowActivity({ ...hidden, routePath: "/b" }, changed);
      expect(stream.getWindowActivity()?.routePath).toBe("/b");
      a.update({ ...hidden, canAcquireThreadStream: true });
      b.update({ ...hidden, routePath: "/b", canAcquireThreadStream: true });
      expect(stream.getWindowActivity()?.routePath).toBe("/a");
      a[Symbol.dispose]();
      a.update(hidden);
      expect(stream.getWindowActivity()?.routePath).toBe("/b");
      expect(changed).toHaveBeenCalledTimes(5);
      stream.dispose();
      b[Symbol.dispose]();
      expect(stream.getWindowActivity()).toBeUndefined();
      expect(changed).toHaveBeenCalledTimes(5);
    });

    it("suppresses follower mutations without suppressing independent thread metadata", () => {
      const base = setup();
      const canHandleOwnerlessDynamicTool = vi.fn(() => true);
      const stream = new ConversationStream({ ...base, canHandleOwnerlessDynamicTool });
      expect(stream.shouldHandleDynamicToolCall(null)).toBe(false);
      expect(stream.shouldHandleDynamicToolCall("thread")).toBe(true);
      stream.setRole("thread", { role: "follower", ownerClientId: "a" });
      for (const method of [
        "turn/started",
        "item/tool/call",
        "thread/started",
        "thread/realtime/itemAdded",
        "thread/realtime/item/started",
        "thread/realtime/item/completed",
        "thread/realtime/item/transcript/delta",
        "thread/status/changed",
        "thread/tokenUsage/updated",
        "error",
      ]) {
        expect(stream.shouldIgnoreThreadMutationAsFollower(method, { threadId: "thread" })).toBe(
          true,
        );
        expect(
          stream.shouldIgnoreThreadMutationAsFollower(method, { thread: { id: "thread" } }),
        ).toBe(true);
        expect(stream.shouldIgnoreThreadMutationAsFollower(method, { threadId: "another" })).toBe(
          false,
        );
      }
      for (const method of [
        "thread/name/updated",
        "thread/settings/updated",
        "thread/goal/updated",
      ]) {
        expect(stream.shouldIgnoreThreadMutationAsFollower(method, { threadId: "thread" })).toBe(
          false,
        );
      }
      expect(stream.shouldHandleDynamicToolCall("thread")).toBe(false);
      expect(stream.ownsConversationHistoryStream("thread")).toBe(false);
      stream.setRole("thread", { role: "owner" });
      expect(stream.shouldHandleDynamicToolCall("thread")).toBe(true);
      expect(stream.ownsConversationHistoryStream("thread")).toBe(true);
      expect(canHandleOwnerlessDynamicTool).toHaveBeenCalledOnce();
    });

    it("counts publication attempts and recipients even if a transport send fails", async () => {
      const { stream, transport } = setup();
      stream.setRole("thread", { role: "owner" });
      stream.receiveFollowing("thread", "a", true);
      stream.receiveFollowing("thread", "b", true);
      transport.sendState.mockRejectedValueOnce(new Error("closed"));
      stream.broadcastPatches("thread", patch(0, 1).patches);
      await Promise.resolve();
      expect(stream.collectSnapshotFields()).toEqual({
        manager_stream_threads_with_followers: 1,
        manager_stream_follower_subscriptions: 2,
        manager_stream_snapshot_publications_total: 2,
        manager_stream_snapshot_recipients_total: 2,
        manager_stream_patch_publications_total: 1,
        manager_stream_patch_recipients_total: 2,
      });
      expect(stream.resetAfterReconnect(true)).toEqual({
        previousStreamingCount: 1,
        previousRoleCount: 1,
      });
      expect(stream.getRole("thread")).toEqual({ role: "owner" });
    });

    it("retains accepted text edits and derives the affected entity set for the presentation store", () => {
      type TextChange = {
        key: { entityKey: string };
        edits: { at: number; deleteCount: number; insert: string }[];
      };
      const base = setup();
      const setConversation = vi.fn();
      const stream = new ConversationStream<Document, Patch, TextChange>({
        ...base,
        transport: { ...base.transport, sendState: vi.fn() },
        setConversation,
      });
      stream.setFollowing("thread", true);
      stream.receiveState("thread", "owner", snapshot(1));
      const acceptedTextChanges: TextChange[] = [
        { key: { entityKey: "turn:a" }, edits: [{ at: 0, deleteCount: 0, insert: "汉" }] },
        { key: { entityKey: "turn:a" }, edits: [{ at: 1, deleteCount: 0, insert: "字" }] },
        { key: { entityKey: "turn:b" }, edits: [{ at: 0, deleteCount: 2, insert: "😀" }] },
      ];
      stream.receiveState("thread", "owner", { ...patch(1, 2), acceptedTextChanges });
      expect(setConversation).toHaveBeenLastCalledWith(
        { id: "thread", text: "updated" },
        {
          patches: patch(1, 2).patches,
          acceptedTranscriptText: {
            changes: acceptedTextChanges,
            turnEntityKeys: new Set(["turn:a", "turn:b"]),
          },
        },
      );
    });

    it("publishes only for followers and reuses the current revision for additional subscriptions", () => {
      const { stream, transport } = setup();
      stream.setRole("thread", { role: "owner" });
      stream.broadcastPatches("thread", patch(0, 1).patches);
      expect(stream.getRevision("thread")).toBeNull();
      expect(transport.sendState).not.toHaveBeenCalled();
      stream.receiveFollowing("thread", "a", true);
      stream.receiveFollowing("thread", "b", true);
      stream.receiveFollowing("thread", "b", true);
      expect(transport.sendState.mock.calls.map((call) => [call[2], call[3].revision])).toEqual([
        [["a"], 1],
        [["b"], 1],
        [["b"], 1],
      ]);
      stream.broadcastPatches("thread", patch(0, 1).patches);
      expect(transport.sendState).toHaveBeenLastCalledWith(
        "thread",
        "local",
        ["a", "b"],
        expect.objectContaining({ baseRevision: 1, revision: 2 }),
      );
      stream.receiveFollowing("thread", "a", false);
      stream.receiveFollowing("thread", "b", false);
      stream.broadcastPatches("thread", patch(0, 1).patches);
      expect(stream.getRevision("thread")).toBe(2);
    });

    it("advances before sending without serializing later publications behind a send result", async () => {
      const { stream, transport, onError } = setup();
      stream.setRole("thread", { role: "owner" });
      stream.receiveFollowing("thread", "a", true);
      transport.sendState.mockImplementation(() => {
        expect(stream.getRevision("thread")).toBe(transport.sendState.mock.lastCall?.[3].revision);
        return Promise.reject(new Error("disconnected"));
      });
      stream.broadcastPatches("thread", patch(0, 1).patches);
      stream.broadcastPatches("thread", patch(0, 1).patches);
      expect(stream.getRevision("thread")).toBe(3);
      expect(transport.sendState).toHaveBeenCalledTimes(3);
      await Promise.resolve();
      expect(onError).toHaveBeenCalledTimes(2);
      expect(stream.getRole("thread")).toEqual({ role: "owner" });
    });

    it("ignores unrequested state, then lets snapshots replace owners and rewind revisions", () => {
      const { stream, documents } = setup();
      stream.receiveState("thread", "a", snapshot(9));
      expect(stream.getRevision("thread")).toBeNull();
      stream.setFollowing("thread", true);
      stream.setRole("thread", { role: "owner" });
      stream.receiveState("thread", "a", snapshot(9));
      stream.receiveState("thread", "b", snapshot(1, "replacement"));
      expect(stream.getRole("thread")).toEqual({ role: "follower", ownerClientId: "b" });
      expect(stream.getRevision("thread")).toBe(1);
      expect(documents.get("thread")?.text).toBe("replacement");
    });

    it("drops mismatched patches and accepts any resulting revision when the base matches", () => {
      const { stream, documents, transport } = setup();
      stream.setFollowing("thread", true);
      stream.receiveState("thread", "a", patch(0, 1));
      stream.receiveState("thread", "a", snapshot(2));
      stream.receiveState("thread", "b", patch(2, 3));
      stream.receiveState("thread", "a", patch(3, 4));
      expect(documents.get("thread")?.text).toBe("initial");
      stream.receiveState("thread", "a", patch(2, 8));
      expect(stream.getRevision("thread")).toBe(8);
      expect(documents.get("thread")?.text).toBe("updated");
      expect(transport.sendState).not.toHaveBeenCalled();
    });

    it("keeps the baseline after patch failure without requesting recovery", () => {
      const { stream, transport, onError } = setup();
      stream.setFollowing("thread", true);
      stream.receiveState("thread", "a", snapshot(2));
      stream.receiveState("thread", "a", {
        ...patch(2, 3),
        patches: [{ op: "replace", path: ["missing", "child"], value: 1 }],
      });
      expect(stream.getRevision("thread")).toBe(2);
      expect(onError).toHaveBeenCalledOnce();
      expect(transport.requestFollowingStatus).not.toHaveBeenCalled();
      expect(transport.sendFollowing).toHaveBeenCalledOnce();
    });

    it("retains stream roles across IPC reset while expiring disconnected follower protection", () => {
      vi.useFakeTimers();
      const { stream, onFollowersChanged } = setup();
      stream.setRole("thread", { role: "owner" });
      stream.receiveFollowing("thread", "a", true);
      stream.resetIpcConnection();
      expect(stream.getFollowerClientIds("thread")).toEqual([]);
      expect(stream.hasFollowersOrPendingReconnect("thread")).toBe(true);
      expect(stream.getRevision("thread")).toBe(1);
      vi.advanceTimersByTime(4_999);
      expect(stream.hasFollowersOrPendingReconnect("thread")).toBe(true);
      vi.advanceTimersByTime(1);
      expect(stream.hasFollowersOrPendingReconnect("thread")).toBe(false);
      expect(onFollowersChanged).toHaveBeenCalledTimes(2);
      expect(stream.getRole("thread")).toEqual({ role: "owner" });
      stream.resetAfterReconnect();
      expect(stream.getRole("thread")).toBeNull();
      expect(stream.getRevision("thread")).toBeNull();
    });

    it("reannounces locally retained follow intents on client connection", () => {
      const { stream, transport } = setup();
      stream.setFollowing("thread", true);
      stream.receiveClientStatus("b", "connected");
      stream.receiveClientStatus("self", "connected", true);
      expect(transport.sendFollowing.mock.calls).toEqual([
        ["thread", "local", true, undefined],
        ["thread", "local", true, ["b"]],
        ["thread", "local", true, undefined],
      ]);
    });

    it("settles history waiters only when the matching owner's revision arrives", async () => {
      const { stream } = setup();
      stream.setFollowing("thread", true);
      stream.receiveState("thread", "a", snapshot(1));
      const settled = vi.fn();
      const result = stream.waitForRevision("thread", "a", 4, 100).then(settled);
      stream.receiveState("thread", "b", patch(1, 4));
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      stream.receiveState("thread", "a", patch(1, 4));
      await result;
      expect(settled).toHaveBeenCalledOnce();
    });

    it.each(["owner-change", "disconnect", "unfollow", "dispose"])(
      "rejects pending waiters on %s",
      async (action) => {
        const { stream } = setup();
        stream.setFollowing("thread", true);
        stream.receiveState("thread", "a", snapshot(1));
        const result = expect(stream.waitForRevision("thread", "a", 4, 100)).rejects.toThrow();
        if (action === "owner-change") stream.receiveState("thread", "b", snapshot(1));
        if (action === "disconnect") stream.receiveClientStatus("a", "disconnected");
        if (action === "unfollow") stream.setFollowing("thread", false);
        if (action === "dispose") stream.dispose();
        await result;
      },
    );
  });
});

describe("codex coordination view", () => {
  it("waits for the selected manager role and resolves a fresh manager for the next call", async () => {
    let resolve!: (role: { role: "owner" }) => void;
    const pending = new Promise<{ role: "owner" }>((done) => {
      resolve = done;
    });
    const first = vi.fn(() => pending);
    let manager: ConversationCoordinationManager = {
      getStreamRole: first,
      handleThreadFollowerRequest: async ({ method }) => ({ method, result: null }),
    };
    const getManager = vi.fn(() => manager);
    const view = new ConversationCoordinationViewTarget(getManager, () => {});
    const settled = vi.fn();
    const role = view.getThreadRole({ hostId: "remote", conversationId: "thread" });
    void role.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(getManager).toHaveBeenCalledWith("remote");
    expect(first).toHaveBeenCalledWith("thread");
    manager = { ...manager, getStreamRole: () => null };
    resolve({ role: "owner" });
    expect(await role).toBe("owner");
    expect(await view.getThreadRole({ hostId: "remote", conversationId: "thread" })).toBe(
      "follower",
    );
  });

  it("propagates asynchronous role failures instead of reporting follower", async () => {
    const failure = new Error("manager unavailable");
    const view = new ConversationCoordinationViewTarget(
      () => ({
        getStreamRole: async () => {
          throw failure;
        },
        handleThreadFollowerRequest: async ({ method }) => ({ method, result: null }),
      }),
      () => {},
    );
    await expect(view.getThreadRole({ hostId: "local", conversationId: "thread" })).rejects.toBe(
      failure,
    );
  });

  it("dispatches validated queue controls only to their current owner and retains the request", async () => {
    const owner = { role: "owner" } as const;
    const handle = vi.fn(async ({ method }: ConversationFollowerRequest) => ({
      method,
      result: { applied: true },
    }));
    const manager = { getStreamRole: () => owner, handleThreadFollowerRequest: handle };
    const view = new ConversationCoordinationViewTarget(
      () => manager,
      () => {},
    );
    const request = {
      method: "thread-follower-remove-queued-message",
      params: { conversationId: "thread", messageId: "native-message" },
    };
    expect(await view.requestThreadFollower({ hostId: "remote", request })).toEqual({
      method: request.method,
      result: { applied: true },
    });
    expect(handle).toHaveBeenCalledWith(request);
    expect(handle.mock.calls[0]?.[0].params).toBe(request.params);
  });

  it("rejects queue controls before dispatch if their owner changed during asynchronous admission", async () => {
    const original = { role: "owner" } as const;
    let resolve!: (role: typeof original) => void;
    const pending = new Promise<typeof original>((done) => {
      resolve = done;
    });
    const handle = vi.fn(async ({ method }: { method: string }) => ({
      method,
      result: { applied: true },
    }));
    let role: { role: "owner" | "follower" } = original;
    let reads = 0;
    const manager = {
      getStreamRole: () => (reads++ === 0 ? pending : role),
      handleThreadFollowerRequest: handle,
    };
    const view = new ConversationCoordinationViewTarget(
      () => manager,
      () => {},
    );
    const request = view.requestThreadFollower({
      hostId: "local",
      request: {
        method: "thread-follower-clear-queued-messages",
        params: { conversationId: "thread" },
      },
    });
    role = { role: "owner" };
    resolve(original);
    await expect(request).rejects.toThrow("owner changed");
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects malformed requests and direct follower targets before queue side effects", async () => {
    const handle = vi.fn(async ({ method }: { method: string }) => ({
      method,
      result: { applied: true },
    }));
    const manager = {
      getStreamRole: () => ({ role: "follower" }) as const,
      handleThreadFollowerRequest: handle,
    };
    const getManager = vi.fn(() => manager);
    const view = new ConversationCoordinationViewTarget(getManager, () => {});
    await expect(
      view.requestThreadFollower({
        hostId: "local",
        request: {
          method: "thread-follower-remove-queued-message",
          params: { conversationId: "thread" },
        },
      }),
    ).rejects.toThrow("identity");
    expect(getManager).not.toHaveBeenCalled();
    await expect(
      view.requestThreadFollower({
        hostId: "local",
        request: {
          method: "thread-follower-clear-queued-messages",
          params: { conversationId: "thread" },
        },
      }),
    ).rejects.toThrow("not the owner");
    expect(handle).not.toHaveBeenCalled();
  });

  it("does not confirm a queued control after its receiving owner incarnation is replaced", async () => {
    let owner = { role: "owner" } as const;
    let release!: (value: { method: string; result: { applied: boolean } }) => void;
    const pending = new Promise<{ method: string; result: { applied: boolean } }>((resolve) => {
      release = resolve;
    });
    const handle = vi.fn(() => pending);
    const view = new ConversationCoordinationViewTarget(
      () => ({ getStreamRole: () => owner, handleThreadFollowerRequest: handle }),
      () => {},
    );
    const received = view.requestThreadFollower({
      hostId: "remote",
      request: {
        method: "thread-follower-clear-queued-messages",
        params: { conversationId: "thread" },
      },
    });
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
    owner = { role: "owner" };
    release({ method: "thread-follower-clear-queued-messages", result: { applied: true } });
    await expect(received).rejects.toThrow("changed before confirmation");
  });
});
