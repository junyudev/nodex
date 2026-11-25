import type { ItemPatch } from "@nodex/agent-runtime/item-patch";
import { buildTurnRenderModel } from "./projection/build-turn-render-model";
import { describe, expect, test, vi } from "vite-plus/test";
import type {
  AgentEvent,
  AgentHistoryPage,
  AgentSnapshot,
  AgentTurnItem,
} from "@nodex/agent-runtime/contracts";
import type {
  AgentRuntimeConversation,
  AgentRuntimeSessionEvent,
} from "../../../shared/agent-runtime-api";
import {
  AgentRuntimeConversationOwner,
  REPLIED_SINCE_REASON,
  type AgentRuntimeReadTransport,
} from "./agent-runtime-conversation-owner";
import { hasDurableCanonicalFirstSubmission } from "../conversation-launch/session-first-submission-owner";
import { prepareAgentMessage } from "../../../shared/agent-prompt";
import { agentRuntimeRow } from "../../../shared/testing/agent-runtime-snapshot";
import type { CodexHistoryBoundaryRef } from "../../../shared/codex-conversation-state/codex-history-topology";

const target = { sessionId: "session", threadId: "thread" };
const at = "2026-10-14T00:00:00.000Z";
const base = (id: string, ordinal: number) => ({
  id,
  threadId: "thread",
  runId: "run",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});
