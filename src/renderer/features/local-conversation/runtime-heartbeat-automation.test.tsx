import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AgentRuntimeConversation } from "../../../shared/agent-runtime-api";
import { render } from "../../test/dom";
import { agentRuntimeSnapshotFixture } from "../../../shared/testing/agent-runtime-snapshot";
import { installWindowApi } from "../../test/browser-globals";
import { TestQueryProvider } from "../../test/query";
import { agentRuntimeRuntime } from "../../lib/agent-runtime-runtime";
import {
  RuntimeHeartbeatAutomationTarget,
  buildRuntimeHeartbeatAutomationSessionState,
} from "./runtime-heartbeat-automation";
import type { AgentRuntimeConversationOwnerSnapshot } from "./agent-runtime-conversation-owner";

const conversation = {
  sessionId: "session:heartbeat",
  projectId: "project",
  threadId: "engine:root",
  snapshot: agentRuntimeSnapshotFixture({ thread: { id: "engine:root" } }),
} satisfies AgentRuntimeConversation;
const state = (
  projection = conversation.snapshot.projection,
): AgentRuntimeConversationOwnerSnapshot => ({
  conversation: { ...conversation, snapshot: { ...conversation.snapshot, projection } },
  view: null,
  connection: "ready",
  error: null,
  historyLoading: false,
});
afterEach(() => vi.restoreAllMocks());

describe("Heartbeat execution observation", () => {
  it("keeps a Run, pending request or native background work ineligible after transcript bodies are released", () => {
    const projection = conversation.snapshot.projection;
    expect(
      buildRuntimeHeartbeatAutomationSessionState(conversation.sessionId, state()),
    ).toMatchObject({ sessionId: conversation.sessionId, isEligible: true });
    for (const status of ["queued", "preparing", "starting", "running", "waiting"] as const) {
      expect(
        buildRuntimeHeartbeatAutomationSessionState(
          conversation.sessionId,
          state({
            ...projection,
            runs: [{ id: "run", status }] as unknown as typeof projection.runs,
          }),
        ).isEligible,
      ).toBe(false);
    }
    expect(
      buildRuntimeHeartbeatAutomationSessionState(
        conversation.sessionId,
        state({
          ...projection,
          runtimeRequests: [{ status: "pending" }] as unknown as typeof projection.runtimeRequests,
        }),
      ).reason,
    ).toBe("waiting_on_user_input");
    expect(
      buildRuntimeHeartbeatAutomationSessionState(
        conversation.sessionId,
        state({
          ...projection,
          subagents: [{ status: "running" }] as unknown as typeof projection.subagents,
        }),
      ).reason,
    ).toBe("background_task");
    expect(
      buildRuntimeHeartbeatAutomationSessionState(
        conversation.sessionId,
        state({
          ...projection,
          providerThreads: [
            { pendingBackgroundTasks: [{ taskId: "command" }] },
          ] as unknown as typeof projection.providerThreads,
        }),
      ).reason,
    ).toBe("background_task");
    expect(
      buildRuntimeHeartbeatAutomationSessionState(conversation.sessionId, {
        ...state(),
        connection: "failed",
      }).isEligible,
    ).toBe(false);
  });

  it("resolves the Session's exact execution and retains only metadata until unmount", async () => {
    const published: unknown[] = [];
    installWindowApi({
      invoke: async (channel: string, input: unknown) => {
        if (channel === "project-sessions:get")
          return {
            id: "session:heartbeat",
            archived: false,
            executionRef: { runtimeId: "engine", threadId: "engine:root" },
          };
        if (channel === "codex:scheduled-automations:heartbeat-thread-state-changed") {
          published.push(input);
          return;
        }
        throw new Error(`Unexpected channel: ${channel}`);
      },
    });
    const read = vi.spyOn(agentRuntimeRuntime, "read");
    const control = vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue(conversation);
    const release = vi.fn();
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(release);
    const view = render(
      <TestQueryProvider>
        <RuntimeHeartbeatAutomationTarget sessionId="session:heartbeat" />
      </TestQueryProvider>,
    );
    try {
      await waitFor(() =>
        expect(published).toContainEqual(
          expect.objectContaining({ sessionId: "session:heartbeat", isEligible: true }),
        ),
      );
      expect(control).toHaveBeenCalledExactlyOnceWith({
        sessionId: "session:heartbeat",
        threadId: "engine:root",
      });
      expect(read).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        view.unmount();
        await Promise.resolve();
      });
    }
    expect(release).toHaveBeenCalledOnce();
    expect(published.at(-1)).toMatchObject({
      sessionId: "session:heartbeat",
      isEligible: false,
      reason: "execution_observer_closed",
    });
  });
});
