import { produce } from "immer";
import { replaceCanonicalHistoryDraft } from "./codex-conversation-state/codex-canonical-history-loader";
import {
  releaseCanonicalConversationHistoryDraft,
  completeCanonicalConversationUnsubscribeDraft,
  shouldKeepCanonicalConversationLoaded,
  selectCanonicalRetentionRequestKind,
} from "./codex-canonical-retention";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  CanonicalConversationRetention,
  CANONICAL_OWNER_RETENTION_MS,
  CANONICAL_OWNER_RETRY_MS,
} from "./codex-canonical-retention";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalConversationState,
} from "./codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";

function document(id: string): CodexCanonicalConversationState {
  const thread = buildAgentActivityV2CorpusThread([
    {
      type: "agentMessage",
      id: "answer",
      text: "Retained history",
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
      questions: null,
    },
  ]);
  const state = createCodexCanonicalHydratedConversationState(
    { ...thread, id },
    {
      hostId: "local",
      model: "test",
      reasoningEffort: null,
      cwd: "/repo",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/repo"],
    },
  );
  return {
    ...state,
    resumeState: "resumed",
    turns: state.turns.map((turn) => ({ ...turn, status: "completed" })),
  };
}
function fixture() {
  const states = new Map<string, CodexCanonicalConversationState>();
  const roles = new Map<string, "owner" | "follower">();
  const active = new Set<string>();
  const followers = new Set<string>();
  const keep = new Set<string>();
  const ephemeral = new Set<string>();
  const unsubscribe = vi.fn(async (_id: string): Promise<unknown> => ({ status: "unsubscribed" }));
  const releaseHistory = vi.fn((id: string) => {
    const state = states.get(id);
    if (state) states.set(id, { ...state, turns: [], resumeState: "needs_resume" });
  });
  const completeUnsubscribe = vi.fn(
    (id: string, options: { retainHistory: boolean; ephemeral: boolean }) => {
      const state = states.get(id);
      if (!state) return;
      states.set(id, {
        ...state,
        resumeState: "needs_resume",
        ...(options.retainHistory ? {} : { turns: [] }),
      });
    },
  );
  const clearOwnership = vi.fn((id: string) => {
    roles.delete(id);
  });
  const retention = new CanonicalConversationRetention({
    getConversation: (id) => states.get(id),
    getRole: (id) => roles.get(id) ?? null,
    ownsHistory: (id) => roles.get(id) === "owner",
    hasActiveView: (id) => active.has(id),
    hasFollowers: (id) => followers.has(id),
    shouldKeepLoaded: (state) => keep.has(state.id),
    isEphemeralSide: (state) => ephemeral.has(state.id),
    unsubscribe,
    releaseHistory,
    completeUnsubscribe,
    clearOwnership,
    now: () => Date.now(),
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
    scheduleMicrotask: queueMicrotask,
  });
  const add = (id: string) => {
    states.set(id, document(id));
    roles.set(id, "owner");
    retention.reconcile(id);
  };
  return {
    states,
    roles,
    active,
    followers,
    keep,
    ephemeral,
    unsubscribe,
    releaseHistory,
    completeUnsubscribe,
    clearOwnership,
    retention,
    add,
  };
}
afterEach(() => vi.useRealTimers());
function clock() {
  vi.useFakeTimers();
  vi.setSystemTime(0);
}

