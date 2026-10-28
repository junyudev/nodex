import { describe, expect, it, vi } from "vite-plus/test";
import type { AgentRuntimeConversationOwnerSnapshot } from "./agent-runtime-conversation-owner";
import type { AgentRuntimeRendererTransport } from "../../lib/agent-runtime-runtime";
import type { AgentRuntimeRun } from "./agent-runtime-transcript-projection";
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
  const prepare = vi.fn(async (text: string) => ({ text: `Prepared ${text}` }));
  let sourceCurrent = true;
  const source = { identity: "source", isCurrent: () => sourceCurrent };
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
    contentSource: () => source,
    nextQueuePage: async () => {},
    previousQueuePage: async () => {},
    queueBoundary: () => null,
    readQueuedInput: async (runId: string) => {
      const entry = state.view?.queuedFollowUps.entries.find((entry) => entry.followUpId === runId);
      if (!entry) throw new Error("Queued message missing");
      return { text: entry.prompt, images: [] };
    },
    readSentMessage: vi.fn(async (runId: string) => ({
      message: {
        id: `message:${runId}`,
        threadId: "child",
        text: "Original",
        attachments: [],
      } as never,
      images: [] as { source: string; caption?: string }[],
    })),
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
    owner,
    actions,
    retireSource: () => {
      sourceCurrent = false;
    },
    setRuns: (
      runs: readonly (Pick<AgentRuntimeRun, "id" | "ordinal" | "status"> &
        Partial<Pick<AgentRuntimeRun, "modelSelection">>)[],
    ) => {
      state = {
        ...state,
        conversation: { snapshot: { projection: { runs } } },
      } as unknown as AgentRuntimeConversationOwnerSnapshot;
    },
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
    settle: () => {
      state = {
        ...state,
        conversation: {
          snapshot: {
            projection: { runs: [{ id: "run:completed", ordinal: 2, status: "completed" }] },
          },
        },
      } as unknown as AgentRuntimeConversationOwnerSnapshot;
    },
  };
}

