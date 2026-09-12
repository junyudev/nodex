import { expect, test } from "vite-plus/test";
import { produce } from "immer";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import { CanonicalCompleteHistoryLoader } from "./codex-complete-history-loader";
import {
  replaceCanonicalHistoryDraft,
  type CanonicalHistoryClient,
} from "./codex-canonical-history-loader";
import {
  createCodexCanonicalHydratedConversationState,
  createCodexCanonicalTurnState,
} from "./codex-conversation-state";
import { residentConversationTurns } from "./codex-turn-mutation";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";

const rawTurn = (id: string): Turn => ({
  id,
  items: [],
  itemsView: "full",
  status: "completed",
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture() {
  const initial = createCodexCanonicalHydratedConversationState(
    { ...buildAgentActivityV2CorpusThread([]), id: "conversation", turns: [rawTurn("tail")] },
    {
      hostId: "local",
      model: "model",
      reasoningEffort: null,
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace"],
    },
  );
  const params = residentConversationTurns(initial)[0]!.params;
  let state = produce(initial, (draft) => {
    const boundary = { cursor: "older", oldestLoadedTurnId: "tail" };
    replaceCanonicalHistoryDraft(draft, residentConversationTurns(initial), false, boundary);
    draft.resumeState = "resumed";
    draft.turnsPagination = {
      olderCursor: "older",
      oldestLoadedTurnId: "tail",
      isLoadingOlder: false,
      hasLoadedOldest: false,
    };
  });
  const calls: { params: unknown; options: unknown }[] = [];
  let snapshots = 0;
  let patches = 0;
  let handler: (params: unknown) => Promise<unknown> = async () => {
    throw new Error("Unexpected request");
  };
  const client: CanonicalHistoryClient = {
    hostId: "local",
    supportsPaginatedHistory: () => true,
    getConversation: () => state,
    async sendRequest<M extends "thread/turns/list" | "thread/items/list">(
      _method: M,
      params: ClientRequestParamsByMethod[M],
      options?: Parameters<CanonicalHistoryClient["sendRequest"]>[2],
    ): Promise<ClientRequestResponsesByMethod[M]> {
      calls.push({ params, options });
      return (await handler(params)) as ClientRequestResponsesByMethod[M];
    },
    updateConversation: (_id, recipe, broadcast = true) => {
      state = produce(state, recipe);
      if (broadcast) patches += 1;
    },
    broadcastSnapshot: () => {
      snapshots += 1;
    },
    mapTurns: (_id, turns, pagination) =>
      turns.map((turn) => ({
        ...createCodexCanonicalTurnState(turn, params),
        ...(pagination[turn.id] ? { itemsPagination: pagination[turn.id] } : {}),
      })),
  };
  return {
    client,
    calls,
    read: () => state,
    snapshots: () => snapshots,
    patches: () => patches,
    handle: (fn: typeof handler) => {
      handler = fn;
    },
    mutate: (recipe: Parameters<CanonicalHistoryClient["updateConversation"]>[1]) => {
      state = produce(state, recipe);
    },
  };
}

test("coalesces complete tail demand and publishes one snapshot after all pages", async () => {
  const f = fixture();
  const firstPage = deferred<unknown>();
  f.handle(async () =>
    f.calls.length === 1 ? firstPage.promise : { data: [rawTurn("oldest")], nextCursor: null },
  );
  using loader = new CanonicalCompleteHistoryLoader(f.client);
  const first = loader.load("conversation");
  const second = loader.load("conversation");
  expect(f.calls).toHaveLength(1);
  f.mutate((draft) => {
    draft.cwd = "/live-update";
  });
  firstPage.resolve({ data: [rawTurn("middle")], nextCursor: "last" });
  const [left, right] = await Promise.all([first, second]);
  expect(left.map((turn) => turn.turnId)).toEqual(["oldest", "middle", "tail"]);
  expect(right.map((turn) => turn.turnId)).toEqual(["oldest", "middle", "tail"]);
  expect(f.read().cwd).toBe("/live-update");
  expect(f.calls.map(({ params }) => (params as { limit: number }).limit)).toEqual([5, 5]);
  expect(f.calls.map(({ options }) => options)).toEqual([
    { priority: "background", source: "tail_history" },
    { priority: "background", source: "tail_history" },
  ]);
  expect(f.snapshots()).toBe(1);
  expect(f.patches()).toBe(0);
  expect(f.read().turnHistory?.history.isComplete).toBe(true);
});

test("disposal suppresses late complete-history mutation and snapshot", async () => {
  const f = fixture();
  const page = deferred<unknown>();
  f.handle(() => page.promise);
  const loader = new CanonicalCompleteHistoryLoader(f.client);
  const pending = loader.load("conversation");
  loader[Symbol.dispose]();
  page.resolve({ data: [rawTurn("late")], nextCursor: null });
  await expect(pending).rejects.toThrow("Failed to load complete");
  expect(residentConversationTurns(f.read()).map((turn) => turn.turnId)).toEqual(["tail"]);
  expect(f.snapshots()).toBe(0);
});

test("reconnect separates identical-cursor loads and rejects the late old response without publishing it", async () => {
  const f = fixture();
  const oldPage = deferred<unknown>();
  f.handle(async () =>
    f.calls.length === 1 ? oldPage.promise : { data: [rawTurn("current-older")], nextCursor: null },
  );
  using loader = new CanonicalCompleteHistoryLoader(f.client);
  const old = loader.load("conversation").then(
    () => "accepted",
    () => "retired",
  );
  loader.resetAfterReconnect();
  const current = await loader.load("conversation");
  expect(current.map((turn) => turn.turnId)).toEqual(["current-older", "tail"]);
  oldPage.resolve({ data: [rawTurn("stale-older")], nextCursor: "old-more" });
  expect(await old).toBe("retired");
  expect(f.calls).toHaveLength(2);
  expect(residentConversationTurns(f.read()).map((turn) => turn.turnId)).toEqual([
    "current-older",
    "tail",
  ]);
  expect(f.snapshots()).toBe(1);
});

test("restarts complete loading from the new tail when its generation changes during I/O", async () => {
  const f = fixture();
  const page = deferred<unknown>();
  f.handle(async () =>
    f.calls.length === 1 ? page.promise : { data: [rawTurn("current-older")], nextCursor: null },
  );
  using loader = new CanonicalCompleteHistoryLoader(f.client);
  const pending = loader.load("conversation");
  f.mutate((draft) => {
    replaceCanonicalHistoryDraft(draft, residentConversationTurns(draft), false, {
      cursor: "replacement",
      oldestLoadedTurnId: "tail",
    });
    draft.turnsPagination = {
      olderCursor: "replacement",
      oldestLoadedTurnId: "tail",
      isLoadingOlder: false,
      hasLoadedOldest: false,
    };
  });
  page.resolve({ data: [rawTurn("retired-older")], nextCursor: null });
  const turns = await pending;
  expect(turns.map((turn) => turn.turnId)).toEqual(["current-older", "tail"]);
  expect(f.calls.map(({ params }) => (params as { cursor: string }).cursor)).toEqual([
    "older",
    "replacement",
  ]);
  expect(f.snapshots()).toBe(1);
});
