import { afterEach, expect, test, vi } from "vite-plus/test";
import type { AgentConversationSnapshot } from "../../../shared/agent-conversation";
import type { CodexHistoryBoundaryRef } from "../../../shared/codex-conversation-state/codex-history-topology";
import type { CodexThreadSummary } from "../../../shared/types";
import { agentBackendRuntime } from "../../lib/agent-backend-runtime";
import {
  acquireNativeConversationHistoryOwner,
  NativeConversationHistoryOwner,
} from "./native-conversation-history-owner";

const summary: CodexThreadSummary = {
  threadId: "native-thread",
  projectId: null,
  source: null,
  threadName: "Imported chat",
  threadPreview: "",
  cwd: "/workspace",
  statusType: "idle",
  statusActiveFlags: [],
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  linkedAt: "2026-10-15T00:00:00Z",
};
const page = (
  sequence: number,
  cursor?: string,
  text = `Answer ${sequence}`,
): AgentConversationSnapshot => ({
  backend: "claude",
  threadId: summary.threadId,
  sessionId: "native-session",
  status: "closed",
  error: null,
  revision: 1,
  history: {
    hasOlder: cursor !== undefined,
    oldestSequence: sequence,
    ...(cursor ? { cursor } : {}),
  },
  turns: [
    {
      sequence,
      clientUserMessageId: null,
      nativeUserMessageId: `user:${sequence}`,
      promptText: `Question ${sequence}`,
      stopReason: "end_turn",
      updates: [
        {
          kind: "message",
          key: `answer:${sequence}`,
          messageId: `answer:${sequence}`,
          role: "agent",
          text,
        },
      ],
    },
  ],
});
const boundaryOf = (owner: NativeConversationHistoryOwner): CodexHistoryBoundaryRef => {
  const row = owner.getSnapshot().view?.historyRows?.find((candidate) => candidate.kind === "gap");
  if (row?.kind !== "gap" || !row.newerBoundary) throw new Error("Expected an older history gap");
  return row.newerBoundary;
};
const deferredPage = () => {
  let resolve!: (value: AgentConversationSnapshot) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<AgentConversationSnapshot>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
};
afterEach(() => vi.restoreAllMocks());

test("Session unread changes update retained native history without reloading its Turns", async () => {
  const read = vi.fn().mockResolvedValue(page(2, "older"));
  const owner = new NativeConversationHistoryOwner({ ...summary, hasUnreadTurn: true }, read);
  const release = owner.retain();
  try {
    await owner.refresh();
    expect(owner.getSnapshot().view?.hasUnreadTurn).toBe(true);
    const turns = owner.getSnapshot().view!.turns;
    owner.updateSummary({ ...summary, hasUnreadTurn: false });
    expect(owner.getSnapshot().view?.hasUnreadTurn).toBe(false);
    owner.updateSummary({ ...summary, hasUnreadTurn: true });
    expect(owner.getSnapshot().view?.hasUnreadTurn).toBe(true);
    expect(owner.getSnapshot().view?.turns).toBe(turns);
    expect(read).toHaveBeenCalledOnce();
  } finally {
    release();
  }
});

test("concurrent readers share one bounded cold page and final release drops all bodies", async () => {
  const read = vi.spyOn(agentBackendRuntime, "history").mockResolvedValue(page(2, "older"));
  const first = acquireNativeConversationHistoryOwner("product-session", summary);
  const second = acquireNativeConversationHistoryOwner("product-session", summary);
  expect(second.owner).toBe(first.owner);
  const releaseFirst = first.retain();
  const releaseSecond = second.retain();
  await first.owner.refresh();
  expect(read).toHaveBeenCalledExactlyOnceWith({ threadId: summary.threadId, limit: 50 });
  expect(first.owner.getSnapshot().view?.turns).toHaveLength(1);
  releaseFirst();
  expect(second.owner.getSnapshot().view).not.toBeNull();
  releaseSecond();
  expect(first.owner.getSnapshot().view).toBeNull();
});

