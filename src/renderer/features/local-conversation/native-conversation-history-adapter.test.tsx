import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, type PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { CodexThreadSummary } from "../../../shared/types";
import { agentBackendRuntime } from "../../lib/agent-backend-runtime";
import { useNativeConversationHistoryAdapter } from "./native-conversation-history-adapter";

afterEach(() => vi.restoreAllMocks());
test("StrictMode native history retains one cold read across metadata updates and releases its body", async () => {
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