describe("manager-owned history retention", () => {
  test("ordinary count overage retires the oldest subscription only within that manager", async () => {
    clock();
    const first = fixture();
    const second = fixture();
    for (let index = 0; index < 10; index++) {
      first.add(`a${index}`);
      second.add(`b${index}`);
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(first.unsubscribe).not.toHaveBeenCalled();
    first.add("a10");
    await vi.advanceTimersByTimeAsync(0);
    expect(first.unsubscribe.mock.calls).toEqual([["a0"]]);
    expect(second.unsubscribe).not.toHaveBeenCalled();
    expect(first.completeUnsubscribe).toHaveBeenCalledWith("a0", {
      retainHistory: false,
      ephemeral: false,
    });
    expect(first.roles.has("a0")).toBe(false);
    first.retention.dispose();
    second.retention.dispose();
  });
  test("ephemeral side conversations do not count toward overage but expire with history retained", async () => {
    clock();
    const f = fixture();
    f.ephemeral.add("side");
    f.add("side");
    for (let index = 0; index < 10; index++) f.add(`thread${index}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.unsubscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CANONICAL_OWNER_RETENTION_MS);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.completeUnsubscribe).toHaveBeenCalledWith("side", {
      retainHistory: true,
      ephemeral: true,
    });
    expect(f.states.get("side")?.turns).toHaveLength(1);
    expect(f.states.get("thread0")?.turns).toHaveLength(0);
    f.retention.dispose();
  });
  test("kept-loaded state resets the inactivity clock when it becomes releasable", async () => {
    clock();
    const f = fixture();
    f.add("thread");
    await vi.advanceTimersByTimeAsync(CANONICAL_OWNER_RETENTION_MS / 2);
    f.keep.add("thread");
    f.retention.reconcile("thread");
    await vi.advanceTimersByTimeAsync(CANONICAL_OWNER_RETENTION_MS * 2);
    expect(f.unsubscribe).not.toHaveBeenCalled();
    f.keep.delete("thread");
    f.retention.reconcile("thread");
    await vi.advanceTimersByTimeAsync(CANONICAL_OWNER_RETENTION_MS - 1);
    expect(f.unsubscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    f.retention.dispose();
  });
  test("native unsubscribe failure retries after fifteen seconds without clearing state or ownership", async () => {
    clock();
    const f = fixture();
    f.unsubscribe.mockRejectedValueOnce(new Error("offline"));
    f.add("thread");
    await vi.advanceTimersByTimeAsync(CANONICAL_OWNER_RETENTION_MS);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.roles.get("thread")).toBe("owner");
    expect(f.completeUnsubscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CANONICAL_OWNER_RETRY_MS - 1);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(f.unsubscribe).toHaveBeenCalledTimes(2);
    expect(f.roles.has("thread")).toBe(false);
    f.retention.dispose();
  });
  test.each(["view", "follower", "keep"] as const)(
    "reactivation by %s during native I/O retains history while retiring the old subscription",
    async (kind) => {
      clock();
      const f = fixture();
      let finish!: () => void;
      f.unsubscribe.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      f.add("thread");
      await vi.advanceTimersByTimeAsync(CANONICAL_OWNER_RETENTION_MS);
      await vi.advanceTimersByTimeAsync(2);
      expect(f.unsubscribe).toHaveBeenCalledOnce();
      (kind === "view" ? f.active : kind === "follower" ? f.followers : f.keep).add("thread");
      f.retention.reconcile("thread");
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.completeUnsubscribe).toHaveBeenCalledWith("thread", {
        retainHistory: true,
        ephemeral: false,
      });
      expect(f.roles.has("thread")).toBe(false);
      expect(f.states.get("thread")?.turns).toHaveLength(1);
      f.retention.dispose();
    },
  );
  test("views and follower reconnects block inactivity tracking until their last interest disappears", async () => {
    clock();
    const f = fixture();
    f.active.add("view");
    f.followers.add("followed");
    f.add("view");
    f.add("followed");
    await vi.advanceTimersByTimeAsync(CANONICAL_OWNER_RETENTION_MS * 2);
    expect(f.unsubscribe).not.toHaveBeenCalled();
    f.active.delete("view");
    f.retention.activityChanged("view", false);
    f.followers.delete("followed");
    f.retention.reconcile("followed");
    await vi.advanceTimersByTimeAsync(CANONICAL_OWNER_RETENTION_MS - 1);
    expect(f.unsubscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(f.unsubscribe.mock.calls).toEqual([["view"], ["followed"]]);
    f.retention.dispose();
  });
  test("passive history waits for its physical page load and rechecks activity before releasing", async () => {
    clock();
    const f = fixture();
    const state = document("passive");
    f.states.set("passive", {
      ...state,
      turnsPagination: {
        olderCursor: "older",
        oldestLoadedTurnId: "turn",
        isLoadingOlder: true,
        hasLoadedOldest: false,
      },
    });
    f.retention.notificationHandled("passive");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.releaseHistory).not.toHaveBeenCalled();
    f.active.add("passive");
    f.states.set("passive", {
      ...state,
      turnsPagination: {
        olderCursor: "older",
        oldestLoadedTurnId: "turn",
        isLoadingOlder: false,
        hasLoadedOldest: false,
      },
    });
    f.retention.reconcile("passive");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.releaseHistory).not.toHaveBeenCalled();
    f.active.delete("passive");
    f.retention.activityChanged("passive", false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.releaseHistory).toHaveBeenCalledWith("passive");
    expect(f.unsubscribe).not.toHaveBeenCalled();
    f.retention.dispose();
  });
  test("disposing cancels the manager's pending cleanup timer", async () => {
    clock();
    const f = fixture();
    f.add("thread");
    f.retention.dispose();
    await vi.advanceTimersByTimeAsync(CANONICAL_OWNER_RETENTION_MS * 2);
    expect(f.unsubscribe).not.toHaveBeenCalled();
  });
});

test("releasing canonical history advances the history generation without losing pending requests", () => {
  const initial = document("thread");
  const state = produce(initial, (draft) => {
    replaceCanonicalHistoryDraft(draft, [...initial.turns], true);
    draft.turnsPagination = {
      olderCursor: "older",
      oldestLoadedTurnId: "turn",
      isLoadingOlder: false,
      hasLoadedOldest: false,
    };
  });
  const released = produce(state, releaseCanonicalConversationHistoryDraft);
  expect(released.turnHistory?.history.generation).toBe(
    (state.turnHistory?.history.generation ?? 0) + 1,
  );
  expect(released.turnHistory?.history.entitiesByKey).toEqual({});
  expect(released.turnHistory?.history.isComplete).toBe(false);
  expect(released.turnsPagination).toEqual({
    olderCursor: null,
    oldestLoadedTurnId: null,
    isLoadingOlder: false,
    hasLoadedOldest: false,
  });
  expect(released.resumeState).toBe("needs_resume");
  expect(released.requests).toBe(state.requests);
  expect(released.updatedAt).toBe(state.updatedAt);
});

test("unsubscribe preserves a blocking request's runtime status and ephemeral history", () => {
  const state = document("thread");
  const blocked = produce(state, (draft) =>
    completeCanonicalConversationUnsubscribeDraft(draft, {
      retainHistory: true,
      ephemeral: false,
      primaryRequest: "userInput",
    }),
  );
  expect(blocked.threadRuntimeStatus).toEqual({
    type: "active",
    activeFlags: ["waitingOnUserInput"],
  });
  expect(blocked.turns).toBe(state.turns);
  const ephemeral = produce(state, (draft) =>
    completeCanonicalConversationUnsubscribeDraft(draft, {
      retainHistory: false,
      ephemeral: true,
      primaryRequest: null,
    }),
  );
  expect(ephemeral.threadRuntimeStatus).toEqual({ type: "notLoaded" });
  expect(ephemeral.turns).toBe(state.turns);
  expect(
    produce(blocked, (draft) =>
      completeCanonicalConversationUnsubscribeDraft(draft, {
        retainHistory: false,
        ephemeral: false,
        primaryRequest: null,
      }),
    ),
  ).toBe(blocked);
});

test("an empty undurable conversation stays loaded only when history proves it is empty", () => {
  const state = {
    ...document("thread"),
    rolloutPath: "",
    turns: [],
    threadRuntimeStatus: { type: "idle" as const },
  };
  expect(shouldKeepCanonicalConversationLoaded(state, null, false)).toBe(true);
  expect(
    shouldKeepCanonicalConversationLoaded(
      {
        ...state,
        turnsPagination: {
          olderCursor: null,
          oldestLoadedTurnId: null,
          isLoadingOlder: false,
          hasLoadedOldest: false,
        },
      },
      null,
      false,
    ),
  ).toBe(false);
});

test("preserves a provisional owner before the first document arrives", () => {
  vi.useFakeTimers();
  const f = fixture();
  f.roles.set("starting", "owner");
  f.retention.reconcile("starting");
  expect(f.roles.get("starting")).toBe("owner");
  expect(f.clearOwnership).not.toHaveBeenCalled();
  f.retention.remove("starting");
  expect(f.roles.has("starting")).toBe(false);
  f.retention.dispose();
});

test("selects the newest resident request before older approvals and ignores orphan requests", () => {
  const base = document("requests");
  const turn = base.turns[0]!;
  const state = produce(base, (draft) => {
    replaceCanonicalHistoryDraft(
      draft,
      [
        { ...turn, turnId: "older" },
        { ...turn, turnId: "newer" },
      ],
      true,
    );
    draft.requests = [
      {
        id: 1,
        method: "item/commandExecution/requestApproval",
        params: { threadId: base.id, turnId: "older", itemId: "command", kind: "command", startedAtMs: 0, environmentId: null },
      },
      {
        id: 2,
        method: "item/tool/requestUserInput",
        params: { threadId: base.id, turnId: "newer", itemId: "question", questions: [], isBlocking: true, autoResolutionMs: null },
      },
      {
        id: 3,
        method: "item/tool/requestUserInput",
        params: { threadId: base.id, turnId: "orphan", itemId: "orphan", questions: [], isBlocking: true, autoResolutionMs: null },
      },
    ];
  });
  expect(state.turns).toEqual([]);
  expect(selectCanonicalRetentionRequestKind(state)).toBe("userInput");
  expect(
    selectCanonicalRetentionRequestKind({
      ...state,
      requests: state.requests.filter((request) => request.id !== 2),
    }),
  ).toBe("approval");
  expect(
    selectCanonicalRetentionRequestKind({
      ...state,
      requests: state.requests.filter((request) => request.id === 3),
    }),
  ).toBeNull();
});

test("an empty known tail does not treat an older detached in-progress turn as active", () => {
  const state = produce(document("empty-tail"), draft => {
    draft.threadRuntimeStatus = {type: "idle"};
    draft.turns[0]!.status = "inProgress";
    replaceCanonicalHistoryDraft(draft, draft.turns, false);
  });
  expect(shouldKeepCanonicalConversationLoaded(state, null, false)).toBe(true);
  const emptyTail = produce(state, draft => {
    draft.turnHistory!.history.islands.push({id: "empty-tail", entries: [], olderBoundary: {status: "opaque", boundaryId: "gap"}, newerBoundary: {status: "exhausted", boundaryId: "newest"}});
  });
  expect(shouldKeepCanonicalConversationLoaded(emptyTail, null, false)).toBe(false);
});