test("older pages publish topology, preserve resident Turn references and share the exact boundary read", async () => {
  const older = deferredPage();
  const read = vi
    .fn()
    .mockResolvedValueOnce(page(2, "native-cursor"))
    .mockReturnValueOnce(older.promise);
  const owner = new NativeConversationHistoryOwner(summary, read);
  const release = owner.retain();
  await owner.refresh();
  const resident = owner.getSnapshot().view!.turns[0];
  const boundary = boundaryOf(owner);
  const loading = owner.loadBoundary(boundary);
  expect(owner.loadBoundary(boundary)).toBe(loading);
  older.resolve({ ...page(1), turns: [...page(1).turns, ...page(2).turns] });
  expect(await loading).toBe("applied");
  const state = owner.getSnapshot();
  expect(read).toHaveBeenLastCalledWith({
    threadId: summary.threadId,
    before: "native-cursor",
    limit: 50,
  });
  expect(state.view!.turns.map((turn) => turn.turnId)).toEqual([
    "native-session:user:1",
    "native-session:user:2",
  ]);
  expect(state.view!.turns[1]).toBe(resident);
  expect(state.view!.historyRows?.map((row) => row.kind)).toEqual(["content", "content"]);
  expect(state.view!.capabilityFlags.canEditUserTurns).toBe(false);
  expect(state.view!.requests).toEqual([]);
  expect(await owner.loadBoundary(boundary)).toBe("stale");
  expect(read).toHaveBeenCalledTimes(2);
  release();
});

test.each(["result", "failure"] as const)(
  "released %s cannot replace or clear a newly retained request",
  async (outcome) => {
    const old = deferredPage();
    const current = deferredPage();
    const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const owner = new NativeConversationHistoryOwner(summary, read);
    const releaseOld = owner.retain();
    const previousLoading = owner.refresh();
    await Promise.resolve();
    releaseOld();
    const releaseCurrent = owner.retain();
    const currentLoading = owner.refresh();
    await Promise.resolve();
    if (outcome === "result") old.resolve(page(1));
    else old.reject(new Error("Old request failed"));
    await previousLoading;
    expect(owner.getSnapshot()).toEqual({ view: null, loading: true, error: null });
    const sharedLoading = owner.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    current.resolve(page(2));
    await Promise.all([currentLoading, sharedLoading]);
    expect(owner.getSnapshot().view?.turns.map((turn) => turn.turnId)).toEqual([
      "native-session:user:2",
    ]);
    releaseCurrent();
  },
);

test("a released boundary read cannot publish into a newly retained history", async () => {
  const old = deferredPage();
  const read = vi
    .fn()
    .mockResolvedValueOnce(page(3, "old-cursor"))
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(page(4, "new-cursor"));
  const owner = new NativeConversationHistoryOwner(summary, read);
  const releaseOld = owner.retain();
  await owner.refresh();
  const boundary = boundaryOf(owner);
  const loading = owner.loadBoundary(boundary);
  await Promise.resolve();
  releaseOld();
  const releaseCurrent = owner.retain();
  await owner.refresh();
  old.resolve(page(1));
  expect(await loading).toBe("stale");
  expect(owner.getSnapshot().view?.turns.map((turn) => turn.turnId)).toEqual([
    "native-session:user:4",
  ]);
  expect(boundaryOf(owner).generation).not.toBe(boundary.generation);
  expect(await owner.loadBoundary(boundary)).toBe("stale");
  releaseCurrent();
});

test("a cold page rejects another Thread without exposing its bodies", async () => {
  const owner = new NativeConversationHistoryOwner(summary, async () => ({
    ...page(1),
    threadId: "foreign",
  }));
  const release = owner.retain();
  await owner.refresh();
  expect(owner.getSnapshot().error).toBe("Native history returned another Thread");
  expect(owner.getSnapshot().view).toBeNull();
  release();
});

test("a cold page with older history but no cursor reports a read error", async () => {
  const owner = new NativeConversationHistoryOwner(summary, async () => ({
    ...page(1),
    history: { hasOlder: true, oldestSequence: 1 },
  }));
  const release = owner.retain();
  await owner.refresh();
  expect(owner.getSnapshot()).toEqual({
    view: null,
    loading: false,
    error: "Native history cursor is unavailable",
  });
  release();
});

test("native history remains traversable beyond cumulative turn, item and byte budgets", async () => {
  let nextPage = 6;
  const read = vi.fn(async (_input: { limit?: number }) => {
    const number = nextPage--;
    return {
      ...page(number * 50, number > 1 ? `page:${number - 1}` : undefined),
      turns: Array.from(
        { length: 50 },
        (_, index) => page((number - 1) * 50 + index + 1, undefined, "x".repeat(4096)).turns[0]!,
      ),
    };
  });
  const owner = new NativeConversationHistoryOwner(summary, read);
  const release = owner.retain();
  await owner.refresh();
  for (let index = 0; index < 5; index += 1) {
    expect(await owner.loadBoundary(boundaryOf(owner))).toBe("applied");
  }
  expect(owner.getSnapshot().view?.turns).toHaveLength(300);
  expect(owner.getSnapshot().view?.turns.flatMap((turn) => turn.items)).toHaveLength(600);
  expect(owner.getSnapshot().view?.historyRows?.every((row) => row.kind === "content")).toBe(true);
  expect(read).toHaveBeenCalledTimes(6);
  expect(read.mock.calls.every(([input]) => input.limit === 50)).toBe(true);
  release();
});

