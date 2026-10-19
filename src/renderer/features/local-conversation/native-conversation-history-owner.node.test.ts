import { afterEach, expect, test, vi } from "vite-plus/test";
import type { AgentConversationSnapshot } from "../../../shared/agent-conversation";
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
afterEach(() => vi.restoreAllMocks());

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

test("older pages preserve resident Turn references and the exact native cursor", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(page(2, "native-cursor"))
    .mockResolvedValueOnce(page(1));
  const owner = new NativeConversationHistoryOwner(summary, read);
  const release = owner.retain();
  await owner.refresh();
  const resident = owner.getSnapshot().view!.turns[0];
  await owner.loadOlder();
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
  expect(state.hasOlder).toBe(false);
  expect(state.view!.capabilityFlags.canEditUserTurns).toBe(false);
  expect(state.view!.requests).toEqual([]);
  release();
});

test("a released source ignores a delayed body page and rejects another Thread", async () => {
  let complete!: (value: AgentConversationSnapshot) => void;
  const read = vi.fn(
    () =>
      new Promise<AgentConversationSnapshot>((resolve) => {
        complete = resolve;
      }),
  );
  const owner = new NativeConversationHistoryOwner(summary, read);
  const release = owner.retain();
  const loading = owner.refresh();
  release();
  complete(page(1));
  await loading;
  expect(owner.getSnapshot().view).toBeNull();
  const foreign = new NativeConversationHistoryOwner(summary, async () => ({
    ...page(1),
    threadId: "foreign",
  }));
  const releaseForeign = foreign.retain();
  await foreign.refresh();
  expect(foreign.getSnapshot().error).toBe("Native history returned another Thread");
  expect(foreign.getSnapshot().view).toBeNull();
  releaseForeign();
});

test("a full resident byte window preserves the cursor and current bodies without widening", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(page(2, "older", "x".repeat(650_000)))
    .mockResolvedValueOnce(page(1, "earlier", "y".repeat(650_000)));
  const owner = new NativeConversationHistoryOwner(summary, read);
  const release = owner.retain();
  await owner.refresh();
  const view = owner.getSnapshot().view;
  await owner.loadOlder();
  expect(owner.getSnapshot().view).toBe(view);
  expect(owner.getSnapshot().windowFull).toBe(true);
  expect(owner.getSnapshot().cursor).toBe("older");
  await owner.loadOlder();
  expect(read).toHaveBeenCalledTimes(2);
  release();
});
