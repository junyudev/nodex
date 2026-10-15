import { describe, expect, it, vi } from "vite-plus/test";
import type { AgentRuntimeConversationOwnerSnapshot } from "./agent-runtime-conversation-owner";
import type { AgentRuntimeRendererTransport } from "../../lib/agent-runtime-runtime";
import { createAgentRuntimeStageActions } from "./agent-runtime-conversation-adapter";

function fixture() {
  const target = { sessionId: "session", threadId: "child" };
  const message = vi.fn().mockResolvedValue({ sequence: 8 });
  const stop = vi.fn().mockResolvedValue({ stopped: true });
  const respond = vi.fn().mockResolvedValue({ sequence: 9 });
  const compact = vi.fn().mockResolvedValue({ sequence: 10, runId: "compact-run" });
  const queue = vi.fn().mockResolvedValue({ sequence: 11 });
  const queueMessage = vi.fn().mockResolvedValue({ sequence: 12 });
  const fork = vi.fn().mockResolvedValue({
    sessionId: "fork-session",
    projectId: "project",
    threadId: "fork-thread",
  });
  const openFork = vi.fn().mockResolvedValue(undefined);
  const rollback = vi.fn().mockResolvedValue({ rolledBack: true });
  const prepare = vi.fn(async (text: string) => `Prepared ${text}`);
  let state = {
    view: {
      requests: [
        { type: "userInput", requestId: "request", turnId: "run:question", questions: [] },
      ],
    },
    conversation: {
      snapshot: {
        projection: {
          runs: [
            { id: "run:completed", ordinal: 2, status: "completed" },
            { id: "run:live", ordinal: 3, status: "waiting" },
          ],
        },
      },
    },
  } as unknown as AgentRuntimeConversationOwnerSnapshot;
  const owner = {
    getSnapshot: () => state,
    nextQueuePage: async () => {},
    previousQueuePage: async () => {},
    queueBoundary: () => null,
    readQueuedInput: async (runId: string) => {
      const entry = state.view?.queuedFollowUps.entries.find((entry) => entry.followUpId === runId);
      if (!entry) throw new Error("Queued message missing");
      return { text: entry.prompt, images: [] };
    },
  };
  const actions = createAgentRuntimeStageActions({
    target: () => target,
    owner: () => owner,
    transport: {
      message,
      stop,
      respond,
      compact,
      queue,
      queueMessage,
      fork,
      rollback,
    } as unknown as AgentRuntimeRendererTransport,
    openFork,
    prepare,
  });
  return {
    prepare,
    target,
    message,
    stop,
    respond,
    compact,
    queue,
    queueMessage,
    fork,
    openFork,
    rollback,
    actions,
    sessionQuestion: () => {
      state = {
        ...state,
        view: {
          ...state.view!,
          requests: [
            {
              type: "userInput",
              requestId: "session-question",
              turnId: null,
              questions: [],
            } as never,
          ],
        },
      };
    },
    clearRequests: () => {
      state = { ...state, view: { ...state.view!, requests: [] } };
    },
  };
}