const command = (ordinal: number): Extract<AgentTurnItem, { type: "command_execution" }> => ({
  ...base(`command:${ordinal}`, ordinal),
  type: "command_execution",
  input: `echo ${ordinal}`,
  outputOmitted: true,
  exitCode: 0,
});
const assistant = (text = "hello"): Extract<AgentTurnItem, { type: "assistant_message" }> => ({
  ...base("assistant", 20_000),
  type: "assistant_message",
  text,
  messageId: "message:assistant",
  streaming: true,
  status: "running",
  completedAt: null,
});
const row = (
  item: AgentTurnItem,
  position = 0,
): AgentSnapshot["projection"]["visibleTurnItems"][number] => ({
  position,
  visibility: "local",
  sourceThreadId: item.threadId,
  sourceItemId: item.id,
  item,
});
function conversation(
  items: readonly AgentTurnItem[],
  cursor: string | null = null,
): AgentRuntimeConversation {
  return {
    ...target,
    projectId: "project",
    snapshot: {
      kind: "snapshot",
      snapshotSequence: 1,
      historyCursor: cursor,
      hasMoreHistory: cursor !== null,
      latestLocalTurnOrdinal: 20_000,
      payloadBudgetExceeded: false,
      turnItemsOmitLocalVisible: true,
      projection: {
        thread: {
          id: target.threadId,
          projectId: "project",
          title: "Thread",
          createdBy: "user",
          creationSource: "web",
          providerInstanceId: "claude",
          modelSelection: { instanceId: "claude", model: "model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/workspace",
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: target.threadId,
          },
          forkedFrom: null,
          createdAt: at,
          updatedAt: at,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        runs: [
          {
            id: "run",
            threadId: target.threadId,
            ordinal: 1,
            providerInstanceId: "claude",
            modelSelection: { instanceId: "claude", model: "model" },
            providerThreadId: null,
            userMessageId: "user-message",
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: at,
            startedAt: at,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
        attempts: [],
        nodes: [],
        subagents: [],
        providerSessions: [],
        providerThreads: [],
        providerTurns: [],
        runtimeRequests: [],
        messages: [],
        plans: [],
        turnItems: [],
        checkpointScopes: [],
        checkpoints: [],
        contextHandoffs: [],
        contextTransfers: [],
        visibleTurnItems: items.map(row),
        updatedAt: at,
      },
    },
  };
}
function transport(initial: AgentRuntimeConversation, pages: readonly AgentHistoryPage[] = []) {
  let listener: ((event: AgentRuntimeSessionEvent) => void) | null = null;
  let index = 0;
  const release = vi.fn();
  let current = initial;
  const queuedRows = () =>
    current.snapshot.projection.runs.filter((run) => run.status === "queued");
  const port: AgentRuntimeReadTransport = {
    read: vi.fn(async () => initial),
    control: vi.fn(async () => conversation([])),
    connection: vi.fn(async () => ({ status: "ready" as const, generation: "test-runtime" })),
    history: vi.fn(async () => pages[index++]!),
    promptIndex: vi.fn(async () => ({ prompts: [], complete: true })),
    item: vi.fn(async () => null),
    attachment: vi.fn(async () => null),
    readQueuePage: vi.fn(async () => ({
      snapshotSequence: 1,
      entries: queuedRows().map((run) => ({
        runId: run.id,
        userMessageId: run.userMessageId!,
        userItemId:
          current.snapshot.projection.visibleTurnItems.find(
            (row) => row.item.type === "user_message" && row.item.runId === run.id,
          )?.item.id ?? null,
        queuePosition: run.queuePosition ?? run.ordinal,
        held: run.queueHeld ?? false,
        requestedAt: run.requestedAt,
      })),
      nextCursor: null,
      nextRunId: null,
    })),
    readQueuedPreview: vi.fn(async (input) => {
      const run = queuedRows().find((run) => run.id === input.runId);
      const item = current.snapshot.projection.visibleTurnItems.find(
        (row) => row.item.type === "user_message" && row.item.runId === input.runId,
      )?.item;
      return run && item?.type === "user_message"
        ? {
            threadId: target.threadId,
            runId: run.id,
            messageId: run.userMessageId!,
            text: item.text.slice(0, 2048),
            images: item.attachments.filter(
              (attachment): attachment is Extract<typeof attachment, { readonly type: "image" }> =>
                attachment.type === "image",
            ),
          }
        : null;
    }),
    readRunMessage: vi.fn(async (input) => {
      const run = current.snapshot.projection.runs.find(
        (run) => run.id === input.runId && run.status !== "rolled_back",
      );
      const item = current.snapshot.projection.visibleTurnItems.find(
        (row) => row.item.type === "user_message" && row.item.runId === input.runId,
      )?.item;
      if (!run || item?.type !== "user_message") return null;
      return {
        id: run.userMessageId!,
        threadId: target.threadId,
        runId: run.id,
        nodeId: null,
        role: "user" as const,
        text: item.text,
        attachments: item.attachments,
        streaming: false,
        createdAt: at,
        updatedAt: at,
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
    }),
    subscribe: vi.fn(async (_input, next) => {
      listener = next;
      return release;
    }),
  };
  return {
    port,
    release,
    emit(event: AgentEvent) {
      const received = event.event;
      if (received.type === "run.updated")
        current = {
          ...current,
          snapshot: {
            ...current.snapshot,
            projection: {
              ...current.snapshot.projection,
              runs: current.snapshot.projection.runs.map((run) =>
                run.id === received.payload.id ? received.payload : run,
              ),
            },
          },
        };
      if (received.type === "turn-item.updated")
        current = {
          ...current,
          snapshot: {
            ...current.snapshot,
            projection: {
              ...current.snapshot.projection,
              visibleTurnItems: current.snapshot.projection.visibleTurnItems.map((row) =>
                row.item.id === received.payload.id ? { ...row, item: received.payload } : row,
              ),
            },
          },
        };
      listener?.({ type: "event", ...target, event });
    },
    patch(sequence: number, value: ItemPatch) {
      listener?.({ type: "item-patch", ...target, sequence, patch: value });
    },
    refresh() {
      listener?.({ type: "reset-required", ...target, reason: "host-refresh" });
    },
    reset() {
      listener?.({ type: "reset-required", ...target, reason: "delivery-gap" });
    },
  };
}
const event = (payload: AgentTurnItem, sequence = 2): AgentEvent => ({
  sequence,
  commandId: null,
  event: {
    id: `event:${sequence}`,
    threadId: target.threadId,
    occurredAt: at,
    type: "turn-item.updated",
    payload,
  },
});

async function open(initial: AgentRuntimeConversation, pages: readonly AgentHistoryPage[] = []) {
  const wire = transport(initial, pages);
  const owner = new AgentRuntimeConversationOwner(target, wire.port);
  const release = owner.readOwner.subscribeStructure(() => {});
  await owner.resume();
  return { owner, wire, release };
}

test("follows transcript patches against the live item it holds", async () => {
  const { owner, wire, release } = await open(conversation([]));
  try {
    expect(vi.mocked(wire.port.subscribe).mock.calls[0]![0]).toMatchObject({
      delivery: "transcript",
    });
    wire.emit(event(assistant("Hel")));
    const entityKey = owner.readOwner.readStructure()!.turnEntityKeys[0]!;
    wire.patch(3, { itemId: "assistant", append: { field: "text", offset: 3, text: "lo" } });
    expect(owner.readOwner.readItem(entityKey, "assistant")).toMatchObject({ text: "Hello" });
    wire.patch(4, {
      itemId: "assistant",
      set: { status: "completed", streaming: false, completedAt: at },
      append: { field: "text", offset: 5, text: ", world" },
    });
    expect(owner.readOwner.readItem(entityKey, "assistant")).toMatchObject({
      text: "Hello, world",
    });
    await expect(owner.whenObserved(4)).resolves.toBeUndefined();
    expect(wire.port.read).toHaveBeenCalledOnce();
  } finally {
    release();
    owner.dispose();
  }
});

test("rebuilds from a snapshot when a patch does not fit the copy it holds", async () => {
  const { owner, wire, release } = await open(conversation([]));
  try {
    wire.emit(event(assistant("Hel")));
    wire.patch(3, { itemId: "assistant", append: { field: "text", offset: 9, text: "lo" } });
    await vi.waitFor(() => expect(wire.port.read).toHaveBeenCalledTimes(2));
    expect(wire.port.subscribe).toHaveBeenCalledTimes(2);
  } finally {
    release();
    owner.dispose();
  }
});

test("a failed reset read backs off, manual resume resets the delay, and final release stops retries", async () => {
  vi.useFakeTimers();
  const { owner, wire, release } = await open(conversation([assistant("Loaded transcript")]));
  try {
    const read = vi.mocked(wire.port.read);
    read.mockRejectedValue(new Error("Snapshot unavailable"));
    wire.reset();
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.getSnapshot().connection).toBe("failed");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(3);

    await owner.resume();
    expect(read).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(5);

    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(5);
  } finally {
    release();
    owner.dispose();
    vi.useRealTimers();
  }
});

function historyBoundary(owner: AgentRuntimeConversationOwner): CodexHistoryBoundaryRef {
  const gap = owner.readOwner.readStructure()?.timeline?.find((entry) => entry.kind === "gap");
  if (gap?.kind !== "gap" || !gap.newerBoundary) throw new Error("Expected older history");
  return gap.newerBoundary;
}

describe("Agent Runtime reply phases", () => {
  const message = (
    id: string,
    ordinal: number,
  ): Extract<AgentTurnItem, { type: "assistant_message" }> => ({
    ...assistant(id),
    id,
    ordinal,
    messageId: `message:${id}`,
    status: "completed",
    streaming: false,
    completedAt: at,
  });
  const entityKey = JSON.stringify(["agent-run", target.threadId, "run"]);
  const phases = (owner: AgentRuntimeConversationOwner, ids: readonly string[]) =>
    ids.map((id) => {
      const item = owner.readOwner.readItem(entityKey, id);
      return item?.type === "agentMessage" ? item.phase : undefined;
    });
  const settle = (initial: AgentRuntimeConversation): AgentRuntimeConversation => ({
    ...initial,
    snapshot: {
      ...initial.snapshot,
      projection: {
        ...initial.snapshot.projection,
        runs: initial.snapshot.projection.runs.map((run) => ({
          ...run,
          status: "completed",
          completedAt: retiredAt,
        })),
      },
    },
  });
  const complete = (
    wire: ReturnType<typeof transport>,
    initial: AgentRuntimeConversation,
    sequence = 2,
  ) =>
    wire.emit({
      sequence,
      commandId: null,
      event: {
        id: `complete:${sequence}`,
        threadId: target.threadId,
        occurredAt: retiredAt,
        type: "run.updated",
        payload: settle(initial).snapshot.projection.runs[0]!,
      },
    });

  test.each(["claude", "codex", "opencode2"])(
    "%s response starts survive streaming, settlement, older pages and a cold snapshot",
    async (provider) => {
      const responseStart = "2026-10-14T00:00:03.000Z";
      const responseEnd = "2026-10-14T00:00:04.000Z";
      const user: AgentTurnItem = {
        ...base("user", 0),
        type: "user_message",
        messageId: "user-message",
        text: "Check the result",
        attachments: [],
        inputIntent: "turn_start",
        createdBy: "user",
        creationSource: "web",
      };
      const first = { ...message("first-reply", 3), startedAt: "2026-10-14T00:00:02.000Z" };
      const final = {
        ...message("final-reply", 4),
        startedAt: responseStart,
        completedAt: responseEnd,
        providerThreadId: `${provider}-thread`,
        providerTurnId: `${provider}-turn`,
        nativeItemRef: {
          driver: provider,
          nativeId: `${provider}-assistant`,
          strength: "strong" as const,
        },
      };
      const running = { ...final, status: "running" as const, streaming: true, completedAt: null };
      const forProvider = (value: AgentRuntimeConversation): AgentRuntimeConversation => ({
        ...value,
        snapshot: {
          ...value.snapshot,
          projection: {
            ...value.snapshot.projection,
            thread: { ...value.snapshot.projection.thread, providerInstanceId: provider },
            runs: value.snapshot.projection.runs.map((run) => ({
              ...run,
              providerInstanceId: provider,
            })),
          },
        },
      });
      const initial = forProvider(
        conversation([user, message("narration", 1), command(2)], "older"),
      );
      const older = { ...message("older-commentary", -1), startedAt: "2026-10-14T01:00:00.000Z" };
      const { owner, wire, release } = await open(initial, [
        {
          snapshotSequence: 1,
          items: [row(older)],
          nextCursor: null,
          hasMoreHistory: false,
        },
      ]);
      const expectStart = (current: AgentRuntimeConversationOwner) => {
        expect(current.readOwner.readTurn(entityKey)?.finalAssistantStartedAtMs).toBe(
          Date.parse(responseStart),
        );
        // Runtime Runs and provider item starts need not share a host clock. No work anchor is invented.
        expect(current.readOwner.readTurn(entityKey)?.firstTurnWorkItemStartedAtMs).toBeNull();
      };
      try {
        wire.emit(event(first, 2));
        wire.emit(event(running, 3));
        expectStart(owner);
        wire.emit(event({ ...running, text: "Updated final response" }, 4));
        expectStart(owner);
        wire.emit(event(final, 5));
        complete(wire, initial, 6);
        expectStart(owner);
        expect(phases(owner, ["narration", "first-reply", "final-reply"])).toEqual([
          "commentary",
          "final_answer",
          "final_answer",
        ]);
        const render = buildTurnRenderModel({
          turn: owner.readOwner.readTurn(entityKey)!,
          requests: [],
          isLatestTurn: true,
          isStreamingTurn: false,
        });
        expect(render.buckets.latestAssistantMessage?.assistantMessageActions?.sentAtMs).toBe(
          Date.parse(responseStart),
        );
        expect(render.workedForItem).toBeNull();
        await owner.loadHistoryBoundary(historyBoundary(owner));
        expectStart(owner);
        const persisted = forProvider(
          settle(conversation([older, user, message("narration", 1), command(2), first, final])),
        );
        const reopened = await open(persisted);
        try {
          expectStart(reopened.owner);
        } finally {
          reopened.release();
        }
      } finally {
        release();
      }
    },
  );

  test("a streamed body update costs the same however long its Turn is", async () => {
    const readsPerUpdate = async (length: number) => {
      const earlier = Array.from({ length }, (_, index) => message(`earlier-${index}`, index + 1));
      const live = { ...message("live", length + 1), status: "running" as const, streaming: true };
      const { owner, wire, release } = await open(conversation([...earlier, live]));
      try {
        const reads = vi.spyOn(owner.readOwner, "readItem");
        for (let update = 1; update <= 4; update++)
          wire.emit(event({ ...live, text: `${live.text} ${"more ".repeat(update)}` }, update + 1));
        expect(phases(owner, ["live"])).toEqual(["commentary"]);
        expect(owner.readOwner.readItem(entityKey, "live")).toMatchObject({
          text: `${live.text} ${"more ".repeat(4)}`,
        });
        return reads.mock.calls.length;
      } finally {
        release();
        owner.dispose();
      }
    };
    expect(await readsPerUpdate(40)).toBe(await readsPerUpdate(2));
  });

  test("settles a multi-message reply in the same update as its Turn, across plans and notices", async () => {
    const initial = conversation([
      message("narration", 1),
      command(2),
      message("reply-1", 3),
      {
        ...base("plan", 4),
        type: "proposed_plan",
        planId: "plan",
        markdown: "Done",
        streaming: false,
      },
      message("reply-2", 5),
      { ...base("notice", 6), type: "system_notice", message: "Finished" },
    ]);
    const { owner, wire, release } = await open(initial);
    const ids = ["narration", "reply-1", "reply-2"];
    const narration = owner.readOwner.readItem(entityKey, "narration");
    const published = vi.fn(() => ({
      status: owner.readOwner.readTurnDetails(entityKey)?.status,
      phases: phases(owner, ids),
    }));
    const releases = [
      owner.readOwner.subscribeTurn(entityKey, published),
      owner.readOwner.subscribeItem(entityKey, "reply-1", published),
      owner.readOwner.subscribeItem(entityKey, "reply-2", published),
    ];
    const publish = vi.spyOn(owner.readOwner, "applyEvent");
    try {
      complete(wire, initial);
      expect(publish).toHaveBeenCalledOnce();
      expect(published).toHaveBeenCalledTimes(3);
      for (const result of published.mock.results)
        expect(result.value).toEqual({
          status: "completed",
          phases: ["commentary", "final_answer", "final_answer"],
        });
      expect(owner.readOwner.readItem(entityKey, "narration")).toBe(narration);
      expect(publish.mock.calls[0]?.[0]).toMatchObject({
        type: "changes",
        changes: [
          { type: "turn" },
          { type: "item", key: { itemId: "reply-1" }, value: { phase: "final_answer" } },
          { type: "item", key: { itemId: "reply-2" }, value: { phase: "final_answer" } },
        ],
      });
    } finally {
      releases.forEach((stop) => stop());
      release();
    }
  });

  test.each([false, true])(
    "hydrating or updating a message keeps its phase with settled=%s",
    async (settled) => {
      const initial = conversation([message("reply", 1)]);
      const { owner, wire, release } = await open(settled ? settle(initial) : initial);
      try {
        vi.mocked(wire.port.item).mockResolvedValue({ ...message("reply", 1), text: "Full reply" });
        await owner.readItem("reply");
        const phase = settled ? "final_answer" : "commentary";
        expect(phases(owner, ["reply"])).toEqual([phase]);
        wire.emit(event({ ...message("reply", 1), text: "Updated reply" }));
        expect(phases(owner, ["reply"])).toEqual([phase]);
      } finally {
        release();
      }
    },
  );

  test("execution retirement settles reply phases with the interrupted Turn", async () => {
    const { owner, wire, release } = await open(
      conversation([message("narration", 1), command(2), message("reply", 3)]),
    );
    const published = vi.fn(() => ({
      status: owner.readOwner.readTurnDetails(entityKey)?.status,
      phases: phases(owner, ["narration", "reply"]),
    }));
    const stop = owner.readOwner.subscribeTurn(entityKey, published);
    try {
      wire.emit(retiredEvent());
      expect(published).toHaveBeenCalledOnce();
      expect(published.mock.results[0]?.value).toEqual({
        status: "interrupted",
        phases: ["commentary", "final_answer"],
      });
    } finally {
      stop();
      release();
    }
  });
});

const retiredAt = "2026-10-14T00:00:05.000Z";
const retiredEvent = (sequence = 2): AgentEvent => ({
  sequence,
  commandId: null,
  event: {
    id: `retired:${sequence}`,
    threadId: target.threadId,
    occurredAt: retiredAt,
    type: "run.execution-retired",
    payload: {
      runId: "run",
      attemptId: "attempt",
      rootNodeId: "root",
      providerThreadId: "provider",
      cohortParentRunId: "cohort",
      deliveryRunId: "delivery",
      operationId: "handoff",
      retirementEffectId: "retirement",
    },
  },
});
const runtimeNode = (
  id: string,
  runId: string | null,
): AgentSnapshot["projection"]["nodes"][number] => ({
  id,
  threadId: target.threadId,
  runId,
  parentNodeId: null,
  rootNodeId: id,
  kind: "user_input_request",
  status: "waiting",
  countsForRun: true,
  providerThreadId: "provider",
  providerTurnId: null,
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: null,
  startedAt: at,
  completedAt: null,
});
const runtimeQuestion = (
  id: string,
  runId: string | null,
): Extract<AgentTurnItem, { type: "user_input_request" }> => ({
  ...base(`${id}:item`, 20_001),
  type: "user_input_request",
  nodeId: `${id}:node`,
  runId,
  status: "waiting",
  completedAt: null,
  requestId: id,
  questions: [{ id: "q", header: "Choice", question: "Continue?", options: [] }],
});
const runtimeRequest = (id: string): AgentSnapshot["projection"]["runtimeRequests"][number] => ({
  id,
  nodeId: `${id}:node`,
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "user_input",
  status: "pending",
  responseCapability: { type: "live", providerSessionId: "physical" },
  createdAt: at,
  resolvedAt: null,
});

test("retires only live resident keys and the addressed delivery without rereading history or queue bodies", async () => {
  const cold = Array.from({ length: 1_000 }, (_, ordinal) => ({
    ...command(ordinal),
    runId: "history",
    output: "Cold output ".repeat(600),
  }));
  const completed = Array.from({ length: 10 }, (_, ordinal) => ({
    ...command(ordinal + 1_000),
    output: "Completed output ".repeat(600),
  }));
  const running: AgentTurnItem = {
    ...command(2_000),
    nodeId: "root",
    status: "running",
    completedAt: null,
    output: "Partial output",
    exitCode: undefined,
  };
  const dynamic: AgentTurnItem = {
    ...base("dynamic", 2_001),
    type: "dynamic_tool",
    nodeId: "dynamic-node",
    status: "waiting",
    completedAt: null,
    toolName: "Read",
    input: { path: "large.txt" },
    output: { partial: "retained" },
  };
  const taskItem: AgentTurnItem = {
    ...base("native-item", 2_002),
    type: "subagent",
    nodeId: "native-node",
    status: "running",
    completedAt: null,
    origin: "provider_native",
    driver: "claudeAgent",
    providerInstanceId: "claude",
    subagentId: "native-task",
    childThreadId: null,
    prompt: "Keep this prompt",
    result: "Partial result",
  };
  const heldItem: Extract<AgentTurnItem, { type: "user_message" }> = {
    ...base("held-item", 2_003),
    type: "user_message",
    runId: "held",
    messageId: "held-message",
    text: "Keep my queued intent",
    attachments: [],
    inputIntent: "queued_turn",
    createdBy: "user",
    creationSource: "web",
    status: "pending",
    completedAt: null,
  };
  const deliveryItem: AgentTurnItem = {
    ...heldItem,
    id: "delivery-item",
    runId: "delivery",
    messageId: "delivery-message",
    text: "Completion notification",
  };
  const otherItem = { ...assistant("Other live Run"), id: "other-item", runId: "other" };
  const source = conversation([
    ...cold,
    ...completed,
    running,
    dynamic,
    taskItem,
    assistant(),
    runtimeQuestion("owned", "run"),
    runtimeQuestion("unknown", null),
    otherItem,
    deliveryItem,
    heldItem,
  ]);
  const template = source.snapshot.projection.runs[0]!;
  const tasks: AgentSnapshot["projection"]["subagents"] = [
    {
      id: "native-task",
      threadId: target.threadId,
      runId: "run",
      parentNodeId: "root",
      origin: "provider_native",
      createdBy: "agent",
      driver: "claudeAgent",
      providerInstanceId: "claude",
      providerThreadId: "provider",
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Native prompt",
      title: "Native",
      model: null,
      status: "running",
      result: null,
      startedAt: at,
      completedAt: null,
      updatedAt: at,
    },
    {
      id: "pending-task",
      threadId: target.threadId,
      runId: "cohort",
      parentNodeId: "cohort-root",
      origin: "app_owned",
      createdBy: "agent",
      driver: "claudeAgent",
      providerInstanceId: "claude",
      providerThreadId: null,
      childThreadId: "child",
      nativeTaskRef: null,
      prompt: "Child prompt",
      title: "Child",
      model: null,
      status: "completed",
      result: "Child result",
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      completionDelivery: { state: "claimed", observedByRunId: "delivery" },
    },
  ];
  const provider: AgentSnapshot["projection"]["providerThreads"][number] = {
    id: "provider",
    driver: "claudeAgent",
    providerInstanceId: "claude",
    providerSessionId: "physical",
    appThreadId: target.threadId,
    ownerNodeId: "root",
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "active",
    firstRunOrdinal: 1,
    lastRunOrdinal: 3,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    goal: null,
    createdAt: at,
    updatedAt: at,
  };
  const initial: AgentRuntimeConversation = {
    ...source,
    snapshot: {
      ...source.snapshot,
      projection: {
        ...source.snapshot.projection,
        runs: [
          { ...template, id: "history", ordinal: 1, status: "completed", completedAt: at },
          {
            ...template,
            id: "cohort",
            ordinal: 2,
            status: "completed",
            completedAt: at,
            delegatedCompletion: {
              disposition: "open",
              nextGeneration: 7,
              delivery: { generation: 6, messageId: "delivery-message", taskIds: ["pending-task"] },
            },
          },
          {
            ...template,
            ordinal: 3,
            providerThreadId: "provider",
            rootNodeId: "root",
            activeAttemptId: "attempt",
          },
          {
            ...template,
            id: "delivery",
            ordinal: 4,
            status: "queued",
            userMessageId: "delivery-message",
            queuePosition: 1,
          },
          {
            ...template,
            id: "held",
            ordinal: 5,
            status: "queued",
            userMessageId: "held-message",
            queuePosition: 2,
            queueHeld: true,
          },
          { ...template, id: "other", ordinal: 6 },
        ],
        nodes: [runtimeNode("owned:node", "run"), runtimeNode("unknown:node", null)],
        runtimeRequests: [runtimeRequest("owned"), runtimeRequest("unknown")],
        providerThreads: [provider, { ...provider, id: "other-provider", lastRunOrdinal: 6 }],
        providerTurns: [
          {
            id: "native-turn",
            providerThreadId: "provider",
            nodeId: "root",
            runAttemptId: "attempt",
            nativeTurnRef: null,
            ordinal: 1,
            status: "running",
            startedAt: at,
            completedAt: null,
          },
          {
            id: "other-turn",
            providerThreadId: "other-provider",
            nodeId: "other-root",
            runAttemptId: "other-attempt",
            nativeTurnRef: null,
            ordinal: 1,
            status: "running",
            startedAt: at,
            completedAt: null,
          },
        ],
        subagents: [
          ...tasks,
          {
            ...tasks[1]!,
            id: "delivered-task",
            completionDelivery: { state: "delivered", observedByRunId: "old-delivery" },
          },
          { ...tasks[1]!, id: "other-task", runId: "other" },
        ],
      },
    },
  };
  const wire = transport(initial);
  vi.mocked(wire.port.readQueuePage).mockResolvedValue({
    snapshotSequence: 1,
    entries: [
      {
        runId: "held",
        userMessageId: "held-message",
        userItemId: heldItem.id,
        queuePosition: 2,
        held: true,
        requestedAt: at,
      },
    ],
    nextCursor: null,
    nextRunId: null,
  });
  const owner = new AgentRuntimeConversationOwner(target, wire.port);
  const release = owner.readOwner.subscribeStructure(() => {});
  await owner.resume();
  await vi.waitFor(() => expect(owner.getSnapshot().view?.queuedFollowUps.entries).toHaveLength(1));
  const key = JSON.stringify(["agent-run", target.threadId, "run"]);
  const historyKey = JSON.stringify(["agent-run", target.threadId, "history"]);
  const heldKey = JSON.stringify(["agent-run", target.threadId, "held"]);
  const before = owner.getSnapshot().conversation!.snapshot.projection;
  const historyBody = owner.readOwner.readItem(historyKey, "command:0");
  const completedBody = owner.readOwner.readItem(key, "command:1000");
  const heldBody = owner.readOwner.readItem(heldKey, "held-item");
  const structure = owner.readOwner.readStructure();
  const historyTurn = structure!.turns.find((turn) => turn.entityKey === historyKey);
  const changed = vi.fn();
  const siblingChanged = vi.fn();
  const structureChanged = vi.fn();
  const stops = [
    owner.readOwner.subscribeItem(key, running.id, changed),
    owner.readOwner.subscribeItem(historyKey, "command:0", siblingChanged),
    owner.readOwner.subscribeStructure(structureChanged),
  ];
  const readItem = vi.spyOn(owner.readOwner, "readItem");
  const readTurn = vi.spyOn(owner.readOwner, "readTurn");
  vi.mocked(wire.port.readQueuePage).mockClear();
  wire.emit(retiredEvent());
  const deliveryKey = JSON.stringify(["agent-run", target.threadId, "delivery"]);
  expect(readItem.mock.calls.every(([entity]) => entity === key || entity === deliveryKey)).toBe(
    true,
  );
  expect(readItem.mock.calls.length).toBeLessThanOrEqual(21);
  expect(readTurn).not.toHaveBeenCalled();
  expect(wire.port.read).toHaveBeenCalledOnce();
  expect(wire.port.history).not.toHaveBeenCalled();
  expect(wire.port.item).not.toHaveBeenCalled();
  expect(wire.port.readQueuePage).not.toHaveBeenCalled();
  expect(wire.port.readQueuedPreview).not.toHaveBeenCalled();
  expect(wire.port.readRunMessage).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
  expect(siblingChanged).not.toHaveBeenCalled();
  expect(structureChanged).toHaveBeenCalledOnce();
  expect(owner.readOwner.readStructure()!.turnEntityKeys).toBe(structure!.turnEntityKeys);
  expect(owner.readOwner.readStructure()!.turns.find((turn) => turn.entityKey === historyKey)).toBe(
    historyTurn,
  );
  expect(owner.readOwner.readItem(historyKey, "command:0")).toBe(historyBody);
  expect(owner.readOwner.readItem(key, "command:1000")).toBe(completedBody);
  expect(owner.readOwner.readItem(heldKey, "held-item")).toBe(heldBody);
  expect(owner.readOwner.readItem(key, running.id)).toMatchObject({
    status: "declined",
    aggregatedOutput: "Partial output",
    durationMs: 5_000,
  });
  expect(owner.readOwner.readItem(key, "dynamic")).toMatchObject({
    status: "failed",
    success: false,
    arguments: { path: "large.txt" },
    contentItems: [{ text: '{"partial":"retained"}' }],
  });
  expect(owner.readOwner.readItem(key, "native-item")).toMatchObject({
    type: "delegatedTask",
    status: "stopped",
    prompt: "Keep this prompt",
    summary: "Partial result",
  });
  expect(owner.readOwner.readTurnDetails(key)?.status).toBe("interrupted");
  expect(owner.readOwner.readTurnDetails(deliveryKey)?.status).toBe("interrupted");
  const after = owner.getSnapshot().conversation!.snapshot.projection;
  expect(after.runs.find((run) => run.id === "run")).toMatchObject({
    status: "interrupted",
    completedAt: retiredAt,
  });
  expect(after.runs.find((run) => run.id === "cohort")).toMatchObject({
    status: "completed",
    delegatedCompletion: { disposition: "stopped", nextGeneration: 7, delivery: null },
  });
  expect(after.runs.find((run) => run.id === "delivery")).toMatchObject({
    status: "cancelled",
    queuePosition: null,
  });
  expect(after.runs.find((run) => run.id === "held")).toBe(
    before.runs.find((run) => run.id === "held"),
  );
  expect(after.runs.find((run) => run.id === "other")).toBe(
    before.runs.find((run) => run.id === "other"),
  );
  expect(after.providerTurns[0]).toMatchObject({ status: "interrupted", completedAt: retiredAt });
  expect(after.providerTurns[1]).toBe(before.providerTurns[1]);
  expect(after.providerThreads[0]).toMatchObject({ status: "idle" });
  expect(after.providerThreads[1]).toBe(before.providerThreads[1]);
  expect(after.runtimeRequests[0]).toMatchObject({
    status: "cancelled",
    resolvedAt: retiredAt,
    responseCapability: { type: "not_resumable" },
  });
  expect(after.runtimeRequests[1]).toBe(before.runtimeRequests[1]);
  expect(owner.getSnapshot().view?.requests.map((request) => request.requestId)).toEqual([
    "unknown",
  ]);
  expect(after.subagents[0]).toMatchObject({ status: "interrupted", completedAt: retiredAt });
  expect(after.subagents[1]).toMatchObject({
    completionDelivery: { state: "disposed", observedByRunId: null },
  });
  expect(after.subagents[2]).toBe(before.subagents[2]);
  expect(after.subagents[3]).toBe(before.subagents[3]);
  expect(owner.getSnapshot().view?.queuedFollowUps.entries).toMatchObject([
    // The latest Run here is still running, so the hold has no recorded cause.
    { followUpId: "held", prompt: "Keep my queued intent", pause: { kind: "held" } },
  ]);
  wire.emit({
    sequence: 3,
    commandId: null,
    event: {
      id: "follow-up",
      threadId: target.threadId,
      occurredAt: retiredAt,
      type: "run.updated",
      payload: { ...template, id: "cohort", ordinal: 2, status: "completed", completedAt: at },
    },
  });
  expect(
    owner.getSnapshot().conversation!.snapshot.projection.runs.find((run) => run.id === "cohort")
      ?.delegatedCompletion,
  ).toEqual({ disposition: "stopped", nextGeneration: 7, delivery: null });
  stops.forEach((stop) => stop());
  release();
});

describe("Agent Runtime keyed transcript reads", () => {
  test("a write resolves once its event is applied, or after a bound when none arrives", async () => {
    vi.useFakeTimers();
    try {
      const { owner, wire } = await open(conversation([assistant()]));
      const applied = vi.fn();
      void owner.whenObserved(5).then(applied);
      wire.emit(event(assistant("Before"), 4));
      await Promise.resolve();
      expect(applied).not.toHaveBeenCalled();
      wire.emit(event(assistant("The sent message"), 5));
      await Promise.resolve();
      expect(applied).toHaveBeenCalledOnce();
      // An event already applied resolves at once; one that never arrives waits only the bound.
      await owner.whenObserved(5);
      const missing = vi.fn();
      void owner.whenObserved(9, 500).then(missing);
      await vi.advanceTimersByTimeAsync(499);
      expect(missing).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(missing).toHaveBeenCalledOnce();
      owner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  test("keeps asynchronous questions beside the Composer and routes replies to their request", async () => {
    const { owner, wire, release } = await open(conversation([assistant()]));
    const question = {
      ...runtimeQuestion("async-question", "run-1"),
      responseMode: "message" as const,
      questions: [
        {
          id: "native:scope",
          header: "Question",
          question: "Which scope?",
          options: [{ label: "Project", description: "Project" }],
          required: false,
        },
        {
          id: "native:name",
          header: "Question",
          question: "What name?",
          options: [],
          required: false,
        },
      ],
    };
    wire.emit(event(question));
    // Optional questions never replace the Composer with a blocking request card.
    expect(owner.getSnapshot().view?.requests).toEqual([]);
    const state = owner.asyncQuestions.read(target.threadId);
    const ids = Object.keys(state.questions);
    expect(ids).toHaveLength(2);
    // A live arrival opens the first question without stealing a later selection.
    expect(state.selectedId).toBe(ids[0]);
    expect(
      owner.asyncQuestionAnswers([
        { questionItemId: ids[1]!, question: "What name?", answer: "Release checklist" },
      ]),
    ).toEqual([
      {
        requestId: "async-question",
        runId: "run-1",
        answers: { "native:name": "Release checklist" },
      },
    ]);
    wire.emit(event({ ...question, status: "completed", completedAt: at }, 3));
    expect(Object.keys(owner.asyncQuestions.read(target.threadId).questions)).toEqual(ids);
    wire.emit(event({ ...question, status: "cancelled", completedAt: at }, 4));
    expect(owner.asyncQuestions.read(target.threadId).questions).toEqual({});
    release();
    owner.dispose();
  });
  test("publishes a new continuation Run's live items without reopening history or replacing its completed parent", async () => {
    const source = conversation([assistant("Parent finished")]);
    const parentRun = { ...source.snapshot.projection.runs[0]!, status: "completed" as const };
    const initial = {
      ...source,
      snapshot: {
        ...source.snapshot,
        projection: { ...source.snapshot.projection, runs: [parentRun] },
      },
    };
    const { owner, wire, release } = await open(initial);
    const parentKey = owner.readOwner.readStructure()!.turnEntityKeys[0]!;
    const parentItem = owner.readOwner.readItem(parentKey, "assistant");
    const changedParent = vi.fn();
    const stopParent = owner.readOwner.subscribeItem(parentKey, "assistant", changedParent);
    const continuation = {
      ...parentRun,
      id: "run:continuation",
      ordinal: 2,
      userMessageId: "message:notification",
      status: "running" as const,
    };
    wire.emit({
      sequence: 2,
      commandId: null,
      event: {
        id: "event:continuation-created",
        threadId: target.threadId,
        occurredAt: at,
        type: "run.created",
        payload: continuation,
      },
    });
    const result = {
      ...assistant("Codex received async Claude child report"),
      id: "assistant:continuation",
      runId: continuation.id,
    };
    wire.emit(event(result, 3));
    wire.emit(event({ ...result, status: "completed", streaming: false, completedAt: at }, 4));
    const structure = owner.readOwner.readStructure()!;
    expect(structure.turnEntityKeys).toHaveLength(2);
    expect(owner.readOwner.readItem(structure.turnEntityKeys[1]!, result.id)).toMatchObject({
      type: "agentMessage",
      text: "Codex received async Claude child report",
    });
    expect(owner.readOwner.readItem(parentKey, "assistant")).toBe(parentItem);
    expect(changedParent).not.toHaveBeenCalled();
    expect(wire.port.read).toHaveBeenCalledOnce();
    expect(wire.port.history).not.toHaveBeenCalled();
    stopParent();
    release();
  });

  test("pages more than five queued messages without opening older history and reads the full edit text only on demand", async () => {
    const initial = conversation([]);
    const template = initial.snapshot.projection.runs[0]!;
    const words = (index: number) => `Queued message ${index}${" text".repeat(600)}`;
    const selection = { id: "selection", text: "Keep the old schema" };
    const edited = await prepareAgentMessage(
      words(6),
      { text: words(6), selectedTextAttachments: [selection] },
      vi.fn(),
    );
    const messages = Array.from({ length: 30 }, (_, index) => ({
      id: `message:${index}`,
      threadId: target.threadId,
      runId: `queue:${index}`,
      nodeId: null,
      role: "user" as const,
      ...(index === 6 ? edited : { text: words(index) }),
      attachments:
        index === 6
          ? [
              {
                type: "image" as const,
                id: "queue-image",
                name: "Queue.png",
                mimeType: "image/png",
                sizeBytes: 10,
              },
            ]
          : [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
      createdBy: "user" as const,
      creationSource: "web" as const,
    }));
    const queued = {
      ...initial,
      snapshot: {
        ...initial.snapshot,
        projection: {
          ...initial.snapshot.projection,
          runs: messages.slice(-5).map((message, index) => ({
            ...template,
            id: message.runId,
            userMessageId: message.id,
            ordinal: index + 26,
            status: "queued" as const,
          })),
        },
      },
    };
    const wire = transport(queued);
    vi.mocked(wire.port.control).mockResolvedValue(queued);
    const readQueuePage: NonNullable<AgentRuntimeReadTransport["readQueuePage"]> = vi.fn(
      async (input) => {
        const offset = input.cursor === "next" ? 25 : 0;
        return {
          snapshotSequence: 1,
          entries: messages.slice(offset, offset + 25).map((message, index) => ({
            runId: message.runId,
            userMessageId: message.id,
            userItemId: offset + index === 6 ? "queued-user:6" : null,
            queuePosition: offset + index,
            held: false,
            requestedAt: at,
          })),
          nextCursor: offset === 0 ? "next" : null,
          nextRunId: offset === 0 ? messages[25]!.runId : null,
        };
      },
    );
    const readRunMessage: NonNullable<AgentRuntimeReadTransport["readRunMessage"]> = vi.fn(
      async (input) => messages.find((message) => message.runId === input.runId) ?? null,
    );
    const readQueuedPreview: AgentRuntimeReadTransport["readQueuedPreview"] = vi.fn(
      async (input) => {
        const message = messages.find((message) => message.runId === input.runId);
        return message
          ? {
              threadId: message.threadId,
              runId: message.runId,
              messageId: message.id,
              text: message.text.slice(0, 2048),
              images: message.attachments,
            }
          : null;
      },
    );
    const attachment = vi.fn(async () => ({ path: "/managed/queue-image.png" }));
    const port = { ...wire.port, readQueuePage, readRunMessage, readQueuedPreview, attachment };
    const owner = new AgentRuntimeConversationOwner(target, port);
    const releaseControl = owner.retain();
    await owner.resume();
    expect(readQueuePage).not.toHaveBeenCalled();
    expect(readRunMessage).not.toHaveBeenCalled();
    const release = owner.readOwner.subscribeStructure(() => {});
    await owner.resume();
    await vi.waitFor(() =>
      expect(owner.getSnapshot().view?.queuedFollowUps.entries).toHaveLength(25),
    );
    expect(owner.getSnapshot().view?.queuedFollowUps.entries[6]?.prompt).toContain(
      "Queued message 6",
    );
    expect(
      owner
        .getSnapshot()
        .view?.queuedFollowUps.entries.every((entry) => entry.prompt.length <= 2048),
    ).toBe(true);
    expect(readQueuedPreview).toHaveBeenCalledTimes(25);
    expect(readRunMessage).not.toHaveBeenCalled();
    expect(attachment).not.toHaveBeenCalled();
    expect(owner.getSnapshot().view?.queuedFollowUps.entries[6]?.promptInput?.images).toEqual([
      { caption: "Queue.png", source: "nodex-runtime-image:thread/queued-user%3A6/queue-image" },
    ]);
    expect(await owner.readQueuedInput("queue:6")).toEqual({
      text: words(6),
      images: [{ source: "/managed/queue-image.png", caption: "Queue.png" }],
      responseTextAnnotations: [],
      selectedTextAttachments: [selection],
    });
    expect(attachment).toHaveBeenCalledExactlyOnceWith({
      ...target,
      sourceThreadId: "thread",
      itemId: "queued-user:6",
      attachmentId: "queue-image",
    });
    messages[6]!.text = "Edited queued preview";
    wire.emit({
      sequence: 2,
      commandId: null,
      event: {
        id: "queue-edit",
        threadId: target.threadId,
        occurredAt: at,
        type: "message.updated",
        payload: messages[6]!,
      },
    });
    await vi.waitFor(() =>
      expect(owner.getSnapshot().view?.queuedFollowUps.entries[6]?.prompt).toBe(
        "Edited queued preview",
      ),
    );

    await owner.nextQueuePage();
    expect(owner.getSnapshot().view?.queuedFollowUps.entries).toHaveLength(5);
    expect(owner.getSnapshot().view?.queuedFollowUps.entries[0]?.followUpId).toBe("queue:25");
    expect(owner.getSnapshot().view?.queuedFollowUps.hasPreviousPage).toBe(true);
    expect(wire.port.read).toHaveBeenCalledOnce();
    expect(wire.port.history).not.toHaveBeenCalled();
    expect(wire.port.item).not.toHaveBeenCalled();
    release();
    await owner.resume();
    expect(owner.getSnapshot().view?.queuedFollowUps.entries).toEqual([]);
    expect(owner.readOwner.readStructure()).toBeNull();
    releaseControl();
  });
  test.each(["controls-first", "transcript-first"] as const)(
    "%s: metadata and transcript leases admit exactly one full cold window",
    async (order) => {
      const wire = transport(conversation([assistant()]));
      const owner = new AgentRuntimeConversationOwner(target, wire.port);
      let releaseControl: () => void;
      let releaseTranscript: () => void;
      if (order === "controls-first") {
        releaseControl = owner.retain();
        await owner.resume();
        expect(wire.port.control).toHaveBeenCalledOnce();
        expect(wire.port.read).not.toHaveBeenCalled();
        expect(owner.getSnapshot().view?.statusType).toBe("active");
        expect(owner.getSnapshot().conversation?.snapshot.projection.visibleTurnItems).toEqual([]);
        expect(owner.readOwner.readStructure()).toBeNull();
        releaseTranscript = owner.readOwner.subscribeStructure(() => {});
      } else {
        releaseTranscript = owner.readOwner.subscribeStructure(() => {});
        releaseControl = owner.retain();
      }
      await owner.resume();
      expect(wire.port.read).toHaveBeenCalledOnce();
      expect(owner.readOwner.readStructure()?.turnEntityKeys.length).toBe(1);
      releaseTranscript();
      await owner.resume();
      expect(wire.port.read).toHaveBeenCalledOnce();
      expect(owner.readOwner.readStructure()).toBeNull();
      expect(owner.getSnapshot().conversation?.snapshot.projection.visibleTurnItems).toEqual([]);
      const controlSubscriptions = vi
        .mocked(wire.port.subscribe)
        .mock.calls.filter(([input]) => input.eventTypes !== undefined);
      expect(controlSubscriptions.length).toBeGreaterThan(0);
      expect(
        controlSubscriptions.every(
          ([input]) => !input.eventTypes?.map(String).includes("turn-item.updated"),
        ),
      ).toBe(true);
      releaseControl();
    },
  );
  test("compact snapshot keeps content only in keyed addresses and releases it on the final subscription", async () => {
    const user: AgentTurnItem = {
      ...base("user", 0),
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      inputIntent: "turn_start",
      messageId: "user-message",
      text: "Prompt",
      attachments: [
        {
          type: "image",
          id: "history-image",
          name: "History.png",
          mimeType: "image/png",
          sizeBytes: 10,
        },
      ],
    };
    const { owner, wire, release } = await open(conversation([user, command(1), assistant()]));
    const structure = owner.readOwner.readStructure()!;
    expect(structure.turns).toHaveLength(1);
    const opening = owner.readOwner
      .readTurn(structure.turnEntityKeys[0]!)
      ?.items.find((item) => item.role === "user");
    expect(opening?.userAttachments).toMatchObject([
      {
        type: "image",
        sourceKind: "remote-pointer",
        source: "nodex-runtime-image:thread/user/history-image",
      },
    ]);
    expect(wire.port.attachment).not.toHaveBeenCalled();
    expect(
      owner.readOwner
        .readTurn(structure.turnEntityKeys[0]!)
        ?.items.map((item) => item.markdownText)
        .filter(Boolean),
    ).toContain("Prompt");
    expect(owner.getSnapshot().conversation?.snapshot.projection.visibleTurnItems).toEqual([]);
    expect(owner.getSnapshot().conversation?.snapshot.projection.turnItems).toEqual([]);
    expect(owner.getSnapshot().view?.turns).toEqual([]);
    expect(hasDurableCanonicalFirstSubmission([], "user-message", structure.turns)).toBe(true);
    expect(hasDurableCanonicalFirstSubmission([], "another-message", structure.turns)).toBe(false);
    expect(
      hasDurableCanonicalFirstSubmission(
        [],
        "user-message",
        structure.turns.map((row) => ({
          ...row,
          value: { ...row.value, details: { ...row.value.details, turnId: null } },
        })),
      ),
    ).toBe(false);
    expect(wire.port.read).toHaveBeenCalledOnce();
    expect(wire.port.subscribe).toHaveBeenCalledOnce();
    release();
    await Promise.resolve();
    expect(wire.release).toHaveBeenCalledOnce();
    expect(owner.readOwner.readStructure()).toBeNull();
    expect(owner.readOwner.readTurn(structure.turnEntityKeys[0]!)).toBeNull();
  });

  test("prepends admitted items without re-projecting resident bodies and deduplicates a pending history request", async () => {
    const older = Array.from({ length: 100 }, (_, ordinal) => command(ordinal));
    const newer = Array.from({ length: 500 }, (_, ordinal) => command(ordinal + 100));
    const { owner, wire, release } = await open(conversation(newer, "older"), [
      { snapshotSequence: 1, items: older.map(row), nextCursor: null, hasMoreHistory: false },
    ]);
    const entityKey = owner.readOwner.readStructure()!.turnEntityKeys[0]!;
    const before = owner.readOwner.readItem(entityKey, "command:599");
    const readItem = vi.spyOn(owner.readOwner, "readItem");
    const boundary = historyBoundary(owner);
    const first = owner.loadHistoryBoundary(boundary);
    const second = owner.loadHistoryBoundary(boundary);
    expect(first).toBe(second);
    expect(owner.getSnapshot().view?.turnPagination?.isLoadingOlder).toBe(true);
    await expect(first).resolves.toBe("applied");
    expect(wire.port.history).toHaveBeenCalledOnce();
    expect(readItem.mock.calls.every(([, id]) => older.some((item) => item.id === id))).toBe(true);
    expect(owner.readOwner.readStructure()!.turns[0]!.itemIds).toHaveLength(600);
    expect(owner.readOwner.readItem(entityKey, "command:599")).toBe(before);
    expect(owner.getSnapshot().view?.turnPagination?.hasLoadedOldest).toBe(true);
    expect(owner.getSnapshot().view?.turnPagination?.isLoadingOlder).toBe(false);
    release();
  });

  test("rejects obsolete and foreign history boundaries before issuing a read", async () => {
    const { owner, wire, release } = await open(conversation([command(10)], "older"), [
      { snapshotSequence: 1, items: [row(command(0))], nextCursor: null, hasMoreHistory: false },
    ]);
    const boundary = historyBoundary(owner);
    const invalid: CodexHistoryBoundaryRef[] = [
      { ...boundary, generation: boundary.generation + 1 },
      { ...boundary, islandId: "foreign" },
      { ...boundary, edge: "newer" },
      { ...boundary, boundaryId: "foreign" },
      { ...boundary, progressKey: "previous" },
      { ...boundary, handle: { ...boundary.handle, cursor: "previous" } },
      { ...boundary, handle: { ...boundary.handle, oldestLoadedTurnId: "foreign" } },
      { ...boundary, handle: { ...boundary.handle, source: "timeline" } },
    ];
    for (const candidate of invalid)
      await expect(owner.loadHistoryBoundary(candidate)).resolves.toBe("stale");
    expect(wire.port.history).not.toHaveBeenCalled();
    await expect(owner.loadHistoryBoundary(boundary)).resolves.toBe("applied");
    await expect(owner.loadHistoryBoundary(boundary)).resolves.toBe("stale");
    expect(wire.port.history).toHaveBeenCalledExactlyOnceWith({ ...target, cursor: "older" });
    release();
  });

  test("rejects a cursor cycle across empty pages without admitting content and permits a corrected retry", async () => {
    const { owner, wire, release } = await open(conversation([command(10)], "older"), [
      { snapshotSequence: 1, items: [], nextCursor: "earlier", hasMoreHistory: true },
      { snapshotSequence: 1, items: [row(command(0))], nextCursor: "older", hasMoreHistory: true },
      { snapshotSequence: 1, items: [row(command(5))], nextCursor: null, hasMoreHistory: false },
    ]);
    await expect(owner.loadHistoryBoundary(historyBoundary(owner))).resolves.toBe("applied");
    const structure = owner.readOwner.readStructure();
    const boundary = historyBoundary(owner);
    await expect(owner.loadHistoryBoundary(boundary)).rejects.toThrow("repeated an earlier page");
    expect(owner.readOwner.readStructure()).toBe(structure);
    expect(historyBoundary(owner).handle.cursor).toBe("earlier");
    expect(owner.getSnapshot()).toMatchObject({ error: null, connection: "ready" });
    await expect(owner.loadHistoryBoundary(boundary)).resolves.toBe("applied");
    expect(owner.readOwner.readStructure()!.turns[0]!.itemIds).toEqual(["command:5", "command:10"]);
    expect(wire.port.history).toHaveBeenCalledTimes(3);
    release();
  });

  test("a retired page cannot populate a new reader or clear its pending request at the same cursor", async () => {
    const { owner, wire, release } = await open(conversation([command(10)], "older"));
    let completeOld!: (page: AgentHistoryPage) => void;
    let completeCurrent!: (page: AgentHistoryPage) => void;
    vi.mocked(wire.port.history)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeCurrent = resolve;
          }),
      );
    const retiredBoundary = historyBoundary(owner);
    const retired = owner.loadHistoryBoundary(retiredBoundary);
    await vi.waitFor(() => expect(wire.port.history).toHaveBeenCalledTimes(1));
    release();
    // The first reader has left by the time the next one arrives.
    await Promise.resolve();
    const releaseCurrent = owner.readOwner.subscribeStructure(() => {});
    await owner.resume();
    await expect(owner.loadHistoryBoundary(retiredBoundary)).resolves.toBe("stale");
    const currentBoundary = historyBoundary(owner);
    const current = owner.loadHistoryBoundary(currentBoundary);
    await vi.waitFor(() => expect(wire.port.history).toHaveBeenCalledTimes(2));
    completeOld({
      snapshotSequence: 1,
      items: [row(command(0))],
      nextCursor: null,
      hasMoreHistory: false,
    });
    await expect(retired).resolves.toBe("stale");
    expect(owner.readOwner.readStructure()!.turns[0]!.itemIds).toEqual(["command:10"]);
    expect(owner.loadHistoryBoundary(currentBoundary)).toBe(current);
    expect(owner.getSnapshot().historyLoading).toBe(true);
    completeCurrent({
      snapshotSequence: 1,
      items: [row(command(5))],
      nextCursor: null,
      hasMoreHistory: false,
    });
    await expect(current).resolves.toBe("applied");
    expect(owner.readOwner.readStructure()!.turns[0]!.itemIds).toEqual(["command:5", "command:10"]);
    expect(owner.getSnapshot().historyLoading).toBe(false);
    releaseCurrent();
  });

  test("resolved Automation detail survives identical metadata and reconnects, while newer evidence retires it", async () => {
    const proposal = {
      operation: "suggested_update",
      kind: "heartbeat",
      id: "automation:follow-up",
      expectedRevision: 7,
      status: "PAUSED",
      name: "Follow up",
      prompt: "Check progress",
      trigger: { kind: "clock", rrule: "FREQ=DAILY" },
      targetSessionId: "session:resolved",
    };
    const metadata: Extract<AgentTurnItem, { type: "dynamic_tool" }> = {
      ...base("automation-proposal", 0),
      type: "dynamic_tool",
      toolName: "nodex_app.automations_update",
      input: proposal,
      outputOmitted: true,
      mcpToolCall: {
        type: "mcpToolCall",
        id: "native-automation-proposal",
        server: "nodex_app",
        tool: "automations_update",
        status: "completed",
        arguments: proposal,
        result: { content: [] },
      },
    };
    const full: typeof metadata = {
      ...metadata,
      outputOmitted: false,
      mcpToolCall: {
        ...metadata.mcpToolCall!,
        result: { content: [], structuredContent: { proposal, committed: false } },
      },
    };
    const { owner, wire, release } = await open(conversation([metadata, command(1)]));
    try {
      vi.spyOn(wire.port, "item").mockResolvedValue(full);
      const key = owner.readOwner.readStructure()!.turnEntityKeys[0]!;
      await owner.readItem(metadata.id);
      const detail = owner.readOwner.readItem(key, metadata.id);
      expect(detail).toMatchObject({
        result: { structuredContent: { proposal, committed: false } },
      });
      expect(detail).not.toHaveProperty("outputOmitted", true);
      wire.emit(event(metadata));
      expect(owner.readOwner.readItem(key, metadata.id)).toBe(detail);
      wire.reset();
      await owner.resume();
      expect(owner.readOwner.readItem(key, metadata.id)).toBe(detail);
      expect(wire.port.item).toHaveBeenCalledTimes(1);

      const changed = { ...metadata, updatedAt: "2026-10-14T00:00:01.000Z" };
      const before = owner.readOwner.readProjectedItem(key, metadata.id, metadata.id);
      wire.emit(event(changed, 3));
      expect(owner.readOwner.readItem(key, metadata.id)).toMatchObject({ outputOmitted: true });
      const after = owner.readOwner.readProjectedItem(key, metadata.id, metadata.id);
      expect(after?.updatedAt).toBe(before?.updatedAt);
      expect(before?.outputVersion).toEqual(expect.any(String));
      expect(after?.outputVersion).toEqual(expect.any(String));
      expect(after?.outputVersion).not.toBe(before?.outputVersion);
      let complete!: (value: AgentTurnItem) => void;
      vi.mocked(wire.port.item).mockImplementationOnce(
        () => new Promise((resolve) => (complete = resolve)),
      );
      const pending = owner.readItem(metadata.id);
      const newer = { ...metadata, updatedAt: "2026-10-14T00:00:02.000Z" };
      wire.emit(event(newer, 4));
      const latest = owner.readOwner.readItem(key, metadata.id);
      complete({ ...full, updatedAt: changed.updatedAt });
      await pending;
      expect(owner.readOwner.readItem(key, metadata.id)).toBe(latest);
      expect(latest).toMatchObject({ outputOmitted: true });
    } finally {
      release();
      owner.dispose();
    }
  });

  test("late snapshot and item delivery cannot repopulate a released read owner", async () => {
    let resolveRead!: (value: AgentRuntimeConversation) => void;
    const pending = new Promise<AgentRuntimeConversation>((resolve) => {
      resolveRead = resolve;
    });
    const wire = transport(conversation([assistant()]));
    vi.spyOn(wire.port, "read").mockReturnValue(pending);
    const owner = new AgentRuntimeConversationOwner(target, wire.port);
    const release = owner.readOwner.subscribeStructure(() => {});
    release();
    resolveRead(conversation([assistant("late secret body")]));
    await pending;
    await Promise.resolve();
    expect(owner.readOwner.readStructure()).toBeNull();
    expect(owner.getSnapshot().conversation).toBeNull();
    expect(wire.port.subscribe).not.toHaveBeenCalled();
  });

  test("rolled-back local Turns release their addressed content", async () => {
    const { owner, wire, release } = await open(conversation([assistant()]));
    const entityKey = owner.readOwner.readStructure()!.turnEntityKeys[0]!;
    const run = owner.getSnapshot().conversation!.snapshot.projection.runs[0]!;
    const topology = owner.getSnapshot().view?.historyTopologyGeneration;
    wire.emit({
      sequence: 2,
      commandId: null,
      event: {
        id: "rolled-back",
        threadId: target.threadId,
        occurredAt: at,
        type: "run.updated",
        payload: { ...run, status: "rolled_back", completedAt: at },
      },
    });
    expect(owner.readOwner.readTurnDetails(entityKey)).toBeNull();
    expect(owner.readOwner.readItem(entityKey, "assistant")).toBeNull();
    expect(owner.readOwner.readStructure()!.turnEntityKeys).toEqual([]);
    // Readers of the rewound history, such as the prompt index, rebind to its replacement.
    expect(owner.getSnapshot().view?.historyTopologyGeneration).toBe(topology! + 1);
    release();
  });
});

test("a subagent's follow-up turns share one child membership that follows its current turn", async () => {
  const initial = conversation([]);
  const first: AgentSnapshot["projection"]["subagents"][number] = {
    id: "first-turn",
    threadId: target.threadId,
    runId: "run",
    parentNodeId: "node",
    origin: "app_owned",
    createdBy: "agent",
    driver: "codex",
    providerInstanceId: "codex",
    providerThreadId: null,
    childThreadId: "child",
    nativeTaskRef: null,
    prompt: "Review the routes",
    title: "Review",
    model: "gpt",
    status: "completed",
    result: "Done",
    startedAt: at,
    completedAt: "2026-10-14T00:01:00.000Z",
    updatedAt: "2026-10-14T00:01:00.000Z",
  };
  const followUp = {
    ...first,
    id: "follow-up",
    prompt: "Also check the tests",
    title: "Routes review",
    status: "running" as const,
    result: null,
    startedAt: "2026-10-14T00:02:00.000Z",
    completedAt: null,
    updatedAt: "2026-10-14T00:02:00.000Z",
  };
  const { owner, wire, release } = await open({
    ...initial,
    snapshot: {
      ...initial.snapshot,
      projection: { ...initial.snapshot.projection, subagents: [first, followUp] },
    },
  });
  expect(owner.children()).toHaveLength(1);
  expect(owner.children()[0]).toMatchObject({
    threadId: "child",
    taskId: "follow-up",
    taskIds: ["first-turn", "follow-up"],
    displayName: "Review",
    statusType: "active",
    createdAtMs: Date.parse(at),
  });
  wire.emit({
    sequence: 2,
    commandId: null,
    event: {
      id: "follow-up-settled",
      threadId: target.threadId,
      occurredAt: at,
      type: "subagent.updated",
      payload: {
        ...followUp,
        status: "completed",
        completedAt: "2026-10-14T00:03:00.000Z",
        updatedAt: "2026-10-14T00:03:00.000Z",
      },
    },
  });
  expect(owner.children()).toHaveLength(1);
  expect(owner.children()[0]).toMatchObject({ taskId: "follow-up", statusType: "idle" });
  release();
});

test("observes completion of native background rosters without opening transcript bodies", async () => {
  const initial = conversation([]);
  const control = {
    ...initial,
    snapshot: {
      ...initial.snapshot,
      projection: {
        ...initial.snapshot.projection,
        thread: { ...initial.snapshot.projection.thread, activeProviderThreadId: "provider:root" },
      },
    },
  };
  const fixture = transport(control);
  vi.mocked(fixture.port.control).mockResolvedValue(control);
  const owner = new AgentRuntimeConversationOwner(target, fixture.port);
  const release = owner.retain();
  await owner.resume();
  const providerThread = {
    id: "provider:root",
    pendingBackgroundTasks: [{ taskId: "command", taskType: "command" }],
  };
  fixture.emit({
    sequence: 2,
    commandId: null,
    event: {
      id: "provider-start",
      threadId: target.threadId,
      occurredAt: at,
      type: "provider-thread.updated",
      payload: providerThread,
    },
  } as unknown as AgentEvent);
  expect(
    owner.getSnapshot().conversation!.snapshot.projection.providerThreads[0]
      ?.pendingBackgroundTasks,
  ).toHaveLength(1);
  fixture.emit({
    sequence: 3,
    commandId: null,
    event: {
      id: "provider-end",
      threadId: target.threadId,
      occurredAt: at,
      type: "provider-thread.updated",
      payload: { ...providerThread, pendingBackgroundTasks: [] },
    },
  } as unknown as AgentEvent);
  expect(
    owner.getSnapshot().conversation!.snapshot.projection.providerThreads[0]
      ?.pendingBackgroundTasks,
  ).toHaveLength(0);
  expect(fixture.port.read).not.toHaveBeenCalled();
  release();
});

test("preserves a native Session question's unknown Run across display and physical-source expiry", async () => {
  const question: AgentTurnItem = {
    ...base("native-question-item", 1),
    runId: null,
    nodeId: "native-question-node",
    providerThreadId: null,
    providerTurnId: null,
    status: "waiting",
    type: "user_input_request",
    requestId: "native-question",
    questions: [
      {
        id: "q",
        header: "Choice",
        question: "Continue?",
        options: [{ label: "Yes", description: "Continue" }],
      },
    ],
  };
  const { owner, wire, release } = await open(conversation([question]));
  expect(owner.getSnapshot().view?.requests[0]).toMatchObject({
    requestId: "native-question",
    turnId: null,
    type: "userInput",
  });
  // A pending question is answered from its request card, not repeated in the transcript.
  expect(owner.readOwner.readStructure()!.turnEntityKeys).toEqual([]);
  wire.emit({
    sequence: 2,
    commandId: null,
    event: {
      id: "expire-question",
      type: "runtime-request.updated",
      threadId: target.threadId,
      occurredAt: at,
      payload: {
        id: "native-question",
        nodeId: "native-question-node",
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "expired",
        responseCapability: { type: "not_resumable", reason: "Native connection closed" },
        createdAt: at,
        resolvedAt: at,
      },
    },
  });
  expect(owner.getSnapshot().view?.requests).toEqual([]);
  release();
});

describe("Agent Runtime prompt navigation", () => {
  const opening = (
    runId: string,
    ordinal: number,
    text = `Prompt for ${runId}`,
  ): Extract<AgentTurnItem, { type: "user_message" }> => ({
    ...base(`user:${runId}`, ordinal),
    runId,
    type: "user_message",
    messageId: `message:${runId}`,
    text,
    attachments: [],
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource: "web",
  });
  const reply = (runId: string, ordinal: number): AgentTurnItem => ({
    ...assistant(`Reply for ${runId}`),
    id: `reply:${runId}`,
    runId,
    ordinal,
    messageId: `reply-message:${runId}`,
    streaming: false,
    status: "completed",
    completedAt: at,
  });
  const withRuns = (
    runIds: readonly string[],
    items: readonly AgentTurnItem[],
    cursor: string | null,
  ): AgentRuntimeConversation => {
    const initial = conversation(items, cursor);
    const template = initial.snapshot.projection.runs[0]!;
    return {
      ...initial,
      snapshot: {
        ...initial.snapshot,
        projection: {
          ...initial.snapshot.projection,
          runs: runIds.map((id, index) => ({
            ...template,
            id,
            ordinal: index + 1,
            userMessageId: `message:${id}`,
            status: "completed" as const,
            completedAt: at,
          })),
        },
      },
    };
  };

  test("reveals an exact steered message outside the prompt index and respects cancellation", async () => {
    const steer = {
      ...opening("run-1", 2),
      id: "steer-item",
      messageId: "steer-message",
      inputIntent: "steer" as const,
    };
    const { owner, wire, release } = await open(
      withRuns(["run-3"], [opening("run-3", 5)], "older"),
      [
        {
          snapshotSequence: 1,
          items: [opening("run-1", 1), steer].map(row),
          nextCursor: null,
          hasMoreHistory: false,
        },
      ],
    );
    try {
      await expect(
        owner.loadHistoryThroughMessage("steer-message", new AbortController().signal),
      ).resolves.toBe("applied");
      expect(wire.port.history).toHaveBeenCalledWith({
        ...target,
        cursor: "older",
        throughEntryId: "steer-message",
      });
      expect(wire.port.promptIndex).not.toHaveBeenCalled();
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(owner.loadHistoryThroughMessage("missing", cancelled.signal)).resolves.toBe(
        "stale",
      );
      expect(wire.port.history).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });

  test("loads older pages through a Run's opening message until that message is resident", async () => {
    // A bounded snapshot carries only the Run records of its own window.
    const { owner, wire, release } = await open(
      withRuns(["run-3"], [opening("run-3", 5), reply("run-3", 6)], "older"),
      [
        // A bounded page can end inside the requested Run.
        {
          snapshotSequence: 1,
          items: [row(reply("run-2", 4))],
          nextCursor: "oldest",
          hasMoreHistory: true,
        },
        {
          snapshotSequence: 1,
          items: [opening("run-1", 1), reply("run-1", 2), opening("run-2", 3)].map(row),
          nextCursor: null,
          hasMoreHistory: false,
        },
      ],
    );

    vi.mocked(wire.port.promptIndex).mockResolvedValueOnce({
      complete: true,
      prompts: ["run-0", "run-1", "run-2", "run-3"].map((runId) => ({
        runId,
        messageId: `message:${runId}`,
        prompt: `Prompt for ${runId}`,
        response: "",
        scheduled: false,
      })),
    });
    expect((await owner.readPromptIndex())?.map((turn) => turn.turnId)).toEqual([
      "run-0",
      "run-1",
      "run-2",
      "run-3",
    ]);

    await expect(owner.loadHistoryThroughRun("run-2")).resolves.toBe("applied");
    expect(wire.port.history).toHaveBeenNthCalledWith(1, {
      ...target,
      cursor: "older",
      throughEntryId: "message:run-2",
    });
    expect(wire.port.history).toHaveBeenNthCalledWith(2, {
      ...target,
      cursor: "oldest",
      throughEntryId: "message:run-2",
    });
    // Older Turns keep their Run identity without the Run records.
    const structure = owner.readOwner.readStructure()!;
    expect(structure.turns.map((turn) => turn.value.details.turnId)).toEqual([
      "run-1",
      "run-2",
      "run-3",
    ]);

    // A Run without visible history, or an unknown one, ends without another read.
    await expect(owner.loadHistoryThroughRun("run-0")).resolves.toBe("stale");
    await expect(owner.loadHistoryThroughRun("unknown")).resolves.toBe("stale");
    expect(wire.port.history).toHaveBeenCalledTimes(2);
    release();
  });
});

function contextConversation(driver = "claudeAgent"): AgentRuntimeConversation {
  const initial = conversation([]);
  const projection = initial.snapshot.projection;
  return {
    ...initial,
    snapshot: {
      ...initial.snapshot,
      projection: {
        ...projection,
        thread: { ...projection.thread, activeProviderThreadId: "context-provider" },
        runs: projection.runs.map((run) => ({
          ...run,
          providerThreadId: "context-provider",
          rootNodeId: "context-root",
          activeAttemptId: "context-attempt",
        })),
        attempts: [
          {
            id: "context-attempt",
            runId: "run",
            attemptOrdinal: 1,
            rootNodeId: "context-root",
            providerInstanceId: "claude",
            providerThreadId: "context-provider",
            providerTurnId: "context-turn",
            nativeThreadId: "native-context",
            reason: "initial",
            status: "running",
            startedAt: at,
            completedAt: null,
          },
        ],
        providerThreads: [
          {
            id: "context-provider",
            driver,
            providerInstanceId: "claude",
            providerSessionId: "physical",
            appThreadId: target.threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: "native-context", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            contextUsage: null,
            createdAt: at,
            updatedAt: at,
          },
        ],
        providerTurns: [
          {
            id: "context-turn",
            providerThreadId: "context-provider",
            nodeId: "context-root",
            runAttemptId: "context-attempt",
            nativeTurnRef: null,
            ordinal: 1,
            status: "running",
            startedAt: at,
            completedAt: null,
            tokenUsage: { usedTokens: 50_000, maxTokens: 200_000, updatedAt: at },
          },
        ],
      },
    },
  };
}

function sendContextEvent(
  wire: ReturnType<typeof transport>,
  payload: AgentEvent["event"],
  sequence: number,
) {
  wire.emit({ sequence, commandId: null, event: payload });
}

describe("Runtime Composer context usage", () => {
  test("native replacement and clear drop old measurements; ACP thread observations share the same presentation", async () => {
    const initial = contextConversation();
    const { owner, wire, release } = await open(initial);
    try {
      const common = { threadId: target.threadId, occurredAt: at };
      const provider = initial.snapshot.projection.providerThreads[0]!;
      sendContextEvent(
        wire,
        {
          ...common,
          id: "replacement",
          type: "provider-thread.updated",
          payload: {
            ...provider,
            nativeThreadRef: {
              driver: provider.driver,
              nativeId: "replacement",
              strength: "strong",
            },
            contextUsage: null,
          },
        },
        2,
      );
      expect(owner.getSnapshot().view?.contextUsage).toBeNull();
      sendContextEvent(
        wire,
        {
          ...common,
          id: "clear",
          type: "thread.metadata-updated",
          payload: {
            ...initial.snapshot.projection.thread,
            activeProviderThreadId: null,
          },
        },
        3,
      );
      expect(owner.getSnapshot().view?.contextUsage).toBeNull();
      sendContextEvent(
        wire,
        {
          ...common,
          id: "acp-usage",
          type: "provider-thread.updated",
          payload: {
            ...provider,
            id: "acp-provider",
            driver: "acpRegistry",
            providerInstanceId: "acp",
            contextUsage: { usedTokens: 42_000 },
          },
        },
        4,
      );
      expect(owner.getSnapshot().view?.contextUsage).toMatchObject({ used: 42_000, size: 0 });
      sendContextEvent(
        wire,
        {
          ...common,
          id: "acp-window",
          type: "provider-thread.updated",
          payload: {
            ...provider,
            id: "acp-provider",
            driver: "acpRegistry",
            providerInstanceId: "acp",
            contextUsage: { usedTokens: 42_000, maxTokens: 128_000 },
          },
        },
        5,
      );
      expect(owner.getSnapshot().view?.contextUsage).toMatchObject({ used: 42_000, size: 128_000 });
    } finally {
      release();
    }
  });
});

test("a completed question keeps a newer unsent revision while adopting the admitted answer", async () => {
  const question = {
    ...runtimeQuestion("editable-question", "run"),
    responseMode: "message" as const,
  };
  const { owner, wire, release } = await open(conversation([assistant(), question]));
  try {
    const id = Object.keys(owner.asyncQuestions.read(target.threadId).questions)[0]!;
    owner.asyncQuestions.open(target.threadId, id);
    owner.asyncQuestions.setDraft(target.threadId, id, "Admitted answer");
    owner.asyncQuestions.acknowledge(target.threadId, [
      { questionItemId: id, question: "Continue?", answer: "Admitted answer" },
    ]);
    owner.asyncQuestions.open(target.threadId, id);
    owner.asyncQuestions.setDraft(target.threadId, id, "A newer revision");
    wire.emit(
      event(
        {
          ...question,
          status: "completed",
          completedAt: at,
          questionAnswer: {
            requestId: "editable-question",
            answers: { q: "Admitted answer" },
            attachmentsByQuestionId: {},
          },
        },
        2,
      ),
    );
    expect(owner.asyncQuestions.read(target.threadId).questions[id]).toMatchObject({
      baseline: "Admitted answer",
      draft: "A newer revision",
    });
    expect(owner.asyncQuestions.read(target.threadId).selectedId).toBe(id);
    expect(
      owner.asyncQuestionAnswers([
        { questionItemId: id, question: "Continue?", answer: "A newer revision" },
      ]),
    ).toEqual([
      { requestId: "editable-question", runId: "run", answers: { q: "A newer revision" } },
    ]);
  } finally {
    release();
    owner.dispose();
  }
});

test("updates the original user message for uncertain delivery and never rewinds native acceptance", async () => {
  const user: Extract<AgentTurnItem, { type: "user_message" }> = {
    ...base("delivery-item", 1),
    type: "user_message",
    messageId: "delivery-message",
    text: "Answer",
    createdBy: "user",
    creationSource: "web",
    inputIntent: "turn_start",
    attachments: [],
    delivery: "pending",
  };
  const { owner, wire, release } = await open(conversation([user, assistant()]));
  try {
    const key = owner.readOwner.readStructure()!.turnEntityKeys[0]!;
    const receipt = (delivery: "unknown" | "accepted", sequence: number) =>
      wire.emit({
        sequence,
        commandId: null,
        event: {
          id: `receipt:${sequence}`,
          threadId: target.threadId,
          occurredAt: at,
          type: "message.delivery.updated",
          payload: { messageId: "delivery-message", delivery },
        },
      });
    receipt("unknown", 2);
    expect(owner.readOwner.readItem(key, user.id)).toMatchObject({ runtimeDelivery: "unknown" });
    receipt("accepted", 3);
    expect(owner.readOwner.readItem(key, user.id)).toMatchObject({ runtimeDelivery: "accepted" });
    receipt("unknown", 4);
    expect(owner.readOwner.readItem(key, user.id)).toMatchObject({ runtimeDelivery: "accepted" });
    expect(wire.port.read).toHaveBeenCalledOnce();
  } finally {
    release();
    owner.dispose();
  }
});

test("a chat with several Members edits only the reader's own messages, and says why not", async () => {
  const fixture = conversation([]);
  const run = fixture.snapshot.projection.runs[0]!;
  const runs: AgentSnapshot["projection"]["runs"] = [1, 2, 3].map((ordinal) => ({
    ...run,
    id: `run-${ordinal}`,
    ordinal,
    status: "completed",
    startedAt: at,
  }));
  const rewindContext: NonNullable<AgentSnapshot["projection"]["rewindContext"]> = {
    runs: runs.map((entry) => ({
      id: entry.id,
      ordinal: entry.ordinal,
      status: entry.status,
      started: true,
      activeAttemptId: entry.activeAttemptId,
      hasProviderTurn: true,
    })),
    checkpointScopes: [{ id: "root", kind: "root_run" }],
    checkpoints: [0, 1, 2, 3].map((ordinal) => ({
      id: `checkpoint-${ordinal}`,
      scopeId: "root",
      runId: ordinal ? `run-${ordinal}` : null,
      ordinalWithinScope: ordinal,
      appRunOrdinal: ordinal || null,
      status: "missing",
    })),
  };
  const { owner, release } = await open({
    ...fixture,
    snapshot: {
      ...fixture.snapshot,
      projection: { ...fixture.snapshot.projection, runs, rewindContext },
    },
  });
  try {
    owner.setCapabilities({ supportsUserTurnEdits: true, supportsForks: true });
    expect(owner.rewindTargetIds()).toEqual(["run-1", "run-2", "run-3"]);
    owner.setCapabilities({
      supportsUserTurnEdits: true,
      supportsForks: true,
      memberEdits: new Map([
        ["run-1", "replied_since"],
        ["run-2", "unavailable"],
        ["run-3", "available"],
      ]),
    });
    expect(owner.getSnapshot().view?.capabilityFlags).toMatchObject({
      editableUserTurnIds: ["run-3"],
      userTurnEditRefusals: { "run-1": REPLIED_SINCE_REASON },
    });
    // Whatever Core says, the Provider's own rewind targets stay what the next read asks about.
    expect(owner.rewindTargetIds()).toEqual(["run-1", "run-2", "run-3"]);
  } finally {
    release();
  }
});

test("preserves paged Provider Turn evidence across historical metadata updates until the attempt changes", async () => {
  const fixture = conversation([], "older");
  const previous = {
    ...fixture.snapshot.projection.runs[0]!,
    id: "historical-a",
    ordinal: 1,
    status: "completed" as const,
    completedAt: at,
    activeAttemptId: "attempt-a",
  };
  const next = { ...previous, id: "historical-b", ordinal: 2, activeAttemptId: "attempt-b" };
  const rewindContext = {
    runs: [previous, next].map((run, index) => ({
      id: run.id,
      ordinal: run.ordinal,
      status: run.status,
      started: true,
      activeAttemptId: run.activeAttemptId,
      hasProviderTurn: true,
      previousRunId: index === 0 ? null : previous.id,
    })),
    checkpointScopes: [{ id: "root", kind: "root_run" }],
    checkpoints: [
      {
        id: "checkpoint-a",
        scopeId: "root",
        runId: previous.id,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        status: "ready" as const,
      },
    ],
  };
  const page: AgentHistoryPage = {
    snapshotSequence: 1,
    items: [previous, next].map((run) =>
      row({
        ...base(`user:${run.id}`, run.ordinal),
        runId: run.id,
        type: "user_message",
        createdBy: "user",
        creationSource: "web",
        inputIntent: "turn_start",
        messageId: `message:${run.id}`,
        text: "Work",
        attachments: [],
      }),
    ),
    rewindContext,
    nextCursor: null,
    hasMoreHistory: false,
  };
  const { owner, wire, release } = await open(fixture, [page]);
  try {
    owner.setCapabilities({ supportsUserTurnEdits: true, supportsForks: true });
    await owner.loadHistoryBoundary(historyBoundary(owner));
    const editable = () => owner.getSnapshot().view!.capabilityFlags.editableUserTurnIds;
    expect(
      owner.getSnapshot().conversation!.snapshot.projection.runs.map((run) => run.id),
    ).not.toContain(previous.id);
    expect(owner.getSnapshot().conversation!.snapshot.projection.providerTurns).toEqual([]);
    expect(editable()).toContain(next.id);
    const update = (sequence: number, activeAttemptId = previous.activeAttemptId) =>
      wire.emit({
        sequence,
        commandId: null,
        event: {
          id: `historical-update:${sequence}`,
          threadId: target.threadId,
          occurredAt: at,
          type: "run.updated",
          payload: { ...previous, activeAttemptId },
        },
      });
    update(2);
    expect(editable()).toContain(next.id);
    update(3);
    expect(editable()).toContain(next.id);
    update(4, "replacement-attempt");
    expect(editable()).not.toContain(next.id);
    const turn = (sequence: number, runAttemptId: string) =>
      wire.emit({
        sequence,
        commandId: null,
        event: {
          id: `historical-turn:${sequence}`,
          threadId: target.threadId,
          occurredAt: at,
          type: "provider-turn.updated",
          payload: {
            id: `turn:${runAttemptId}`,
            providerThreadId: "provider",
            nodeId: "root",
            runAttemptId,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: at,
            completedAt: at,
          },
        },
      });
    turn(5, previous.activeAttemptId);
    expect(editable()).not.toContain(next.id);
    turn(6, "replacement-attempt");
    expect(editable()).toContain(next.id);
  } finally {
    release();
    owner.dispose();
  }
});

test.each(["accept", "decline", "cancel"] as const)(
  "clears an approval from waiting once it is answered: %s",
  async (decision) => {
    const approval: AgentTurnItem = {
      ...base("approval-history", 3),
      type: "approval_request",
      status: "waiting",
      requestId: "history-request",
      requestKind: "permission",
      prompt: "Read /private",
    };
    const initial = conversation([approval]);
    const request = agentRuntimeRow("runtimeRequests", {
      id: "history-request",
      nodeId: "approval-node",
      kind: "permission",
      status: "pending",
      createdAt: at,
      resolvedAt: null,
      responseCapability: { type: "live", providerSessionId: "physical", supportsFeedback: true },
    });
    const source = {
      ...initial,
      snapshot: {
        ...initial.snapshot,
        projection: { ...initial.snapshot.projection, runtimeRequests: [request] },
      },
    };
    const { owner, wire, release } = await open(source);
    try {
      expect(owner.approvals.getSnapshot().pending[0]).toMatchObject({
        kind: "permission",
        live: true,
        supportsFeedback: true,
      });
      wire.emit({
        sequence: 2,
        commandId: null,
        event: {
          id: "approval-resolved",
          threadId: target.threadId,
          occurredAt: at,
          type: "runtime-request.updated",
          payload: {
            ...request,
            status: "resolved",
            resolvedAt: at,
            decision,
            ...(decision === "decline" ? { feedback: "Use public data" } : {}),
          },
        },
      });
      expect(owner.approvals.getSnapshot().pending).toEqual([]);
      expect(owner.getSnapshot().view?.statusActiveFlags).toEqual([]);
    } finally {
      release();
      owner.dispose();
    }
  },
);

test("a hosted refresh keeps the Composer ready through a transient refusal and repairs on the next invalidation", async () => {
  const { owner, wire, release } = await open(conversation([assistant("Loaded transcript")]));
  try {
    const previous = owner.contentSource();
    vi.mocked(wire.port.read).mockRejectedValueOnce(
      new Error("Remote rate limit; retry after 1 second"),
    );
    wire.refresh();
    expect(owner.getSnapshot().connection).toBe("ready");
    await owner.resume();
    expect(owner.getSnapshot().connection).toBe("ready");
    expect(owner.contentSource()).toBe(previous);
    expect(previous?.isCurrent()).toBe(true);
    wire.refresh();
    await owner.resume();
    expect(owner.getSnapshot().connection).toBe("ready");
    expect(owner.contentSource()).not.toBe(previous);
    // The refreshed snapshot is the same chat's content, so its pictures are not read again.
    expect(owner.contentSource()?.identity).toBe(previous?.identity);
    expect(previous?.isCurrent()).toBe(false);
  } finally {
    release();
    owner.dispose();
  }
});

describe("Agent Runtime resident history window", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const inRun = (runId: string, item: AgentTurnItem) => ({ ...item, runId }) as AgentTurnItem;
  const commands = (from: number, count: number, runId = "run") =>
    Array.from({ length: count }, (_, index) => inRun(runId, command(from + index)));
  const page = (items: readonly AgentTurnItem[], nextCursor: string | null = null) =>
    ({
      snapshotSequence: 1,
      items: items.map(row),
      nextCursor,
      hasMoreHistory: nextCursor !== null,
    }) satisfies AgentHistoryPage;
  const withRuns = (
    items: readonly AgentTurnItem[],
    runs: readonly { readonly id: string; readonly status: "completed" | "running" }[],
  ): AgentRuntimeConversation => {
    const initial = conversation(items);
    const [template] = initial.snapshot.projection.runs;
    return {
      ...initial,
      snapshot: {
        ...initial.snapshot,
        projection: {
          ...initial.snapshot.projection,
          runs: runs.map((run, index) => ({ ...template!, ...run, ordinal: index + 1 })),
        },
      },
    };
  };
  const residentIds = (owner: AgentRuntimeConversationOwner) =>
    owner.readOwner
      .readStructure()!
      .turns.flatMap((turn) => turn.itemIds)
      .filter((id): id is string => id !== undefined);

  test("a running Turn stays bounded as its items arrive and keeps the newest ones", async () => {
    const { owner, wire, release } = await open(conversation([]));
    let largest = 0;
    let sequence = 2;
    for (let ordinal = 0; ordinal < 5_000; ordinal += 1) {
      wire.emit(event(command(ordinal), sequence++));
      if (ordinal % 50 === 0) {
        await tick();
        largest = Math.max(largest, residentIds(owner).length);
      }
    }
    await tick();
    expect(largest).toBeLessThanOrEqual(1_050);
    const resident = residentIds(owner);
    expect(resident.length).toBeLessThanOrEqual(1_000);
    expect(resident.at(-1)).toBe("command:4999");
    const entityKey = owner.readOwner.readStructure()!.turnEntityKeys[0]!;
    expect(owner.readOwner.readItem(entityKey, "command:0")).toBeNull();
    expect(owner.readOwner.readItem(entityKey, "command:4999")).toMatchObject({
      type: "commandExecution",
    });
    expect(owner.getSnapshot().view?.turnPagination?.hasLoadedOldest).toBe(false);
    expect(owner.readOwner.readStructure()!.historyComplete).toBe(false);
    release();
  });

  test("a settled Turn on screen stays whole while Turns above it leave", async () => {
    const items = [...commands(0, 700, "run:a"), ...commands(700, 500, "run:b")];
    const { owner, release } = await open(
      withRuns(items, [
        { id: "run:a", status: "completed" },
        { id: "run:b", status: "completed" },
      ]),
    );
    owner.readOwner.setHistoryViewport(Symbol("reader"), {
      oldestProtectedTurnId: "run:b",
      firstProtectedItemId: null,
    });
    await tick();
    const structure = owner.readOwner.readStructure()!;
    expect(structure.turns.map((turn) => turn.itemIds.length)).toEqual([500]);
    expect(structure.timeline?.[0]).toMatchObject({ kind: "gap" });
    release();
  });

  test("a live item keeps its place and older pages return around it in order", async () => {
    const live = { ...command(1), status: "running" as const, completedAt: null };
    const items = commands(0, 1_200).map((item) => (item.id === live.id ? live : item));
    const { owner, wire, release } = await open(conversation(items), [page(items.slice(0, 700))]);
    await tick();
    const resident = residentIds(owner);
    expect(resident.slice(0, 3)).toEqual(["command:0", "command:1", "command:700"]);
    expect(resident).toHaveLength(502);
    const entityKey = owner.readOwner.readStructure()!.turnEntityKeys[0]!;
    wire.emit(event({ ...live, status: "completed", completedAt: at }, 2));
    expect(owner.readOwner.readItem(entityKey, live.id)).toMatchObject({ status: "completed" });
    await expect(owner.loadHistoryBoundary(historyBoundary(owner))).resolves.toBe("applied");
    expect(residentIds(owner)).toEqual(items.map(({ id }) => id));
    release();
  });

  test("a page holds release while in flight and until its reader can reach it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let finish = (_page: AgentHistoryPage) => {};
      const { owner, wire, release } = await open(conversation(commands(300, 900), "older"));
      vi.mocked(wire.port.history).mockImplementation(
        () => new Promise((resolve) => (finish = resolve)),
      );
      const pending = owner.loadHistoryBoundary(historyBoundary(owner));
      let sequence = 2;
      for (const item of commands(1_200, 200)) wire.emit(event(item, sequence++));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(residentIds(owner)).toHaveLength(1_100);
      finish(page(commands(0, 300)));
      await pending;
      await vi.advanceTimersByTimeAsync(1_900);
      expect(residentIds(owner)).toHaveLength(1_400);
      await vi.advanceTimersByTimeAsync(200);
      expect(residentIds(owner)).toHaveLength(500);
      release();
    } finally {
      vi.useRealTimers();
    }
  });
});
