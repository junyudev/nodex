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
  type AgentRuntimeReadTransport,
} from "./agent-runtime-conversation-owner";
import { projectAgentRuntimeItem } from "./agent-runtime-transcript-projection";
import { hasDurableCanonicalFirstSubmission } from "../conversation-launch/session-first-submission-owner";

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
    history: vi.fn(async () => pages[index++]!),
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
    readQueuedMessage: vi.fn(async (input) => {
      const run = queuedRows().find((run) => run.id === input.runId);
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
        attachments: [],
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

describe("Agent Runtime keyed transcript reads", () => {
  test("retains a content source across streamed deltas and retires it on reconnect or release", async () => {
    const { owner, wire, release } = await open(conversation([assistant()]));
    const source = owner.contentSource();
    expect(source?.isCurrent()).toBe(true);
    wire.emit(event(assistant("A streamed extension")));
    expect(owner.contentSource()).toBe(source);
    wire.reset();
    expect(source?.isCurrent()).toBe(false);
    await owner.resume();
    expect(owner.contentSource()).not.toBe(source);
    const replacement = owner.contentSource();
    expect(replacement?.isCurrent()).toBe(true);
    release();
    expect(replacement?.isCurrent()).toBe(false);
    expect(owner.contentSource()).toBeNull();
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
    const messages = Array.from({ length: 30 }, (_, index) => ({
      id: `message:${index}`,
      threadId: target.threadId,
      runId: `queue:${index}`,
      nodeId: null,
      role: "user" as const,
      text: `Queued message ${index} ${"text ".repeat(600)}`,
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
    const readQueuedMessage: NonNullable<AgentRuntimeReadTransport["readQueuedMessage"]> = vi.fn(
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
    const port = { ...wire.port, readQueuePage, readQueuedMessage, readQueuedPreview, attachment };
    const owner = new AgentRuntimeConversationOwner(target, port);
    const releaseControl = owner.retain();
    await owner.resume();
    expect(readQueuePage).not.toHaveBeenCalled();
    expect(readQueuedMessage).not.toHaveBeenCalled();
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
    expect(readQueuedMessage).not.toHaveBeenCalled();
    expect(attachment).not.toHaveBeenCalled();
    expect(owner.getSnapshot().view?.queuedFollowUps.entries[6]?.promptInput?.images).toEqual([
      { caption: "Queue.png", source: "nodex-runtime-image:thread/queued-user%3A6/queue-image" },
    ]);
    expect(await owner.readQueuedInput("queue:6")).toEqual({
      text: messages[6]!.text,
      images: [{ source: "/managed/queue-image.png", caption: "Queue.png" }],
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
  test("reports a queue query failure without substituting an incomplete resident roster", async () => {
    const wire = transport(conversation([]));
    const owner = new AgentRuntimeConversationOwner(target, {
      ...wire.port,
      readQueuePage: vi.fn(async () => {
        throw new Error("Queue unavailable");
      }),
    });
    const release = owner.readOwner.subscribeStructure(() => {});
    await owner.resume();
    await vi.waitFor(() => expect(owner.getSnapshot().view?.queuedFollowUps.status).toBe("error"));
    expect(owner.getSnapshot().view?.queuedFollowUps.error).toBe("Queue unavailable");
    expect(owner.getSnapshot().view?.queuedFollowUps.entries).toEqual([]);
    expect(wire.port.readQueuedMessage).not.toHaveBeenCalled();
    expect(wire.port.readQueuedPreview).not.toHaveBeenCalled();
    release();
  });
  test("projects the canonical queue from retained message leaves and updates exact Run identities", async () => {
    const prompt: AgentTurnItem = {
      ...base("queued:user", 1),
      type: "user_message",
      messageId: "user-message",
      text: "Queued work",
      attachments: [],
      inputIntent: "queued_turn",
      createdBy: "user",
      creationSource: "web",
    };
    const initial = conversation([prompt]);
    const run = {
      ...initial.snapshot.projection.runs[0]!,
      status: "queued" as const,
      queuePosition: 1,
      queueHeld: true,
    };
    const queued = {
      ...initial,
      snapshot: {
        ...initial.snapshot,
        projection: { ...initial.snapshot.projection, runs: [run] },
      },
    };
    const wire = transport(queued);
    vi.mocked(wire.port.control).mockResolvedValue(queued);
    const owner = new AgentRuntimeConversationOwner(target, wire.port);
    const releaseControl = owner.retain();
    await owner.resume();
    expect(owner.getSnapshot().view?.queuedFollowUps.entries).toEqual([]);
    expect(wire.port.read).not.toHaveBeenCalled();
    const release = owner.readOwner.subscribeStructure(() => {});
    await owner.resume();
    expect(owner.getSnapshot().view?.statusType).toBe("idle");
    await vi.waitFor(() =>
      expect(owner.getSnapshot().view?.queuedFollowUps.entries).toMatchObject([
        {
          followUpId: run.id,
          clientUserMessageId: run.userMessageId,
          prompt: "Queued work",
          deliveryOwner: "server",
          pause: { kind: "interrupted" },
        },
      ]),
    );
    wire.emit(event({ ...prompt, text: "Edited work" }, 2));
    await vi.waitFor(() =>
      expect(owner.getSnapshot().view?.queuedFollowUps.entries[0]?.prompt).toBe("Edited work"),
    );
    wire.emit({
      sequence: 3,
      commandId: null,
      event: {
        id: "promoted:queue",
        threadId: target.threadId,
        occurredAt: at,
        type: "run.updated",
        payload: { ...run, status: "running", queueHeld: false },
      },
    });
    await vi.waitFor(() => expect(owner.getSnapshot().view?.queuedFollowUps.entries).toEqual([]));
    expect(owner.getSnapshot().view?.statusType).toBe("active");
    expect(wire.port.read).toHaveBeenCalledOnce();
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

  test("a pending metadata open upgrades once when the transcript activates", async () => {
    const wire = transport(conversation([assistant()]));
    let resolveControl!: (value: AgentRuntimeConversation) => void;
    vi.mocked(wire.port.control).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveControl = resolve;
        }),
    );
    const owner = new AgentRuntimeConversationOwner(target, wire.port);
    const releaseControl = owner.retain();
    const releaseTranscript = owner.readOwner.subscribeStructure(() => {});
    expect(wire.port.read).not.toHaveBeenCalled();
    resolveControl(conversation([]));
    await owner.resume();
    expect(wire.port.control).toHaveBeenCalledOnce();
    expect(wire.port.read).toHaveBeenCalledOnce();
    expect(owner.readOwner.readStructure()?.turnEntityKeys.length).toBe(1);
    releaseControl();
    releaseTranscript();
    expect(owner.readOwner.readStructure()).toBeNull();
  });

  test("metadata-only stream repair never hydrates a transcript", async () => {
    const wire = transport(conversation([assistant()]));
    const owner = new AgentRuntimeConversationOwner(target, wire.port);
    const release = owner.retain();
    await owner.resume();
    wire.reset();
    await owner.resume();
    expect(wire.port.control).toHaveBeenCalledTimes(2);
    expect(wire.port.read).not.toHaveBeenCalled();
    expect(owner.readOwner.readStructure()).toBeNull();
    release();
  });
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
    expect(wire.release).toHaveBeenCalledOnce();
    expect(owner.readOwner.readStructure()).toBeNull();
    expect(owner.readOwner.readTurn(structure.turnEntityKeys[0]!)).toBeNull();
  });

  test.each([100, 10_000])(
    "stream replacement stays item-local with %i resident items",
    async (count) => {
      const resident = Array.from({ length: count - 1 }, (_, ordinal) => command(ordinal));
      const cold = Math.min(count - 1, 499);
      const pages: AgentHistoryPage[] = [];
      for (let end = resident.length - cold; end > 0; end -= 500) {
        const start = Math.max(0, end - 500);
        pages.push({
          snapshotSequence: 1,
          items: resident.slice(start, end).map(row),
          nextCursor: start > 0 ? `cursor:${start}` : null,
          hasMoreHistory: start > 0,
        });
      }
      const { owner, wire, release } = await open(
        conversation(
          [...resident.slice(-cold), assistant()],
          pages.length ? "cursor:initial" : null,
        ),
        pages,
      );
      for (const _page of pages) await owner.loadOlder();
      const structure = owner.readOwner.readStructure()!;
      const entityKey = structure.turnEntityKeys[0]!;
      expect(structure.turns[0]!.itemIds).toHaveLength(count);
      const structureChanged = vi.fn();
      const turnChanged = vi.fn();
      const itemChanged = vi.fn();
      const siblingChanged = vi.fn();
      const controlChanged = vi.fn();
      const releases = [
        owner.readOwner.subscribeStructure(structureChanged),
        owner.readOwner.subscribeTurn(entityKey, turnChanged),
        owner.readOwner.subscribeItem(entityKey, "assistant", itemChanged),
        owner.readOwner.subscribeItem(entityKey, "command:0", siblingChanged),
        owner.subscribe(controlChanged),
      ];
      const before = owner.getSnapshot();
      const sibling = owner.readOwner.readItem(entityKey, "command:0");
      const readTurn = vi.spyOn(owner.readOwner, "readTurn");
      wire.emit(event(assistant("hello updated")));
      expect(itemChanged).toHaveBeenCalledOnce();
      expect(siblingChanged).not.toHaveBeenCalled();
      expect(turnChanged).not.toHaveBeenCalled();
      expect(structureChanged).not.toHaveBeenCalled();
      expect(controlChanged).not.toHaveBeenCalled();
      expect(readTurn).not.toHaveBeenCalled();
      expect(owner.getSnapshot()).toBe(before);
      expect(owner.readOwner.readStructure()).toBe(structure);
      expect(owner.readOwner.readItem(entityKey, "command:0")).toBe(sibling);
      expect(owner.readOwner.readItem(entityKey, "assistant")).toMatchObject({
        type: "agentMessage",
        text: "hello updated",
      });
      releases.forEach((stop) => stop());
      release();
    },
  );

  test("prepends admitted items without re-projecting resident bodies and deduplicates a pending history request", async () => {
    const older = Array.from({ length: 100 }, (_, ordinal) => command(ordinal));
    const newer = Array.from({ length: 500 }, (_, ordinal) => command(ordinal + 100));
    const { owner, wire, release } = await open(conversation(newer, "older"), [
      { snapshotSequence: 1, items: older.map(row), nextCursor: null, hasMoreHistory: false },
    ]);
    const entityKey = owner.readOwner.readStructure()!.turnEntityKeys[0]!;
    const before = owner.readOwner.readItem(entityKey, "command:599");
    const readItem = vi.spyOn(owner.readOwner, "readItem");
    const first = owner.loadOlder();
    const second = owner.loadOlder();
    expect(first).toBe(second);
    await first;
    expect(wire.port.history).toHaveBeenCalledOnce();
    expect(readItem.mock.calls.every(([, id]) => older.some((item) => item.id === id))).toBe(true);
    expect(owner.readOwner.readStructure()!.turns[0]!.itemIds).toHaveLength(600);
    expect(owner.readOwner.readItem(entityKey, "command:599")).toBe(before);
    expect(owner.getSnapshot().view?.turnPagination?.hasLoadedOldest).toBe(true);
    release();
  });

  test("full item detail hydrates only its address and leaves siblings stable", async () => {
    const { owner, wire, release } = await open(conversation([command(0), command(1)]));
    const full: AgentTurnItem = {
      ...command(0),
      type: "command_execution",
      input: "echo 0",
      output: "complete output",
      exitCode: 0,
    };
    vi.spyOn(wire.port, "item").mockResolvedValue(full);
    const entityKey = owner.readOwner.readStructure()!.turnEntityKeys[0]!;
    const sibling = owner.readOwner.readItem(entityKey, "command:1");
    expect(await owner.readItem("command:0")).toBe(full);
    expect(owner.readOwner.readItem(entityKey, "command:0")).toMatchObject({
      aggregatedOutput: "complete output",
    });
    expect(owner.readOwner.readItem(entityKey, "command:1")).toBe(sibling);
    release();
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

  test("thread metadata updates retain history and do not reopen the transcript", async () => {
    const { owner, wire, release } = await open(conversation([assistant()]));
    const structure = owner.readOwner.readStructure();
    const thread = owner.getSnapshot().conversation!.snapshot.projection.thread;
    wire.emit({
      sequence: 2,
      commandId: null,
      event: {
        id: "title",
        threadId: target.threadId,
        occurredAt: at,
        type: "thread.metadata-updated",
        payload: { ...thread, title: "Renamed" },
      },
    });
    expect(owner.getSnapshot().view?.threadName).toBe("Renamed");
    expect(owner.readOwner.readStructure()).toBe(structure);
    expect(wire.port.read).toHaveBeenCalledOnce();
    expect(wire.port.subscribe).toHaveBeenCalledOnce();
    release();
  });

  test("rolled-back local Turns release their addressed content", async () => {
    const { owner, wire, release } = await open(conversation([assistant()]));
    const entityKey = owner.readOwner.readStructure()!.turnEntityKeys[0]!;
    const run = owner.getSnapshot().conversation!.snapshot.projection.runs[0]!;
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
    release();
  });

  test("engine lifecycle and native/app-owned delegation use shared presentation without a raw request replica", async () => {
    const approval: AgentTurnItem = {
      ...base("approval", 3),
      status: "waiting",
      type: "approval_request",
      requestId: "request",
      requestKind: "command",
      prompt: "Approve command?",
    };
    const task: AgentTurnItem = {
      ...base("task", 4),
      type: "subagent",
      origin: "app_owned",
      driver: "claude-agent-sdk",
      providerInstanceId: "codex",
      subagentId: "task",
      childThreadId: "child",
      prompt: "Do the task",
      result: null,
      status: "running",
    };
    const { owner, wire, release } = await open(conversation([approval, task]));
    expect(owner.getSnapshot().view?.requests[0]).toMatchObject({
      requestId: "request",
      turnId: "run",
      type: "approval",
    });
    expect(owner.getSnapshot().view?.canonicalRequests).toEqual([]);
    expect(projectAgentRuntimeItem(task)).toMatchObject({
      type: "collabAgentToolCall",
      receiverThreadIds: ["child"],
      status: "inProgress",
    });
    const run = owner.getSnapshot().conversation!.snapshot.projection.runs[0]!;
    wire.emit({
      sequence: 2,
      commandId: null,
      event: {
        id: "completed",
        threadId: target.threadId,
        occurredAt: at,
        type: "run.updated",
        payload: { ...run, status: "completed", completedAt: at },
      },
    });
    expect(
      owner.readOwner.readTurnDetails(owner.readOwner.readStructure()!.turnEntityKeys[0]!)?.status,
    ).toBe("completed");
    release();
  });
});

test("native observations without child Threads never acquire navigable child membership", async () => {
  const initial = conversation([]);
  const withTasks = {
    ...initial,
    snapshot: {
      ...initial.snapshot,
      projection: {
        ...initial.snapshot.projection,
        subagents: [
          {
            id: "native-task",
            threadId: target.threadId,
            runId: "run",
            parentNodeId: "node",
            origin: "provider_native",
            createdBy: "agent",
            driver: "claudeAgent",
            providerInstanceId: "claude",
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Work",
            title: "Native task",
            model: null,
            status: "running",
            result: null,
            startedAt: at,
            completedAt: null,
            updatedAt: at,
          },
        ] as AgentSnapshot["projection"]["subagents"],
      },
    },
  };
  const { owner, release } = await open(withTasks);
  expect(owner.children()[0]).toMatchObject({
    threadId: "native-task",
    showInlineActivity: false,
    task: { id: "native-task", status: "running" },
  });
  release();
});

test("bounds implicit control metadata across ten thousand task and Run updates", async () => {
  const fixture = transport(conversation([]));
  const owner = new AgentRuntimeConversationOwner(target, fixture.port);
  const release = owner.retain();
  await owner.resume();
  const initialRun = owner.getSnapshot().conversation!.snapshot.projection.runs[0]!;
  const publish = (type: AgentEvent["event"]["type"], payload: unknown, sequence: number) =>
    fixture.emit({
      sequence,
      commandId: null,
      event: { id: `event:${sequence}`, type, threadId: target.threadId, occurredAt: at, payload },
    } as AgentEvent);
  const body = "body ".repeat(200_000);
  const task = {
    id: "task",
    threadId: target.threadId,
    origin: "provider_native",
    status: "completed",
    title: "Task",
    childThreadId: null,
    childRunId: null,
    updatedAt: at,
    createdAt: at,
    prompt: body,
    result: body,
  };
  for (let index = 0; index < 10_000; index += 1) {
    publish(
      "run.created",
      { ...initialRun, id: `run:${index}`, ordinal: index + 2, status: "completed" },
      index * 2 + 2,
    );
    publish("subagent.updated", { ...task, id: `task:${index}` }, index * 2 + 3);
  }
  for (let index = 0; index < 10; index += 1)
    publish(
      "subagent.updated",
      { ...task, id: `active:${index}`, status: "running" },
      20_002 + index,
    );
  const projection = owner.getSnapshot().conversation!.snapshot.projection;
  expect(projection.runs).toHaveLength(6);
  expect(projection.runs.some((run) => run.id === initialRun.id)).toBe(true);
  expect(projection.subagents.filter((row) => row.status === "running")).toHaveLength(4);
  expect(projection.subagents.filter((row) => row.status === "completed")).toHaveLength(10);
  expect(JSON.stringify(projection).length).toBeLessThan(32_000);
  expect(task.prompt).toBe(body);
  expect(fixture.port.read).not.toHaveBeenCalled();
  expect(owner.readOwner.readStructure()).toBeNull();
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
  const key = owner.readOwner.readStructure()!.turnEntityKeys[0]!;
  expect(owner.readOwner.readTurnDetails(key)?.turnId).toBeNull();
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
