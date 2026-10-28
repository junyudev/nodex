import { act } from "react";
import { describe, expect, test } from "vite-plus/test";
import { render } from "@/test/dom";
import type {
  AgentRuntimeSessionActivity,
  AgentRuntimeSessionActivityChange,
} from "../../shared/agent-runtime-api";
import { createAgentRuntimeActivityStore } from "./agent-runtime-session-activity";
import { usePageChatActivity } from "./use-page-chat-activity";
import type { PageChatActivitySummary } from "./types";

const activity = (sessionId: string, status: AgentRuntimeSessionActivity["status"]) =>
  ({
    sessionId,
    threadId: `root:${sessionId}`,
    status,
    activeRunId: null,
    pendingRequestCount: 0,
    backgroundTasks: [],
    providerInstanceId: "codex",
    model: "gpt-5.5",
    updatedAt: "2026-10-15T00:00:00.000Z",
  }) satisfies AgentRuntimeSessionActivity;

describe("usePageChatActivity", () => {
  test("re-renders a Page glyph only for its own linked Runtime chats", async () => {
    const listeners = new Set<(change: AgentRuntimeSessionActivityChange) => void>();
    const store = createAgentRuntimeActivityStore({
      read: async () => ({ sequence: 0, items: [], complete: true }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      readConnection: async () => ({ status: "ready", generation: "g1" }),
      subscribeConnection: () => () => {},
    });
    const summary: PageChatActivitySummary = {
      pageId: "page:one",
      relatedCount: 1,
      workingCount: 0,
      waitingOnApprovalCount: 0,
      waitingOnUserInputCount: 0,
      errorCount: 0,
      unreadCount: 0,
      soleSessionId: "session:linked",
      runtimeSessionIds: ["session:linked"],
    };
    let renders = 0;
    function Probe() {
      renders += 1;
      return <span data-testid="execution">{usePageChatActivity(summary, store).execution}</span>;
    }
    const view = render(<Probe />);
    const push = async (change: AgentRuntimeSessionActivityChange) => {
      await act(async () => {
        for (const listener of listeners) listener(change);
        await Promise.resolve();
      });
    };
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.getByTestId("execution").textContent).toBe("idle");
    const settledRenders = renders;
    await push({ type: "upsert", sequence: 1, activity: activity("session:other", "running") });
    expect(renders).toBe(settledRenders);
    await push({ type: "upsert", sequence: 2, activity: activity("session:linked", "background") });
    expect(view.getByTestId("execution").textContent).toBe("background");
    await push({ type: "upsert", sequence: 3, activity: activity("session:linked", "running") });
    expect(view.getByTestId("execution").textContent).toBe("working");
  });
});