test("hidden pages advance the gap even without visible Turns", async () => {
  const hidden = (cursor: string): AgentConversationSnapshot => ({
    ...page(1, cursor),
    turns: [{ ...page(1).turns[0]!, promptText: "", updates: [] }],
  });
  const read = vi
    .fn()
    .mockResolvedValueOnce(hidden("first"))
    .mockResolvedValueOnce(hidden("second"))
    .mockResolvedValueOnce(page(1));
  const owner = new NativeConversationHistoryOwner(summary, read);
  const release = owner.retain();
  await owner.refresh();
  expect(owner.getSnapshot().view?.turns).toEqual([]);
  expect(await owner.loadBoundary(boundaryOf(owner))).toBe("applied");
  expect(boundaryOf(owner).handle.cursor).toBe("second");
  expect(owner.getSnapshot().view?.turns).toEqual([]);
  expect(await owner.loadBoundary(boundaryOf(owner))).toBe("applied");
  expect(owner.getSnapshot().view?.turns).toHaveLength(1);
  release();
});

test.each([
  ["missing", undefined, "Native history cursor is unavailable"],
  ["empty", "", "Native history cursor is unavailable"],
  ["repeated", "cursor", "Native history cursor did not advance"],
] as const)(
  "a %s continuation fails only its gap and can be retried",
  async (_name, cursor, message) => {
    const malformed = { ...page(1), history: { hasOlder: true, oldestSequence: 1, cursor } };
    const read = vi
      .fn()
      .mockResolvedValueOnce(page(2, "cursor"))
      .mockResolvedValueOnce(malformed)
      .mockResolvedValueOnce(page(1));
    const owner = new NativeConversationHistoryOwner(summary, read);
    const release = owner.retain();
    await owner.refresh();
    const view = owner.getSnapshot().view;
    const boundary = boundaryOf(owner);
    await expect(owner.loadBoundary(boundary)).rejects.toThrow(message);
    expect(owner.getSnapshot()).toEqual({ view, loading: false, error: null });
    expect(await owner.loadBoundary(boundary)).toBe("applied");
    expect(owner.getSnapshot().view?.turns).toHaveLength(2);
    release();
  },
);

test("cursor cycles fail locally instead of reopening already traversed native history", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(page(3, "first"))
    .mockResolvedValueOnce(page(2, "second"))
    .mockResolvedValueOnce(page(1, "first"));
  const owner = new NativeConversationHistoryOwner(summary, read);
  const release = owner.retain();
  await owner.refresh();
  await owner.loadBoundary(boundaryOf(owner));
  const view = owner.getSnapshot().view;
  await expect(owner.loadBoundary(boundaryOf(owner))).rejects.toThrow(
    "Native history cursor did not advance",
  );
  expect(owner.getSnapshot()).toEqual({ view, loading: false, error: null });
  release();
});

test("every boundary identity field is validated before native I/O", async () => {
  const read = vi.fn().mockResolvedValue(page(2, "cursor"));
  const owner = new NativeConversationHistoryOwner(summary, read);
  const release = owner.retain();
  await owner.refresh();
  const boundary = boundaryOf(owner);
  const invalid: CodexHistoryBoundaryRef[] = [
    { ...boundary, generation: boundary.generation + 1 },
    { ...boundary, islandId: "another-island" },
    { ...boundary, edge: "newer" },
    { ...boundary, boundaryId: "another-boundary" },
    { ...boundary, progressKey: "old-progress" },
    { ...boundary, handle: { ...boundary.handle, cursor: "another-cursor" } },
    { ...boundary, handle: { ...boundary.handle, source: "timeline" } },
    { ...boundary, handle: { ...boundary.handle, oldestLoadedTurnId: "another-turn" } },
  ];
  for (const candidate of invalid) expect(await owner.loadBoundary(candidate)).toBe("stale");
  expect(read).toHaveBeenCalledTimes(1);
  release();
});