describe("Agent Runtime stage commands", () => {
  it("opens the failed Run's provider settings independently of the next selected Agent", () => {
    const f = fixture();
    f.setRuns([
      {
        id: "old",
        ordinal: 1,
        status: "failed",
        modelSelection: { instanceId: "old", model: "m" },
      },
      {
        id: "failed",
        ordinal: 2,
        status: "failed",
        modelSelection: { instanceId: "claude-original", model: "m" },
      },
    ]);
    const manageProvider = vi.fn();
    const actions = createAgentRuntimeStageActions({
      target: () => f.target,
      owner: () => f.owner,
      prepare: f.prepare,
      manageProvider,
      nextSelection: () => ({ instanceId: "opencode-next", model: "other" }),
    });

    actions.onManageFailedProvider!("failed");

    expect(manageProvider).toHaveBeenCalledExactlyOnceWith("claude-original");
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.message).not.toHaveBeenCalled();
    expect(f.actions.onManageFailedProvider).toBeUndefined();
  });

  it.each(["source", "newer-run", "running"] as const)(
    "rejects an obsolete provider settings action after a %s change",
    (change) => {
      const f = fixture();
      const manageProvider = vi.fn();
      f.setRuns([
        {
          id: "failed",
          ordinal: 1,
          status: "failed",
          modelSelection: { instanceId: "claude", model: "m" },
        },
      ]);
      const actions = createAgentRuntimeStageActions({
        target: () => f.target,
        owner: () => f.owner,
        prepare: f.prepare,
        manageProvider,
      });
      if (change === "source") f.retireSource();
      if (change === "newer-run") f.setRuns([{ id: "newer", ordinal: 2, status: "failed" }]);
      if (change === "running") f.setRuns([{ id: "failed", ordinal: 1, status: "running" }]);

      expect(() => actions.onManageFailedProvider!("failed")).toThrow();
      expect(manageProvider).not.toHaveBeenCalled();
    },
  );

  it("continues the latest failed Run as a new message with its existing conversation", async () => {
    const f = fixture();
    f.clearRequests();
    f.setRuns([{ id: "failed", ordinal: 4, status: "failed" }]);

    await f.actions.onContinueAfterFailure!("failed");

    expect(f.message).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...f.target,
        message: expect.objectContaining({ text: "Prepared Continue from where you left off." }),
      }),
    );
    expect(f.rollback).not.toHaveBeenCalled();
    expect(f.owner.readSentMessage).not.toHaveBeenCalled();
  });

  it.each(["completed", "running", "queued", "requests", "newer-failure"] as const)(
    "does not continue an obsolete failure when the conversation has %s",
    async (change) => {
      const f = fixture();
      f.clearRequests();
      f.setRuns([{ id: "failed", ordinal: 4, status: "failed" }]);
      if (change === "requests") f.sessionQuestion();
      else
        f.setRuns([
          { id: "failed", ordinal: 4, status: "failed" },
          {
            id: "newer",
            ordinal: 5,
            status: change === "newer-failure" ? "failed" : change,
          },
        ]);

      await expect(f.actions.onContinueAfterFailure!("failed")).rejects.toThrow(
        "can no longer be continued",
      );
      expect(f.message).not.toHaveBeenCalled();
      expect(f.prepare).not.toHaveBeenCalled();
    },
  );

  it.each(["source", "target", "run", "requests"] as const)(
    "rechecks the %s at admission after preparing a continuation",
    async (change) => {
      const f = fixture();
      f.clearRequests();
      f.setRuns([{ id: "failed", ordinal: 4, status: "failed" }]);
      let finishPreparation: (value: { text: string }) => void = () => {};
      const prepared = new Promise<{ text: string }>((resolve) => {
        finishPreparation = resolve;
      });
      f.prepare.mockImplementation(() => prepared);
      const continuing = f.actions.onContinueAfterFailure!("failed");
      await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
      if (change === "source") f.retireSource();
      if (change === "target") f.target.threadId = "another-thread";
      if (change === "run") f.setRuns([{ id: "failed", ordinal: 4, status: "running" }]);
      if (change === "requests") f.sessionQuestion();
      finishPreparation({ text: "Continue from where you left off." });

      await expect(continuing).rejects.toThrow(
        change === "source" || change === "target"
          ? "source changed"
          : "can no longer be continued",
      );
      expect(f.message).not.toHaveBeenCalled();
    },
  );

  it("deduplicates continuation across rerendered actions until the sent message is observed", async () => {
    const f = fixture();
    f.clearRequests();
    f.setRuns([{ id: "failed", ordinal: 4, status: "failed" }]);
    let finishObservation: () => void = () => {};
    const observed = new Promise<void>((resolve) => {
      finishObservation = resolve;
    });
    const whenObserved = vi.fn(() => observed);
    const owner = { ...f.owner, whenObserved };
    const createActions = () =>
      createAgentRuntimeStageActions({
        target: () => f.target,
        owner: () => owner,
        transport: { message: f.message } as unknown as AgentRuntimeRendererTransport,
        prepare: f.prepare,
      });
    const first = createActions().onContinueAfterFailure!("failed");
    await vi.waitFor(() => expect(whenObserved).toHaveBeenCalledWith(8));
    const repeated = createActions().onContinueAfterFailure!("failed");
    finishObservation();
    await Promise.all([first, repeated]);
    expect(f.message).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledOnce();
  });

  it("uses one admission identity for the same failure from independently observed sources", async () => {
    const first = fixture();
    const second = fixture();
    for (const f of [first, second]) {
      f.clearRequests();
      f.setRuns([{ id: "failed", ordinal: 4, status: "failed" }]);
    }
    await Promise.all([
      first.actions.onContinueAfterFailure!("failed"),
      second.actions.onContinueAfterFailure!("failed"),
    ]);

    expect(first.message.mock.calls[0]![0].message.messageId).toBe("continue:failed");
    expect(second.message.mock.calls[0]![0].message.messageId).toBe("continue:failed");
  });

  it("retains a rejected continuation's identity when the user retries it", async () => {
    const f = fixture();
    f.clearRequests();
    f.setRuns([{ id: "failed", ordinal: 4, status: "failed" }]);
    f.message.mockRejectedValue(new Error("The command was rejected"));
    await expect(f.actions.onContinueAfterFailure!("failed")).rejects.toThrow("rejected");
    await expect(f.actions.onContinueAfterFailure!("failed")).rejects.toThrow("rejected");

    expect(f.message.mock.calls.map(([request]) => request.message.messageId)).toEqual([
      "continue:failed",
      "continue:failed",
    ]);
  });

  it("allows another continuation attempt after preparation fails", async () => {
    const f = fixture();
    f.clearRequests();
    f.setRuns([{ id: "failed", ordinal: 4, status: "failed" }]);
    f.prepare.mockRejectedValueOnce(new Error("Could not prepare the message"));
    await expect(f.actions.onContinueAfterFailure!("failed")).rejects.toThrow("Could not prepare");
    await f.actions.onContinueAfterFailure!("failed");
    expect(f.message).toHaveBeenCalledOnce();
  });

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
        return { text };
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
      sceneOwner: { kind: "library" as const },
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
        return { text };
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
  it("retains an accepted side-chat submission and origin across a retry", async () => {
    const f = fixture();
    const ticket = { ticketId: "018f0097-a39b-7000-8000-000000000000" };
    const options = {
      submissionIdentity: { clientUserMessageId: "side-opening" },
      presentationTicket: ticket,
    };
    await f.actions.onSendPrompt!("Side question", options);
    await f.actions.onSendPrompt!("Side question", options);
    expect(
      f.message.mock.calls.map(([input]) => ({
        messageId: input.message.messageId,
        presentationTicket: input.presentationTicket,
      })),
    ).toEqual([
      { messageId: "side-opening", presentationTicket: ticket },
      { messageId: "side-opening", presentationTicket: ticket },
    ]);
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
  it("finishes sending a message only once the conversation shows it", async () => {
    const order: string[] = [];
    const message = vi.fn(async () => {
      order.push("accepted");
      return { sequence: 8 };
    });
    const whenObserved = vi.fn(async (sequence: number) => {
      order.push(`observed:${sequence}`);
    });
    const actions = createAgentRuntimeStageActions({
      target: () => ({ sessionId: "session", threadId: "child" }),
      owner: () =>
        ({
          getSnapshot: () => ({}) as AgentRuntimeConversationOwnerSnapshot,
          whenObserved,
        }) as never,
      transport: { message } as unknown as AgentRuntimeRendererTransport,
      prepare: async (text) => ({ text }),
    });
    await actions.onSendPrompt!("Next step");
    expect(order).toEqual(["accepted", "observed:8"]);
  });

  it("keeps the app data of a queued message whose words are edited", async () => {
    const queue = vi.fn().mockResolvedValue({ sequence: 1 });
    const record = { kind: "nodex-app-context", contextId: "chart", label: "Chart", payload: {} };
    const readRunMessage = vi.fn().mockResolvedValue({
      id: "message-1",
      text: "Compare these\n\n[Chart](t3-context://v1/nodex-app-context/chart)",
      context: { version: 1, records: [record] },
    });
    const state = {
      view: {
        queuedFollowUps: { entries: [{ followUpId: "run-1", clientUserMessageId: "message-1" }] },
      },
    } as unknown as AgentRuntimeConversationOwnerSnapshot;
    const actions = createAgentRuntimeStageActions({
      target: () => ({ sessionId: "session", threadId: "child" }),
      owner: () => ({
        getSnapshot: () => state,
        nextQueuePage: async () => {},
        previousQueuePage: async () => {},
        queueBoundary: () => null,
        readQueuedInput: async () => ({ text: "Compare these" }),
        readSentMessage: async () => {
          throw new Error("Only queued messages are edited here");
        },
      }),
      transport: {
        queue,
        readRunMessage,
        control: vi.fn().mockResolvedValue({
          snapshot: {
            projection: {
              runs: [
                {
                  id: "run-1",
                  status: "queued",
                  modelSelection: { instanceId: "codex", model: "model" },
                },
              ],
            },
          },
        }),
      } as unknown as AgentRuntimeRendererTransport,
      prepare: async (text) => ({ text }),
    });

    await actions.onReplaceQueuedFollowUp!("child", "run-1", 0, "Compare the first two");

    expect(readRunMessage).toHaveBeenCalledWith({
      sessionId: "session",
      threadId: "child",
      runId: "run-1",
    });
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "edit",
        runId: "run-1",
        message: expect.objectContaining({
          messageId: "message-1",
          text: "Compare the first two\n\n[Chart](t3-context://v1/nodex-app-context/chart)",
          context: { version: 1, records: [record] },
        }),
      }),
    );
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
    const edited = f.actions.onEditUserTurn!({
      threadId: "child",
      turnId: "run:completed",
      message: "Edited",
    });
    await vi.waitFor(() => expect(f.rollback).toHaveBeenCalledOnce());
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
      f.actions.onEditUserTurn!({
        threadId: "child",
        turnId: "run:completed",
        message: "Unsafe edit",
      }),
    ).rejects.toThrow("Native rollback refused");
    expect(f.message).toHaveBeenCalledTimes(1);
  });

  it("resends an earlier message's images and app data with its rewritten words", async () => {
    const f = fixture();
    const record = { kind: "nodex-app-context", contextId: "chart", label: "Chart", payload: {} };
    f.owner.readSentMessage.mockResolvedValueOnce({
      message: {
        id: "message:run:completed",
        threadId: "child",
        text: "Compare these\n\n[Chart](t3-context://v1/nodex-app-context/chart)",
        context: { version: 1, records: [record] },
        attachments: [],
      } as never,
      images: [{ source: "/attachments/chart.png", caption: "chart.png" }],
    });

    await f.actions.onEditUserTurn!({
      threadId: "child",
      turnId: "run:completed",
      message: "Compare the first two",
    });

    expect(f.prepare).toHaveBeenCalledWith("Compare the first two", {
      text: "Compare the first two",
      images: [{ source: "/attachments/chart.png", caption: "chart.png" }],
    });
    expect(f.message.mock.calls[0]![0].message).toMatchObject({
      text: "Prepared Compare the first two\n\n[Chart](t3-context://v1/nodex-app-context/chart)",
      context: { version: 1, records: [record] },
      images: [{ source: "/attachments/chart.png", caption: "chart.png" }],
    });
  });

  it("keeps the conversation when the rewritten message cannot be sent", async () => {
    const f = fixture();
    f.prepare.mockRejectedValueOnce(new Error("This Agent connection does not support images"));

    await expect(
      f.actions.onEditUserTurn!({ threadId: "child", turnId: "run:completed", message: "Edited" }),
    ).rejects.toThrow("does not support images");
    expect(f.rollback).not.toHaveBeenCalled();
    expect(f.message).not.toHaveBeenCalled();
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
  it("sends exactly the chosen queued message when the chat is idle", async () => {
    const f = fixture();
    f.settle();
    await f.actions.onSendQueuedFollowUpNow!("child", "queued:b");
    expect(f.queue.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ ...f.target, action: "resume", runId: "queued:b" }),
    ]);
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
    const images = [{ source: "data:image/png;base64,aW1hZ2U=", caption: "diagram.png" }];
    await f.actions.onSteerPrompt!({ prompt: "adjust", promptInput: { text: "adjust", images } });
    expect(f.message.mock.calls[0]![0]).toMatchObject({
      ...f.target,
      message: { text: "Prepared next" },
    });
    expect(f.message.mock.calls[1]![0]).toMatchObject({
      ...f.target,
      intent: "steer",
      message: { text: "Prepared adjust", images },
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
      prepare: async (text) => ({ text }),
    });
    await expect(actions.onSendPrompt!("hello")).rejects.toThrow("Open a conversation");
    expect(message).not.toHaveBeenCalled();
  });
});
