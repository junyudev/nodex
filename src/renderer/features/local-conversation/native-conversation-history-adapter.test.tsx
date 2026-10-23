import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, type PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { AgentConversationSnapshot } from "../../../shared/agent-conversation";
import type { CodexThreadSummary } from "../../../shared/types";
import { agentBackendRuntime } from "../../lib/agent-backend-runtime";
import {
  createNativeConversationHistoryRuntime,
  useNativeConversationHistoryAdapter,
} from "./native-conversation-history-adapter";
import { NativeConversationHistoryOwner } from "./native-conversation-history-owner";

const summary: CodexThreadSummary = {
  threadId: "imported-history-thread",
  projectId: "alpha",
  source: null,
  threadName: "Imported conversation",
  threadPreview: "",
  cwd: "/workspace",
  statusType: "idle",
  statusActiveFlags: [],
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  linkedAt: "2026-10-15T00:00:00Z",
};

const snapshot: AgentConversationSnapshot = {
  threadId: summary.threadId,
  backend: "claude",
  sessionId: "native-history",
  revision: 1,
  status: "closed",
  error: null,
  history: { hasOlder: true, cursor: "older", oldestSequence: 1 },
  turns: [
    {
      sequence: 1,
      clientUserMessageId: null,
      promptText: "Question",
      stopReason: "end_turn",
      updates: [],
    },
  ],
};

afterEach(() => vi.restoreAllMocks());
test("StrictMode native history retains one cold read across metadata updates and releases its body", async () => {
  const read = vi.spyOn(agentBackendRuntime, "history").mockResolvedValue({
    threadId: summary.threadId,
    backend: "claude",
    sessionId: "physical-native-history",
    revision: 1,
    status: "closed",
    error: null,
    turns: [
      {
        sequence: 1,
        clientUserMessageId: null,
        promptText: "Saved question",
        stopReason: "end_turn",
        updates: [],
      },
    ],
  });
  const wrapper = ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>;
  const { result, rerender, unmount } = renderHook(
    ({ metadata }) => {
      const adapter = useNativeConversationHistoryAdapter({
        sessionId: "native-import-session",
        summary: metadata,
        backend: "claude",
      });
      useEffect(() => adapter.runtime.retain(summary.threadId, true), [adapter.runtime]);
      return adapter;
    },
    { initialProps: { metadata: summary }, wrapper },
  );
  await waitFor(() => expect(result.current.runtime.read(summary.threadId)?.turns).toHaveLength(1));
  const runtime = result.current.runtime;
  const turn = runtime.read(summary.threadId)!.turns[0];
  await act(async () =>
    rerender({ metadata: { ...summary, projectId: "beta", threadName: "Renamed import" } }),
  );
  await waitFor(() =>
    expect(result.current.runtime.read(summary.threadId)?.threadName).toBe("Renamed import"),
  );
  expect(result.current.runtime).toBe(runtime);
  expect(runtime.read(summary.threadId)!.turns[0]).toBe(turn);
  expect(read).toHaveBeenCalledExactlyOnceWith({ threadId: summary.threadId, limit: 50 });
  unmount();
  expect(runtime.read(summary.threadId)).toBeNull();
});

test("native runtime routes viewport demand to its owner and keeps gap failures attached", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(snapshot)
    .mockRejectedValueOnce(new Error("Native file is unavailable"))
    .mockResolvedValueOnce({ ...snapshot, history: { hasOlder: false, oldestSequence: 1 } });
  const owner = new NativeConversationHistoryOwner(summary, read);
  const runtime = createNativeConversationHistoryRuntime({
    backend: "claude",
    sessionId: "native-import-session",
    summary,
    owner,
    retain: owner.retain,
  });
  const release = runtime.retain(summary.threadId, true);
  await runtime.loadHistory(summary.threadId);
  const view = runtime.read(summary.threadId);
  const gap = view?.historyRows?.find((row) => row.kind === "gap");
  if (gap?.kind !== "gap" || !gap.newerBoundary)
    throw new Error("Expected an older history boundary");
  expect(runtime.history!("other-thread")).toBeNull();
  const history = runtime.history!(summary.threadId)!;
  expect(read).toHaveBeenCalledTimes(1);
  await expect(history.loadBoundary(gap.newerBoundary)).rejects.toThrow(
    "Native file is unavailable",
  );
  expect(runtime.attachment(summary.threadId)).toEqual({ status: "attached" });
  expect(runtime.read(summary.threadId)).toBe(view);
  expect(await history.loadBoundary(gap.newerBoundary)).toBe("applied");
  expect(runtime.read(summary.threadId)?.historyRows?.map((row) => row.kind)).toEqual(["content"]);
  release();
});

test("a renewed native history reader replaces its port even when its cursor is unchanged", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ ...snapshot, history: { hasOlder: false, oldestSequence: 1 } });
  const owner = new NativeConversationHistoryOwner(summary, read);
  const runtime = createNativeConversationHistoryRuntime({
    backend: "claude",
    sessionId: "native-import-session",
    summary,
    owner,
    retain: owner.retain,
  });
  expect(runtime.history!(summary.threadId)).toBeNull();
  const release = runtime.retain(summary.threadId, true);
  await runtime.loadHistory(summary.threadId);
  const previous = runtime.history!(summary.threadId)!;
  await runtime.loadHistory(summary.threadId);
  const current = runtime.history!(summary.threadId)!;
  const gap = runtime.read(summary.threadId)?.historyRows?.find((row) => row.kind === "gap");
  if (gap?.kind !== "gap" || !gap.newerBoundary)
    throw new Error("Expected an older history boundary");
  expect(current).not.toBe(previous);
  expect(gap.newerBoundary.handle.cursor).toBe(snapshot.history?.cursor);
  expect(await previous.loadBoundary(gap.newerBoundary)).toBe("stale");
  expect(read).toHaveBeenCalledTimes(2);
  expect(await current.loadBoundary(gap.newerBoundary)).toBe("applied");
  expect(read).toHaveBeenCalledTimes(3);
  release();
  expect(runtime.history!(summary.threadId)).toBeNull();
});