describe("Agent Runtime stage commands", () => {
  it("admits captured app follow-ups through the engine queue with their original input", async () => {
    const f = fixture();
    const appMessage = {
      source: "visualization" as const,
      sourceId: "chart",
      text: "Highlighted bar",
    };
    await f.actions.onSendCapturedFollowUp!("child", "Follow up", {
      untrustedAppMessage: appMessage,
    });
    expect(f.prepare).toHaveBeenCalledWith("Follow up", undefined, appMessage);
    expect(f.queueMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session",
        threadId: "child",
        message: expect.objectContaining({ text: "Prepared Follow up" }),
      }),
    );
    expect(f.message).not.toHaveBeenCalled();
  });

  it("rejects a captured source retired while its app input is being prepared", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let current = true;
    const source = { identity: "source", isCurrent: () => current };
    const f = fixture();
    const owner = {
      getSnapshot: () => ({}) as AgentRuntimeConversationOwnerSnapshot,
      contentSource: () => source,
    };
    const actions = createAgentRuntimeStageActions({
      target: () => f.target,
      owner: () => owner as never,
      prepare: async (text) => {
        await pending;
        return text;
      },
      transport: { queueMessage: f.queueMessage } as unknown as AgentRuntimeRendererTransport,
    });
    const sent = actions.onSendCapturedFollowUp!("child", "Late follow-up");
    current = false;
    finish();
    await expect(sent).rejects.toThrow("Conversation source changed");
    expect(f.queueMessage).not.toHaveBeenCalled();
  });
  it("captures the submitted origin before prompt preparation and sends it with the exact Session target", async () => {
    const target = { sessionId: "session", threadId: "child" };
    const order: string[] = [];
    const ticket = { ticketId: "018f0097-a39b-7000-8000-000000000000" };
    const submitted = {
      rendererGeneration: "renderer",
      sceneOwner: { kind: "pages" as const },
      presentationRevision: 3,
      focusedTarget: null,
      selectedTabs: [],
    };
    const capture = vi.fn(async () => {
      order.push("capture");
      return ticket;
    });
    const message = vi.fn(async () => {
      order.push("message");
      return { sequence: 1 };
    });
    const actions = createAgentRuntimeStageActions({
      target: () => target,
      owner: () => null,
      capturePresentation: capture,
      transport: { message } as unknown as AgentRuntimeRendererTransport,
      prepare: async (text) => {
        order.push("prepare");
        return text;
      },
    });
    await actions.onSendPrompt!("Task", { submittedPresentation: submitted });
    expect(order).toEqual(["capture", "prepare", "message"]);
    expect(capture).toHaveBeenCalledWith({ kind: "thread", threadId: "child" }, submitted);
    expect(message).toHaveBeenCalledWith(
      expect.objectContaining({
        ...target,
        presentationTicket: ticket,
        message: expect.objectContaining({ text: "Task" }),
      }),
    );
  });
  it("answers the original Session question without borrowing the foreground Run", async () => {
    const f = fixture();
    f.sessionQuestion();
    await f.actions.onRespondUserInput!("session-question", { q: ["Yes"] });
    expect(f.respond).toHaveBeenCalledWith({
      ...f.target,
      requestId: "session-question",
      runId: null,
      answers: { q: "Yes" },
    });
    f.clearRequests();
    await expect(f.actions.onRespondUserInput!("session-question", {})).rejects.toThrow(
      "no longer pending",
    );
    expect(f.respond).toHaveBeenCalledTimes(1);
  });
  it("preserves structured Agent config for Main validation across send and queue admission", async () => {
    const f = fixture();
    const promptInput = {
      text: "Inspect",
      agentConfigs: [
        { mode: "plan", provider: "openai", model: "model-b", reasoning: "high", speed: "fast" },
      ],
    };
    await f.actions.onSendPrompt!("Inspect", { promptInput });
    await f.actions.onEnqueueQueuedFollowUp!("child", "Inspect", { promptInput });
    expect(f.message.mock.calls[0]![0].message.agentConfigs).toEqual(promptInput.agentConfigs);
    expect(f.queueMessage.mock.calls[0]![0].message.agentConfigs).toEqual(promptInput.agentConfigs);
    expect(f.message.mock.calls[0]![0].message.text).toBe("Prepared Inspect");
  });
  it("waits for native rollback settlement before submitting the edited message", async () => {
    const f = fixture();
    let settle!: (value: { rolledBack: true }) => void;
    f.rollback.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const edited = f.actions.onEditLastUserTurn!({
      threadId: "child",
      turnId: "run:completed",
      message: "Edited",
    });
    expect(f.message).not.toHaveBeenCalled();
    settle({ rolledBack: true });
    await edited;
    expect(f.rollback.mock.calls[0]![0]).toMatchObject({ ...f.target, runId: "run:completed" });
    expect(f.message.mock.calls[0]![0]).toMatchObject({
      ...f.target,
      message: { text: "Prepared Edited" },
    });
    f.rollback.mockRejectedValue(new Error("Native rollback refused"));
    await expect(
      f.actions.onEditLastUserTurn!({
        threadId: "child",
        turnId: "run:completed",
        message: "Unsafe edit",
      }),
    ).rejects.toThrow("Native rollback refused");
    expect(f.message).toHaveBeenCalledTimes(1);
  });
  it("keeps queued submissions and Run controls bound to the selected child", async () => {
    const f = fixture();
    await f.actions.onEnqueueQueuedFollowUp!("child", "later");
    await f.actions.onRemoveQueuedFollowUp!("child", "queued-run");
    await f.actions.onReorderQueuedFollowUps!("child", ["queued:b", "queued:a"]);
    await f.actions.onSendQueuedFollowUpNow!("child", "queued-run");
    expect(f.queueMessage.mock.calls[0]![0]).toMatchObject({
      ...f.target,
      message: { text: "Prepared later" },
    });
    expect(f.queue.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ ...f.target, action: "cancel", runId: "queued-run" }),
      expect.objectContaining({
        ...f.target,
        action: "reorder",
        orderedRunIds: ["queued:b", "queued:a"],
      }),
      expect.objectContaining({
        ...f.target,
        action: "steer",
        runId: "queued-run",
        targetRunId: "run:live",
      }),
    ]);
    await expect(f.actions.onRemoveQueuedFollowUp!("foreign", "queued-run")).rejects.toThrow(
      "identity changed",
    );
    expect(f.queue).toHaveBeenCalledTimes(3);
  });

  it("forks from the exact observed Run into a new Session and opens that accepted identity", async () => {
    const f = fixture();
    await f.actions.onForkFromTurn!({
      threadId: "child",
      turnId: "run:completed",
      message: "Branch prompt",
    });
    expect(f.fork.mock.calls[0]![0]).toMatchObject({
      source: f.target,
      sourceRunId: "run:completed",
      environment: "same-directory",
    });
    expect(f.message).toHaveBeenCalledWith({
      sessionId: "fork-session",
      threadId: "fork-thread",
      message: expect.objectContaining({ text: "Branch prompt" }),
    });
    expect(f.openFork).toHaveBeenCalledWith({
      sessionId: "fork-session",
      projectId: "project",
      threadId: "fork-thread",
    });
  });
  it("compacts only the bound conversation through a fresh semantic request", async () => {
    const f = fixture();
    await f.actions.onCompactThread!("child");
    expect(f.compact.mock.calls[0]![0]).toMatchObject(f.target);
    expect(typeof f.compact.mock.calls[0]![0].requestId).toBe("string");
    await expect(f.actions.onCompactThread!("foreign")).rejects.toThrow("identity changed");
    expect(f.compact).toHaveBeenCalledTimes(1);
  });
  it("sends prepared follow-ups and steering to the explicit descendant within its Session", async () => {
    const f = fixture();
    await f.actions.onSendPrompt!("next");
    await f.actions.onSteerPrompt!({ prompt: "adjust" });
    expect(f.message.mock.calls[0]![0]).toMatchObject({
      ...f.target,
      message: { text: "Prepared next" },
    });
    expect(f.message.mock.calls[1]![0]).toMatchObject({
      ...f.target,
      intent: "steer",
      message: { text: "Prepared adjust" },
    });
    expect(f.message.mock.calls[0]![0].message.messageId).not.toBe(
      f.message.mock.calls[1]![0].message.messageId,
    );
  });

  it("interrupts the selected Run and uses the observed live Run when no selection is supplied", async () => {
    const f = fixture();
    await f.actions.onInterruptTurn!("run:selected");
    await f.actions.onInterruptTurn!();
    expect(f.stop.mock.calls.map(([input]) => input)).toEqual([
      { ...f.target, runId: "run:selected" },
      { ...f.target, runId: "run:live" },
    ]);
  });

  it("answers only pending requests with their exact Run identity", async () => {
    const f = fixture();
    await f.actions.onRespondUserInput!("request", { q: ["Exact answer"] });
    expect(f.respond).toHaveBeenCalledWith({
      ...f.target,
      requestId: "request",
      runId: "run:question",
      answers: { q: "Exact answer" },
    });
    f.clearRequests();
    await expect(f.actions.onRespondUserInput!("request", { q: ["Late answer"] })).rejects.toThrow(
      "no longer pending",
    );
    expect(f.respond).toHaveBeenCalledTimes(1);
  });

  it("refuses dispatch without a product Session instead of guessing a Thread owner", async () => {
    const message = vi.fn();
    const actions = createAgentRuntimeStageActions({
      target: () => null,
      owner: () => null,
      transport: { message } as unknown as AgentRuntimeRendererTransport,
      prepare: async (text) => text,
    });
    await expect(actions.onSendPrompt!("hello")).rejects.toThrow("Open a conversation");
    expect(message).not.toHaveBeenCalled();
  });
});
