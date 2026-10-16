import type {
  AgentEvent,
  AgentHistoryPage,
  AgentSnapshot,
  AgentTurnItem,
} from "@nodex/agent-runtime/contracts";
import type {
  AgentRuntimeConversation,
  AgentRuntimeSessionTarget,
  AgentRuntimeQueuePage,
} from "../../../shared/agent-runtime-api";
import { AGENT_RUNTIME_CONTROL_EVENT_TYPES } from "../../../shared/agent-runtime-api";
import type {
  CodexConversationChildMembership,
  CodexConversationServerRequest,
  CodexConversationSnapshot,
  CodexCanonicalItem,
  CodexPromptInput,
} from "../../../shared/types";
import { buildAgentRuntimeAttachmentSource } from "../../../shared/agent-runtime-attachments";
import {
  CODEX_INTERRUPTED_STEER_REASON,
  EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION,
  type CodexQueuedFollowUpProjection,
  type CodexQueuedFollowUp,
} from "../../../shared/codex-queued-follow-up-state";
import {
  codexTranscriptItemAddress,
  type CodexTranscriptChange,
  type CodexTranscriptSnapshot,
  type CodexTranscriptTurnDetails,
} from "../../../shared/codex-transcript-projection";
import {
  CODEX_HISTORY_GAP_ESTIMATED_HEIGHT_PX,
  type CodexHistoryRow,
} from "../../../shared/codex-conversation-state/codex-history-topology";
import { CodexTranscriptReadOwner } from "./normalized-transcript-read-owner";
import {
  agentRuntimeRuntime,
  type AgentRuntimeRendererTransport,
} from "../../lib/agent-runtime-runtime";
import {
  agentRuntimeItemStatus,
  agentRuntimeTime,
  agentRuntimeTurnStatus,
  projectAgentRuntimeItem,
  projectAgentRuntimeRequest,
  isAgentRuntimeAsyncQuestion,
  projectAgentRuntimeHookRun,
  type AgentRuntimeQuestionRequest,
  projectAgentRuntimeAsyncQuestionMessage,
  projectAgentRuntimeTurnDetails,
  type AgentRuntimeProjectedItem,
  type AgentRuntimeRun,
  type AgentRuntimeThread,
} from "./agent-runtime-transcript-projection";

import type { ConversationContentSource } from "./conversation-runtime";
import { createAsyncQuestionRuntime } from "./async-question-runtime";
import type { CodexCanonicalHookRun } from "../../../shared/codex-conversation-state/codex-conversation-state";
import {
  decodeCodexAsyncQuestionReplies,
  expandCodexAsyncQuestions,
  formatCodexAsyncQuestionReplies,
  type CodexAsyncQuestionReply,
} from "../../../shared/codex-async-user-input";

export type AgentRuntimeReadTransport = Pick<
  AgentRuntimeRendererTransport,
  | "read"
  | "control"
  | "history"
  | "item"
  | "subscribe"
  | "readQueuePage"
  | "readQueuedMessage"
  | "readQueuedPreview"
  | "attachment"
>;
export type ResolvedAgentRuntimeTarget = AgentRuntimeSessionTarget & { readonly threadId: string };
export interface AgentRuntimeConversationOwnerSnapshot {
  readonly conversation: AgentRuntimeConversation | null;
  readonly view: CodexConversationSnapshot | null;
  readonly connection: "connecting" | "ready" | "failed";
  readonly error: string | null;
  readonly historyLoading: boolean;
}
interface ResidentItem {
  readonly entityKey: string;
  readonly sourceThreadId: string;
  readonly sourceItemId: string;
  readonly runId: string | null;
  readonly ordinal: number;
  readonly type: AgentTurnItem["type"];
  readonly opening: boolean;
  readonly taskId: string | null;
  readonly nodeId: string | null;
  readonly status: AgentTurnItem["status"];
  readonly startedAt: string | null;
}
interface ResidentTurn {
  readonly details: CodexTranscriptTurnDetails;
  readonly itemIds: readonly string[];
  readonly hasSubagentActivity: boolean;
}
const isTurnOpening = (
  item: AgentTurnItem,
): item is Extract<AgentTurnItem, { type: "user_message" }> =>
  item.type === "user_message" &&
  (item.inputIntent === "turn_start" || item.inputIntent === "queued_turn");
const runKey = (threadId: string, runId: string) => JSON.stringify(["agent-run", threadId, runId]);
const emptyChildren: readonly CodexConversationChildMembership[] = [];

const controlStatusIsLive = (status: string): boolean =>
  ["queued", "preparing", "starting", "running", "waiting", "pending", "paused"].includes(status);
const workIsActive = (status: string): boolean =>
  status === "pending" || status === "running" || status === "waiting";
const runIsActive = (status: AgentRuntimeRun["status"]): boolean =>
  status === "preparing" || status === "starting" || status === "running" || status === "waiting";
const itemIsLive = (item: AgentTurnItem): boolean =>
  workIsActive(item.status) || ("streaming" in item && item.streaming);
function controlRun(run: AgentRuntimeRun, previous?: AgentRuntimeRun): AgentRuntimeRun {
  const { restartCancelledBackgroundWork: _work, delegatedCompletion, ...metadata } = run;
  const cohort = delegatedCompletion ?? previous?.delegatedCompletion;
  return cohort && cohort.disposition !== "open" && cohort.delivery === null
    ? { ...metadata, delegatedCompletion: cohort }
    : metadata;
}

/** Patch the addressed presentation value without retaining or re-projecting its source body. */
function retireItem(
  item: CodexCanonicalItem,
  startedAt: string | null,
  completedAt: string,
): CodexCanonicalItem {
  const durationMs = startedAt
    ? Math.max(0, (agentRuntimeTime(completedAt) ?? 0) - (agentRuntimeTime(startedAt) ?? 0))
    : null;
  switch (item.type) {
    case "commandExecution":
      return { ...item, status: "declined", durationMs };
    case "fileChange":
      return { ...item, status: "declined" };
    case "dynamicToolCall":
      return { ...item, status: "failed", success: false, durationMs };
    // A provider-native task dies with its Run; an application-owned child reports its own end.
    case "delegatedTask":
      return item.childThreadId === null ? { ...item, status: "stopped" } : item;
    default:
      return item;
  }
}
const recentMetadata = <T extends { readonly id: string; readonly updatedAt: string }>(
  rows: readonly T[],
): T[] =>
  [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));

/** Releases body sidecars at the renderer boundary; only the keyed read owner retains transcript text. */
function controlConversation(value: AgentRuntimeConversation): AgentRuntimeConversation {
  const projection = value.snapshot.projection;
  return {
    ...value,
    snapshot: {
      ...value.snapshot,
      projection: {
        ...projection,
        turnItems: [],
        visibleTurnItems: [],
        messages: [],
        nodes: [],
        attempts: [],
        plans: [],
        checkpoints: [],
        checkpointScopes: [],
        contextHandoffs: [],
        contextTransfers: [],
        runs: projection.runs.map((run) => controlRun(run)),
        subagents: projection.subagents.map((task) => ({
          ...task,
          prompt: "",
          result: null,
          progress: undefined,
          workflow: undefined,
        })),
      },
    },
  };
}

/** A window-scoped query cache over canonical engine events, with no execution writer or second reducer. */
export class AgentRuntimeConversationOwner {
  readonly readOwner: CodexTranscriptReadOwner;
  readonly #transport: AgentRuntimeReadTransport;
  readonly #target: ResolvedAgentRuntimeTarget;
  readonly #listeners = new Set<() => void>();
  readonly #items = new Map<string, ResidentItem>();
  readonly #liveItemsByRun = new Map<string, Set<string>>();
  readonly #nodeRuns = new Map<string, { readonly runId: string | null; readonly live: boolean }>();
  readonly #cohortHeads = new Map<
    string,
    Pick<NonNullable<AgentRuntimeRun["delegatedCompletion"]>, "disposition" | "nextGeneration">
  >();
  readonly #residentTaskIds = new Set<string>();
  readonly #turns = new Map<string, ResidentTurn>();
  /** Each Turn's hooks by item, presented with its reply rather than as transcript rows. */
  readonly #hookRuns = new Map<string, Map<string, CodexCanonicalHookRun>>();
  readonly #requests = new Map<string, CodexConversationServerRequest>();
  /** Unanswered asynchronous questions by request, answerable until the Agent settles them. */
  readonly #asyncQuestions = new Map<string, AgentRuntimeQuestionRequest>();
  /** Drafts and panel state for this conversation's asynchronous questions. */
  readonly asyncQuestions = createAsyncQuestionRuntime();
  #turnKeys: string[] = [];
  #state: AgentRuntimeConversationOwnerSnapshot = {
    conversation: null,
    view: null,
    connection: "connecting",
    error: null,
    historyLoading: false,
  };
  #children: readonly CodexConversationChildMembership[] = emptyChildren;
  #leases = 0;
  #generation = 0;
  #historyGeneration = 0;
  #sequence = 0;
  #cursor: string | null = null;
  #transcriptActive = false;
  #transcriptHydrated = false;
  #readMode: "control" | "transcript" | null = null;
  #releaseEvents: (() => void) | null = null;
  #opening: Promise<void> | null = null;
  #historyRequest: Promise<void> | null = null;
  #disposed = false;
  #canEditLastUserTurn = false;
  #contentSource: ConversationContentSource | null = null;
  #queuePage: AgentRuntimeQueuePage | null = null;
  #queueEntries: readonly CodexQueuedFollowUp[] = [];
  #queueCursor: string | undefined;
  #queuePrevious: Array<string | undefined> = [];
  #queueRequest: Promise<void> | null = null;
  #queueGeneration = 0;
  #queueDirty = false;
  #queueStatus: "ready" | "loading" | "error" = "ready";
  #queueError: string | null = null;

  constructor(
    target: ResolvedAgentRuntimeTarget,
    transport: AgentRuntimeReadTransport = agentRuntimeRuntime,
  ) {
    this.#target = target;
    this.#transport = transport;
    this.readOwner = new CodexTranscriptReadOwner({
      hostId: "local",
      threadId: target.threadId,
      connect: () => {
        this.#transcriptActive = true;
        const release = this.retain();
        this.#restart();
        return () => {
          this.#transcriptActive = false;
          this.#clearTranscript();
          release();
          if (this.#leases > 0) this.#restart();
        };
      },
    });
  }
  get threadId(): string {
    return this.#target.threadId;
  }
  readonly getSnapshot = (): AgentRuntimeConversationOwnerSnapshot => this.#state;
  readonly contentSource = (): ConversationContentSource | null =>
    this.#contentSource?.isCurrent() ? this.#contentSource : null;
  readonly setCapabilities = (input: { readonly canEditLastUserTurn: boolean }): void => {
    if (this.#canEditLastUserTurn === input.canEditLastUserTurn) return;
    this.#canEditLastUserTurn = input.canEditLastUserTurn;
    this.#publishView();
  };
  readonly children = (): readonly CodexConversationChildMembership[] => this.#children;
  readonly queueBoundary = (): string | null => this.#queuePage?.nextRunId ?? null;
  readonly nextQueuePage = async (): Promise<void> => {
    await this.#queueRequest;
    if (!this.#queuePage?.nextCursor) return;
    this.#queuePrevious.push(this.#queueCursor);
    this.#queueCursor = this.#queuePage.nextCursor;
    await this.#refreshQueue();
  };
  readonly previousQueuePage = async (): Promise<void> => {
    await this.#queueRequest;
    if (this.#queuePrevious.length === 0) return;
    this.#queueCursor = this.#queuePrevious.pop();
    await this.#refreshQueue();
  };
  readonly readQueuedInput = async (runId: string): Promise<CodexPromptInput> => {
    const row = this.#queuePage?.entries.find((entry) => entry.runId === runId);
    if (!row) throw new Error("This queued message is no longer available");
    const message = await this.#transport.readQueuedMessage({ ...this.#target, runId });
    if (!message || message.id !== row.userMessageId || message.threadId !== this.#target.threadId)
      throw new Error("This queued message is no longer available");
    const images: NonNullable<CodexPromptInput["images"]> = [];
    for (const attachment of message.attachments) {
      if (attachment.type !== "image") continue;
      if (!row.userItemId) throw new Error("This queued image is not available yet");
      const source = await this.#transport.attachment({
        ...this.#target,
        sourceThreadId: message.threadId,
        itemId: row.userItemId,
        attachmentId: attachment.id,
      });
      if (!source) throw new Error("This queued image is no longer available");
      images.push({ source: source.path, caption: attachment.name });
    }
    if (!this.#queuePage?.entries.some((entry) => entry.runId === runId))
      throw new Error("This queued message is no longer available");
    return { text: message.text, images };
  };
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly retain = (): (() => void) => {
    if (this.#disposed) return () => {};
    this.#leases += 1;
    if (this.#leases === 1) this.#restart();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#leases -= 1;
      if (this.#leases > 0) return;
      this.#generation += 1;
      this.#releaseEvents?.();
      this.#releaseEvents = null;
      this.#opening = null;
      this.#readMode = null;
      this.#clearTranscript();
      this.#requests.clear();
      this.#asyncQuestions.clear();
      this.asyncQuestions.clear(this.threadId);
      this.#nodeRuns.clear();
      this.#cohortHeads.clear();
      this.#patch({
        conversation: null,
        view: null,
        connection: "connecting",
        historyLoading: false,
      });
    };
  };
  readonly resume = async (): Promise<void> => {
    if (this.#disposed) return;
    if (
      !this.#opening &&
      (this.#state.connection !== "ready" ||
        !this.#releaseEvents ||
        this.#readMode !== (this.#transcriptActive ? "transcript" : "control"))
    )
      this.#restart();
    await this.#opening;
  };
  readonly loadOlder = (): Promise<void> => {
    if (this.#historyRequest) return this.#historyRequest;
    if (!this.#cursor || !this.#transcriptActive || this.#disposed) return Promise.resolve();
    const generation = this.#generation;
    const cursor = this.#cursor;
    this.#patch({ historyLoading: true });
    const pending = this.#transport
      .history({ ...this.#target, cursor })
      .then((page) => {
        if (generation !== this.#generation || !this.#transcriptActive) return;
        if (page.hasMoreHistory && page.nextCursor === cursor)
          throw new Error("History cursor did not advance");
        this.#prepend(page);
      })
      .catch((cause: unknown) => {
        if (generation === this.#generation) this.#patch({ error: messageOf(cause) });
      })
      .finally(() => {
        if (this.#historyRequest !== pending) return;
        this.#historyRequest = null;
        if (generation === this.#generation) this.#patch({ historyLoading: false });
      });
    this.#historyRequest = pending;
    return pending;
  };
  /** Explicit detail hydrates one addressed item, never its siblings or the whole Turn. */
  readonly readItem = async (itemId: string): Promise<AgentTurnItem | null> => {
    const source = this.#items.get(itemId);
    if (!source) return null;
    const generation = this.#generation;
    const item = await this.#transport.item({
      ...this.#target,
      sourceThreadId: source.sourceThreadId,
      itemId: source.sourceItemId,
    });
    if (generation !== this.#generation || !this.#transcriptActive || !item) return item;
    this.#rememberItem(source, item);
    const value = projectAgentRuntimeItem(item, this.#thread()?.worktreePath ?? "");
    if (value)
      this.readOwner.applyEvent({
        type: "changes",
        changes: [
          {
            type: "item",
            key: { ...this.readOwner.key, entityKey: source.entityKey, itemId },
            value,
          },
        ],
      });
    return item;
  };
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#releaseEvents?.();
    this.#releaseEvents = null;
    this.#clearTranscript();
    this.#nodeRuns.clear();
    this.#cohortHeads.clear();
    this.readOwner.dispose();
    this.#listeners.clear();
  }

  #thread(): AgentRuntimeThread | undefined {
    return this.#state.conversation?.snapshot.projection.thread;
  }
  #run(id: string | null): AgentRuntimeRun | undefined {
    return id === null
      ? undefined
      : this.#state.conversation?.snapshot.projection.runs.find((run) => run.id === id);
  }
  #patch(patch: Partial<AgentRuntimeConversationOwnerSnapshot>): void {
    if (
      Object.entries(patch).every(
        ([key, value]) => this.#state[key as keyof AgentRuntimeConversationOwnerSnapshot] === value,
      )
    )
      return;
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
  #restart(): void {
    if (this.#disposed || this.#leases === 0 || this.#opening) return;
    const generation = ++this.#generation;
    const transcript = this.#transcriptActive;
    this.#readMode = transcript ? "transcript" : "control";
    this.#historyRequest = null;
    this.#releaseEvents?.();
    this.#releaseEvents = null;
    this.#patch({ connection: "connecting", error: null });
    const pending = (
      transcript ? this.#transport.read(this.#target) : this.#transport.control(this.#target)
    )
      .then(async (conversation) => {
        if (generation !== this.#generation || this.#disposed) return;
        if (
          conversation.threadId !== this.#target.threadId ||
          conversation.sessionId !== this.#target.sessionId
        )
          throw new Error("Conversation binding changed");
        this.#contentSource = {
          identity: JSON.stringify([this.#target.sessionId, this.#target.threadId, generation]),
          isCurrent: () =>
            generation === this.#generation &&
            !this.#disposed &&
            this.#leases > 0 &&
            this.#transcriptActive &&
            this.#state.connection === "ready" &&
            this.readOwner.readStructure() !== null,
        };
        this.#sequence = conversation.snapshot.snapshotSequence;
        if (transcript) {
          this.#cursor = conversation.snapshot.historyCursor ?? null;
          this.#historyGeneration += 1;
        }
        this.#requests.clear();
        this.#asyncQuestions.clear();
        this.#nodeRuns.clear();
        this.#cohortHeads.clear();
        this.#state = {
          ...this.#state,
          conversation: controlConversation(conversation),
          connection: "ready",
          error: null,
        };
        for (const node of conversation.snapshot.projection.nodes) this.#captureNode(node);
        for (const run of conversation.snapshot.projection.runs) this.#captureCohort(run);
        for (const row of conversation.snapshot.projection.visibleTurnItems)
          this.#captureRequest(row.item, row.visibility !== "inherited");
        this.#reconcileAsyncQuestions();
        this.#updateChildren();
        if (transcript && this.#transcriptActive) this.#reset(conversation.snapshot);
        this.#publishView();
        if (transcript) void this.#refreshQueue();
        const release = await this.#transport.subscribe(
          {
            ...this.#target,
            afterSequence: this.#sequence,
            ...(transcript ? {} : { eventTypes: AGENT_RUNTIME_CONTROL_EVENT_TYPES }),
          },
          (notification) => {
            if (
              generation !== this.#generation ||
              this.#disposed ||
              notification.threadId !== this.#target.threadId
            )
              return;
            if (notification.type === "reset-required") {
              this.#releaseEvents?.();
              this.#releaseEvents = null;
              this.#opening = null;
              this.#restart();
              return;
            }
            this.#accept(notification.event);
          },
        );
        if (generation !== this.#generation || this.#disposed) {
          release();
          return;
        }
        this.#releaseEvents = release;
      })
      .catch((cause: unknown) => {
        if (generation === this.#generation)
          this.#patch({ connection: "failed", error: messageOf(cause) });
      })
      .finally(() => {
        if (this.#opening !== pending) return;
        this.#opening = null;
        if (
          this.#leases > 0 &&
          transcript !== this.#transcriptActive &&
          this.#state.connection === "ready"
        ) {
          this.#restart();
          return this.#opening;
        }
      });
    this.#opening = pending;
  }

  #reset(snapshot: AgentSnapshot): void {
    this.#clearTranscript();
    const changes = this.#admit(snapshot.projection.visibleTurnItems, true);
    const turnsByKey: Record<string, CodexTranscriptSnapshot["turnsByKey"][string]> = {};
    const itemsByKey: Record<string, CodexCanonicalItem> = {};
    for (const change of changes) {
      if (change.type === "item" && change.value)
        itemsByKey[codexTranscriptItemAddress(change.key.entityKey, change.key.itemId)] =
          change.value;
    }
    for (const [entityKey, turn] of this.#turns)
      turnsByKey[entityKey] = {
        details: turn.details,
        hasSubagentActivity: turn.hasSubagentActivity,
        itemSlots: {
          length: turn.itemIds.length,
          entries: turn.itemIds.map((itemId, index) => ({ index, itemId })),
        },
      };
    this.readOwner.applyEvent({
      type: "reset",
      value: {
        resumeState: "resumed",
        historyComplete: !snapshot.hasMoreHistory,
        timeline: this.#timeline(),
        itemTimeline: null,
        turnEntityKeys: this.#turnKeys,
        turnsByKey,
        itemsByKey,
        realtimeItems: {},
      },
    });
    this.#transcriptHydrated = true;
  }
  #clearTranscript(): void {
    this.#transcriptHydrated = false;
    this.#items.clear();
    this.#liveItemsByRun.clear();
    this.#residentTaskIds.clear();
    this.#turns.clear();
    this.#hookRuns.clear();
    this.#turnKeys = [];
    this.#queueGeneration += 1;
    this.#queuePage = null;
    this.#queueEntries = [];
    this.#queueCursor = undefined;
    this.#queuePrevious = [];
    this.#queueRequest = null;
    this.#queueDirty = false;
    this.#queueStatus = "ready";
    this.#queueError = null;
  }
  #refreshQueue(): Promise<void> {
    if (!this.#transcriptActive || this.#disposed) return Promise.resolve();
    if (this.#queueRequest) {
      this.#queueDirty = true;
      return this.#queueRequest;
    }
    this.#queueDirty = false;
    this.#queueStatus = "loading";
    this.#queueError = null;
    this.#publishView();
    const generation = this.#queueGeneration;
    const cursor = this.#queueCursor;
    const request = this.#transport
      .readQueuePage({ ...this.#target, ...(cursor === undefined ? {} : { cursor }) })
      .then(async (page) => {
        const entries: CodexQueuedFollowUp[] = [];
        for (const row of page.entries) {
          if (generation !== this.#queueGeneration || !this.#transcriptActive) return;
          const cached = this.#queueEntries.find((entry) => entry.followUpId === row.runId);
          let prompt = cached?.prompt;
          let images = cached?.promptInput?.images ?? [];
          if (prompt === undefined) {
            const entityKey = runKey(this.#target.threadId, row.runId);
            const resident =
              row.userItemId && this.#items.has(row.userItemId)
                ? this.readOwner.readItem(entityKey, row.userItemId)
                : null;
            if (resident?.type === "userMessage" && resident.clientId === row.userMessageId) {
              prompt = resident.content.find((part) => part.type === "text")?.text;
              images = resident.content.flatMap((part) =>
                part.type === "image" && "url" in part ? [{ source: part.url }] : [],
              );
            } else {
              const message = await this.#transport.readQueuedPreview({
                ...this.#target,
                runId: row.runId,
              });
              if (
                message?.messageId === row.userMessageId &&
                message.threadId === this.#target.threadId
              ) {
                prompt = message.text;
                images = row.userItemId
                  ? message.images.map((image) => ({
                      caption: image.name,
                      source: buildAgentRuntimeAttachmentSource({
                        sourceThreadId: message.threadId,
                        itemId: row.userItemId!,
                        attachmentId: image.id,
                      }),
                    }))
                  : [];
              } else continue;
            }
          }
          // Answers to the Agent's questions read as question and answer, not their envelope.
          const replies = prompt === undefined ? null : decodeCodexAsyncQuestionReplies(prompt);
          const preview = (
            replies ? formatCodexAsyncQuestionReplies(replies) : (prompt ?? "Queued message")
          ).slice(0, 2048);
          entries.push({
            deliveryOwner: "server",
            canSendNow: true,
            followUpId: row.runId,
            clientUserMessageId: row.userMessageId,
            threadId: this.#target.threadId,
            prompt: preview,
            promptInput: { text: preview, images },
            createdAtMs: agentRuntimeTime(row.requestedAt) ?? 0,
            collaborationMode: null,
            serviceTier: null,
            summary: null,
            pause: row.held
              ? { kind: "interrupted", reason: CODEX_INTERRUPTED_STEER_REASON }
              : null,
          });
        }
        if (
          generation !== this.#queueGeneration ||
          cursor !== this.#queueCursor ||
          !this.#transcriptActive
        )
          return;
        this.#queuePage = page;
        this.#queueEntries = entries;
        this.#queueStatus = "ready";
        this.#publishView();
      })
      .catch((error) => {
        if (generation !== this.#queueGeneration || !this.#transcriptActive) return;
        this.#queueEntries = [];
        this.#queueStatus = "error";
        this.#queueError = messageOf(error);
        this.#publishView();
      })
      .finally(() => {
        if (this.#queueRequest !== request) return;
        this.#queueRequest = null;
        if (this.#queueDirty) void this.#refreshQueue();
      });
    this.#queueRequest = request;
    return request;
  }
  #timeline(): readonly CodexHistoryRow[] {
    const content: CodexHistoryRow[] = this.#turnKeys.map((entityKey) => ({
      kind: "content",
      key: entityKey,
      turnKey: entityKey,
      entityKey,
    }));
    if (!this.#cursor) return content;
    return [
      {
        kind: "gap",
        key: `agent-history:${this.#historyGeneration}`,
        estimatedHeightPx: CODEX_HISTORY_GAP_ESTIMATED_HEIGHT_PX,
        olderBoundary: null,
        newerBoundary: {
          generation: this.#historyGeneration,
          islandId: "agent-runtime",
          edge: "older",
          boundaryId: "agent-runtime:older",
          progressKey: this.#cursor,
          handle: {
            source: "ordinary",
            cursor: this.#cursor,
            oldestLoadedTurnId: this.#turnKeys[0] ?? null,
          },
        },
      },
      ...content,
    ];
  }
  #admit(rows: readonly AgentRuntimeProjectedItem[], prepend: boolean): CodexTranscriptChange[] {
    const thread = this.#thread();
    if (!thread) return [];
    const changes: CodexTranscriptChange[] = [];
    const itemChanges: CodexTranscriptChange[] = [];
    const incomingByTurn = new Map<
      string,
      {
        ids: string[];
        opening?: Extract<AgentTurnItem, { type: "user_message" }>;
        subagent: boolean;
      }
    >();
    const newKeys: string[] = [];
    const first = this.#turnKeys[0];
    const firstItem = first ? this.#items.get(this.#turns.get(first)?.itemIds[0] ?? "") : undefined;
    let runlessKey =
      prepend && firstItem?.runId === null && firstItem.type !== "fork"
        ? firstItem.opening
          ? JSON.stringify([
              "agent-history",
              firstItem.sourceThreadId,
              "before",
              firstItem.sourceItemId,
            ])
          : first
        : undefined;
    let runlessSource = prepend ? firstItem?.sourceThreadId : undefined;
    const hookTurns = new Set<string>();
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (this.#items.has(row.sourceItemId)) continue;
      const item = row.item;
      if (item.type === "hook_run") {
        if (item.runId === null) continue;
        const entityKey = runKey(item.threadId, item.runId);
        const runs = this.#hookRuns.get(entityKey) ?? new Map<string, CodexCanonicalHookRun>();
        runs.set(item.id, projectAgentRuntimeHookRun(item));
        this.#hookRuns.set(entityKey, runs);
        hookTurns.add(entityKey);
        continue;
      }
      const value = projectAgentRuntimeItem(item, thread.worktreePath ?? "");
      if (!value) continue;
      if (item.type === "subagent") this.#residentTaskIds.add(item.subagentId);
      let entityKey: string;
      if (item.runId !== null) entityKey = runKey(item.threadId, item.runId);
      else if (item.type === "fork") entityKey = JSON.stringify(["agent-marker", item.id]);
      else {
        if (runlessSource !== row.sourceThreadId || !runlessKey)
          runlessKey = JSON.stringify(["agent-history", row.sourceThreadId, "tail", item.id]);
        runlessSource = row.sourceThreadId;
        entityKey = runlessKey;
      }
      const group = incomingByTurn.get(entityKey) ?? { ids: [], subagent: false };
      group.ids.unshift(item.id);
      if (isTurnOpening(item)) group.opening = item;
      group.subagent ||= item.type === "subagent" || item.type === "thread_created";
      incomingByTurn.set(entityKey, group);
      if (!this.#turns.has(entityKey) && !newKeys.includes(entityKey)) newKeys.unshift(entityKey);
      this.#rememberItem(
        {
          entityKey,
          sourceThreadId: row.sourceThreadId,
          sourceItemId: row.sourceItemId,
          runId: item.runId,
          ordinal: item.ordinal,
          type: item.type,
          opening: isTurnOpening(item),
          taskId: item.type === "subagent" ? item.subagentId : null,
          nodeId: item.nodeId,
          status: item.status,
          startedAt: item.startedAt,
        },
        item,
      );
      itemChanges.push({
        type: "item",
        key: { ...this.readOwner.key, entityKey, itemId: item.id },
        value,
      });
      if (isTurnOpening(item) && item.runId === null)
        runlessKey = JSON.stringify(["agent-history", row.sourceThreadId, "before", item.id]);
    }
    for (const [entityKey, incoming] of incomingByTurn) {
      const current = this.#turns.get(entityKey);
      const itemIds = prepend
        ? [...incoming.ids, ...(current?.itemIds ?? [])]
        : [...(current?.itemIds ?? []), ...incoming.ids];
      const runId = this.#items.get(itemIds[0]!)?.runId ?? null;
      const details = projectAgentRuntimeTurnDetails({
        thread,
        entityKey,
        run: this.#run(runId),
        openingItem: incoming.opening,
        previous: current?.details,
        hookRuns: this.#turnHookRuns(entityKey),
      });
      const turn = {
        details,
        itemIds,
        hasSubagentActivity: incoming.subagent || current?.hasSubagentActivity === true,
      };
      this.#turns.set(entityKey, turn);
      changes.push({
        type: "turn",
        key: { ...this.readOwner.key, entityKey },
        details,
        hasSubagentActivity: turn.hasSubagentActivity,
      });
      changes.push(
        current
          ? {
              type: prepend ? "item-slots-prepend" : "item-slots-append",
              key: { ...this.readOwner.key, entityKey },
              previousLength: current.itemIds.length,
              length: itemIds.length,
              entries: incoming.ids.map((itemId, index) => ({
                itemId,
                index: prepend ? index : index + current.itemIds.length,
              })),
            }
          : {
              type: "item-slots",
              key: { ...this.readOwner.key, entityKey },
              slots: {
                length: itemIds.length,
                entries: itemIds.map((itemId, index) => ({ index, itemId })),
              },
            },
      );
    }
    // A resident Turn's hooks change its metadata without adding a row.
    for (const entityKey of hookTurns) {
      const current = this.#turns.get(entityKey);
      if (!current || incomingByTurn.has(entityKey)) continue;
      const details = { ...current.details, hookRuns: this.#turnHookRuns(entityKey) };
      this.#turns.set(entityKey, { ...current, details });
      changes.push({
        type: "turn",
        key: { ...this.readOwner.key, entityKey },
        details,
        hasSubagentActivity: current.hasSubagentActivity,
      });
    }
    // New Turn metadata and slots must exist before its first addressed body update.
    changes.push(...itemChanges);
    this.#turnKeys = prepend ? [...newKeys, ...this.#turnKeys] : [...this.#turnKeys, ...newKeys];
    return changes;
  }
  #turnHookRuns(entityKey: string): readonly CodexCanonicalHookRun[] | undefined {
    const runs = this.#hookRuns.get(entityKey);
    return runs ? [...runs.values()] : undefined;
  }
  #prepend(page: AgentHistoryPage): void {
    this.#cursor = page.nextCursor;
    const changes = this.#admit(page.items, true);
    changes.push(
      { type: "structure", timeline: this.#timeline(), turnEntityKeys: this.#turnKeys },
      { type: "history", resumeState: "resumed", historyComplete: !page.hasMoreHistory },
    );
    this.readOwner.applyEvent({ type: "changes", changes });
    this.#publishView();
  }
  #captureRequest(item: AgentTurnItem, local: boolean): boolean {
    if (!local || (item.type !== "approval_request" && item.type !== "user_input_request"))
      return false;
    if (isAgentRuntimeAsyncQuestion(item)) {
      const pending = item.status === "pending" || item.status === "waiting";
      if (pending) this.#asyncQuestions.set(item.requestId, item);
      else this.#asyncQuestions.delete(item.requestId);
      return true;
    }
    const request = projectAgentRuntimeRequest(
      item,
      this.#state.conversation?.projectId ?? null,
      item.runId,
    );
    if (request) {
      this.#requests.set(item.requestId, request);
      if (item.nodeId && !this.#nodeRuns.has(item.nodeId))
        this.#nodeRuns.set(item.nodeId, { runId: item.runId, live: false });
    } else {
      this.#requests.delete(item.requestId);
      if (
        item.nodeId &&
        !this.#nodeRuns.get(item.nodeId)?.live &&
        !this.#state.conversation?.snapshot.projection.runtimeRequests.some(
          (pending) => pending.nodeId === item.nodeId && pending.status === "pending",
        )
      )
        this.#nodeRuns.delete(item.nodeId);
    }
    return true;
  }
  #rememberItem(source: ResidentItem, item: AgentTurnItem): void {
    const resident = {
      ...source,
      nodeId: item.nodeId,
      status: item.status,
      startedAt: item.startedAt,
    };
    this.#items.set(item.id, resident);
    if (item.runId === null) return;
    const key = runKey(item.threadId, item.runId);
    if (!itemIsLive(item)) {
      this.#liveItemsByRun.get(key)?.delete(item.id);
      return;
    }
    const live = this.#liveItemsByRun.get(key) ?? new Set<string>();
    live.add(item.id);
    this.#liveItemsByRun.set(key, live);
  }
  #captureNode(node: AgentSnapshot["projection"]["nodes"][number]): void {
    const projection = this.#state.conversation?.snapshot.projection;
    const live = workIsActive(node.status);
    if (
      !live &&
      !projection?.runtimeRequests.some(
        (request) => request.nodeId === node.id && request.status === "pending",
      ) &&
      !projection?.providerTurns.some(
        (turn) =>
          turn.nodeId === node.id && (turn.status === "pending" || turn.status === "running"),
      )
    ) {
      this.#nodeRuns.delete(node.id);
      return;
    }
    this.#nodeRuns.set(node.id, { runId: node.runId, live });
  }
  #captureCohort(run: AgentRuntimeRun): void {
    if (!run.delegatedCompletion) return;
    const { disposition, nextGeneration } = run.delegatedCompletion;
    this.#cohortHeads.set(run.id, { disposition, nextGeneration });
  }
  #retireExecution(
    event: Extract<AgentEvent["event"], { readonly type: "run.execution-retired" }>,
  ): void {
    const conversation = this.#state.conversation;
    if (!conversation) return;
    const projection = conversation.snapshot.projection;
    const { runId, attemptId, rootNodeId, providerThreadId, cohortParentRunId, deliveryRunId } =
      event.payload;
    const now = event.occurredAt;
    const target = projection.runs.find((run) => run.id === runId);
    const delivery = projection.runs.find((run) => run.id === deliveryRunId);
    const cancelDelivery = deliveryRunId !== null && (!delivery || delivery.status === "queued");
    const ownedNodes = new Set<string>(rootNodeId === null ? [] : [rootNodeId]);
    for (const [id, source] of this.#nodeRuns) {
      if (source.runId === runId) ownedNodes.add(id);
    }
    const entityKey = runKey(event.threadId, runId);
    const changes: CodexTranscriptChange[] = [];
    // Only active resident keys are visited. Cold bodies and completed siblings remain untouched.
    for (const itemId of this.#liveItemsByRun.get(entityKey) ?? []) {
      const source = this.#items.get(itemId);
      if (!source) continue;
      if (source.nodeId) ownedNodes.add(source.nodeId);
      const current = this.readOwner.readItem(entityKey, itemId);
      const value =
        current && workIsActive(source.status)
          ? retireItem(current, source.startedAt, now)
          : current;
      if (value !== current)
        changes.push({ type: "item", key: { ...this.readOwner.key, entityKey, itemId }, value });
      this.#items.set(itemId, {
        ...source,
        status: workIsActive(source.status) ? "interrupted" : source.status,
      });
    }
    this.#liveItemsByRun.delete(entityKey);
    for (const id of ownedNodes) this.#nodeRuns.delete(id);
    for (const [id, request] of this.#requests) {
      if (request.turnId === runId) this.#requests.delete(id);
    }
    const cohort = this.#cohortHeads.get(cohortParentRunId);
    const stopCohort =
      cohort !== undefined ||
      projection.subagents.some(
        (task) => task.runId === cohortParentRunId && task.origin === "app_owned",
      );
    const runs = projection.runs.map((run) => {
      const interrupt = run.id === runId && runIsActive(run.status);
      const cancel = run.id === deliveryRunId && run.status === "queued";
      const stop = run.id === cohortParentRunId && stopCohort;
      if (!interrupt && !cancel && !stop) return run;
      const stoppedCohort = stop
        ? {
            disposition:
              cohort?.disposition === "disposed" ? ("disposed" as const) : ("stopped" as const),
            nextGeneration: cohort?.nextGeneration ?? 1,
            delivery: null,
          }
        : undefined;
      if (stoppedCohort) this.#cohortHeads.set(run.id, stoppedCohort);
      return {
        ...run,
        ...(interrupt ? { status: "interrupted" as const, completedAt: now } : {}),
        ...(cancel ? { status: "cancelled" as const, queuePosition: null, completedAt: now } : {}),
        ...(stoppedCohort ? { delegatedCompletion: stoppedCohort } : {}),
      };
    });
    const subagents = projection.subagents.map((task) => {
      const interrupt =
        task.runId === runId && task.origin === "provider_native" && workIsActive(task.status);
      const dispose =
        task.runId === cohortParentRunId &&
        task.origin === "app_owned" &&
        task.completionDelivery?.state !== "acknowledged" &&
        task.completionDelivery?.state !== "delivered" &&
        task.completionDelivery?.state !== "disposed";
      if (!interrupt && !dispose) return task;
      return {
        ...task,
        ...(interrupt ? { status: "interrupted" as const, completedAt: now } : {}),
        ...(dispose
          ? { completionDelivery: { state: "disposed" as const, observedByRunId: null } }
          : {}),
        updatedAt: now,
      };
    });
    this.#state = {
      ...this.#state,
      conversation: {
        ...conversation,
        snapshot: {
          ...conversation.snapshot,
          projection: {
            ...projection,
            runs,
            subagents,
            providerTurns: projection.providerTurns.map((turn) =>
              ((attemptId !== null && turn.runAttemptId === attemptId) ||
                ownedNodes.has(turn.nodeId)) &&
              (turn.status === "pending" || turn.status === "running")
                ? { ...turn, status: "interrupted" as const, completedAt: now }
                : turn,
            ),
            providerThreads: projection.providerThreads.map((thread) =>
              thread.id === providerThreadId &&
              thread.status === "active" &&
              target !== undefined &&
              thread.lastRunOrdinal === target.ordinal
                ? { ...thread, status: "idle" as const, updatedAt: now }
                : thread,
            ),
            runtimeRequests: projection.runtimeRequests.map((request) => {
              if (request.status !== "pending" || !ownedNodes.has(request.nodeId)) return request;
              this.#requests.delete(request.id);
              return {
                ...request,
                status: "cancelled" as const,
                resolvedAt: now,
                responseCapability: {
                  type: "not_resumable" as const,
                  reason: "The run was interrupted.",
                },
              };
            }),
            updatedAt: now,
          },
        },
      },
    };
    for (const previous of [target, ...(cancelDelivery ? [delivery] : [])]) {
      if (!previous) continue;
      const retired = runs.find((run) => run.id === previous.id);
      if (
        !retired ||
        (retired.status === previous.status && retired.completedAt === previous.completedAt)
      )
        continue;
      const changedKey = runKey(event.threadId, retired.id);
      const turn = this.#turns.get(changedKey);
      if (!turn) continue;
      const details = projectAgentRuntimeTurnDetails({
        thread: projection.thread,
        entityKey: changedKey,
        run: retired,
        previous: turn.details,
      });
      this.#turns.set(changedKey, { ...turn, details });
      changes.push({
        type: "turn",
        key: { ...this.readOwner.key, entityKey: changedKey },
        details,
        hasSubagentActivity: turn.hasSubagentActivity,
      });
    }
    if (changes.length > 0) this.readOwner.applyEvent({ type: "changes", changes });
    if (cancelDelivery) {
      this.#queueGeneration += 1;
      this.#queueRequest = null;
      this.#queueDirty = false;
      this.#queueStatus = "ready";
      if (this.#queuePage)
        this.#queuePage = {
          ...this.#queuePage,
          entries: this.#queuePage.entries.filter((entry) => entry.runId !== deliveryRunId),
          nextRunId: this.#queuePage.nextRunId === deliveryRunId ? null : this.#queuePage.nextRunId,
        };
      this.#queueEntries = this.#queueEntries.filter((entry) => entry.followUpId !== deliveryRunId);
    }
    const changedTasks = new Set(
      subagents
        .filter((task, index) => task !== projection.subagents[index])
        .map((task) => task.id),
    );
    if (changedTasks.size > 0) this.#updateChildren(changedTasks);
    this.#publishView();
  }
  #accept(stored: AgentEvent): void {
    if (stored.sequence <= this.#sequence) return;
    this.#sequence = stored.sequence;
    const event = stored.event;
    if (event.type === "turn-item.updated") {
      const item = event.payload;
      if (this.#transcriptActive && this.#transcriptHydrated) {
        const resident = this.#items.get(item.id);
        const value = resident
          ? projectAgentRuntimeItem(item, this.#thread()?.worktreePath ?? "")
          : null;
        if (resident) {
          this.#rememberItem(resident, item);
          if (value)
            this.readOwner.applyEvent({
              type: "changes",
              changes: [
                {
                  type: "item",
                  key: { ...this.readOwner.key, entityKey: resident.entityKey, itemId: item.id },
                  value,
                },
              ],
            });
        } else {
          const changes = this.#admit(
            [
              {
                position: 0,
                sourceThreadId: item.threadId,
                sourceItemId: item.id,
                visibility: "local",
                item,
              },
            ],
            false,
          );
          if (changes.length > 0) {
            changes.push({
              type: "structure",
              timeline: this.#timeline(),
              turnEntityKeys: this.#turnKeys,
            });
            this.readOwner.applyEvent({ type: "changes", changes });
          }
        }
      }
      const arrived =
        isAgentRuntimeAsyncQuestion(item) && !this.#asyncQuestions.has(item.requestId);
      if (
        this.#captureRequest(item, true) ||
        (item.type === "user_message" && this.#run(item.runId)?.status === "queued")
      )
        this.#publishView();
      if (isAgentRuntimeAsyncQuestion(item)) {
        this.#reconcileAsyncQuestions();
        if (arrived && this.#asyncQuestions.has(item.requestId))
          this.asyncQuestions.receive(this.threadId, item.id);
      }
      if (
        item.type === "user_message" &&
        item.runId &&
        this.#queuePage?.entries.some((row) => row.runId === item.runId)
      ) {
        this.#queueEntries = this.#queueEntries.filter((entry) => entry.followUpId !== item.runId);
        void this.#refreshQueue();
      }
      return;
    }
    const conversation = this.#state.conversation;
    if (!conversation) return;
    if (event.type === "node.updated") {
      this.#captureNode(event.payload);
      return;
    }
    if (event.type === "run.execution-retired") {
      this.#retireExecution(event);
      return;
    }
    if (event.type === "message.updated") {
      if (this.#queuePage?.entries.some((row) => row.userMessageId === event.payload.id)) {
        this.#queueEntries = this.#queueEntries.filter(
          (entry) => entry.clientUserMessageId !== event.payload.id,
        );
        void this.#refreshQueue();
      }
      return;
    }
    if (event.type === "run.created" || event.type === "run.updated") {
      const wasQueued = conversation.snapshot.projection.runs.some(
        (run) => run.id === event.payload.id && run.status === "queued",
      );
      const previous = conversation.snapshot.projection.runs.find(
        (run) => run.id === event.payload.id,
      );
      const run = controlRun(event.payload, previous);
      this.#captureCohort(run.delegatedCompletion ? run : event.payload);
      const incomingRuns = conversation.snapshot.projection.runs.filter(
        (value) => value.id !== run.id,
      );
      incomingRuns.push(run);
      const recent = [...incomingRuns].sort((a, b) => b.ordinal - a.ordinal);
      const retained = new Set(recent.slice(0, 5).map((value) => value.id));
      const foreground = recent.find(
        (value) => value.status !== "queued" && controlStatusIsLive(value.status),
      );
      if (foreground) retained.add(foreground.id);
      const runs = incomingRuns.filter(
        (value) => retained.has(value.id) || this.#turns.has(runKey(value.threadId, value.id)),
      );
      for (const id of this.#cohortHeads.keys()) {
        if (!retained.has(id) && !this.#turns.has(runKey(run.threadId, id)))
          this.#cohortHeads.delete(id);
      }
      this.#state = {
        ...this.#state,
        conversation: {
          ...conversation,
          snapshot: {
            ...conversation.snapshot,
            projection: { ...conversation.snapshot.projection, runs },
          },
        },
      };
      if (wasQueued || run.status === "queued") void this.#refreshQueue();
      const entityKey = runKey(run.threadId, run.id);
      const turn = this.#turns.get(entityKey);
      if (turn && this.#transcriptActive && run.status === "rolled_back") {
        this.#liveItemsByRun.delete(entityKey);
        for (const itemId of turn.itemIds) this.#items.delete(itemId);
        this.#residentTaskIds.clear();
        for (const item of this.#items.values()) {
          if (item.taskId) this.#residentTaskIds.add(item.taskId);
        }
        this.#turns.delete(entityKey);
        this.#turnKeys = this.#turnKeys.filter((key) => key !== entityKey);
        this.readOwner.applyEvent({
          type: "changes",
          changes: [
            { type: "remove-turn", key: { ...this.readOwner.key, entityKey } },
            { type: "structure", timeline: this.#timeline(), turnEntityKeys: this.#turnKeys },
          ],
        });
        this.#publishView();
        return;
      }
      if (turn && this.#transcriptActive) {
        const details = projectAgentRuntimeTurnDetails({
          thread: this.#thread()!,
          entityKey,
          run,
          previous: turn.details,
        });
        this.#turns.set(entityKey, { ...turn, details });
        this.readOwner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "turn",
              key: { ...this.readOwner.key, entityKey },
              details,
              hasSubagentActivity: turn.hasSubagentActivity,
            },
          ],
        });
      }
      this.#publishView();
      return;
    }
    if (event.type === "runtime-request.updated") {
      const requests = conversation.snapshot.projection.runtimeRequests.filter(
        (value) => value.id !== event.payload.id,
      );
      if (event.payload.status === "pending") requests.push(event.payload);
      this.#state = {
        ...this.#state,
        conversation: {
          ...conversation,
          snapshot: {
            ...conversation.snapshot,
            projection: {
              ...conversation.snapshot.projection,
              runtimeRequests: requests.slice(-32),
            },
          },
        },
      };
      if (event.payload.status !== "pending") {
        this.#requests.delete(event.payload.id);
        if (this.#asyncQuestions.delete(event.payload.id)) this.#reconcileAsyncQuestions();
      }
      if (event.payload.status !== "pending" && !this.#nodeRuns.get(event.payload.nodeId)?.live)
        this.#nodeRuns.delete(event.payload.nodeId);
      this.#publishView();
      return;
    }
    if (event.type === "subagent.updated") {
      const task = {
        ...event.payload,
        prompt: "",
        result: null,
        progress: undefined,
        workflow: undefined,
      };
      const subagents = conversation.snapshot.projection.subagents.filter(
        (value) => value.id !== task.id,
      );
      subagents.push(task);
      const recent = recentMetadata(subagents);
      const retained = new Set([
        ...recent
          .filter((value) => controlStatusIsLive(value.status))
          .slice(0, 4)
          .map((value) => value.id),
        ...recent
          .filter((value) => !controlStatusIsLive(value.status))
          .slice(0, 10)
          .map((value) => value.id),
        ...this.#residentTaskIds,
      ]);
      this.#state = {
        ...this.#state,
        conversation: {
          ...conversation,
          snapshot: {
            ...conversation.snapshot,
            projection: {
              ...conversation.snapshot.projection,
              subagents: subagents.filter((value) => retained.has(value.id)),
            },
          },
        },
      };
      this.#updateChildren();
      this.#publishView();
      return;
    }
    if (event.type === "provider-thread.updated") {
      const projection = conversation.snapshot.projection;
      const referenced =
        event.payload.id === projection.thread.activeProviderThreadId ||
        projection.runs.some((run) => run.providerThreadId === event.payload.id);
      if (!referenced) return;
      const providerThreads = projection.providerThreads.filter(
        (value) => value.id !== event.payload.id,
      );
      providerThreads.push(event.payload);
      this.#state = {
        ...this.#state,
        conversation: {
          ...conversation,
          snapshot: { ...conversation.snapshot, projection: { ...projection, providerThreads } },
        },
      };
      this.#publishView();
      return;
    }
    if (event.type.startsWith("thread.") && "lineage" in event.payload) {
      this.#state = {
        ...this.#state,
        conversation: {
          ...conversation,
          snapshot: {
            ...conversation.snapshot,
            projection: { ...conversation.snapshot.projection, thread: event.payload },
          },
        },
      };
      this.#publishView();
    }
  }
  #updateChildren(changedTaskIds?: ReadonlySet<string>): void {
    const previous = new Map(this.#children.map((child) => [child.threadId, child]));
    this.#children = (this.#state.conversation?.snapshot.projection.subagents ?? []).map((task) => {
      const retained = previous.get(task.childThreadId ?? task.id);
      if (changedTaskIds && !changedTaskIds.has(task.id) && retained) return retained;
      return {
        threadId: task.childThreadId ?? task.id,
        parentThreadId: this.#target.threadId,
        role: "backgroundChild",
        displayName: task.title,
        actorName: task.title ?? "Agent",
        thread: { displayName: task.title, model: task.model },
        statusType:
          task.status === "failed"
            ? "systemError"
            : agentRuntimeItemStatus(task.status) === "inProgress"
              ? "active"
              : "idle",
        createdAtMs: agentRuntimeTime(task.startedAt),
        updatedAtMs: agentRuntimeTime(task.updatedAt),
        showInlineActivity: task.childThreadId !== null,
        ...(task.childThreadId === null
          ? {
              task: {
                id: task.id,
                bornTurnSequence: null,
                description: task.title ?? "Agent",
                status:
                  task.status === "waiting"
                    ? ("paused" as const)
                    : task.status === "interrupted"
                      ? ("cancelled" as const)
                      : task.status === "idle"
                        ? ("pending" as const)
                        : task.status,
                ...(task.model === null ? {} : { model: task.model }),
                backgrounded: true,
              },
            }
          : {}),
      };
    });
  }
  #queuedFollowUps(): CodexQueuedFollowUpProjection {
    if (!this.#transcriptActive) return EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION;
    return {
      ...EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION,
      status: this.#queueStatus,
      error: this.#queueError,
      ledgerRevision: this.#queuePage?.snapshotSequence ?? 0,
      projectionRevision: this.#queuePage?.snapshotSequence ?? 0,
      entries: this.#queueEntries,
      hasPreviousPage: this.#queuePrevious.length > 0,
      hasNextPage: this.#queuePage?.nextCursor != null,
    };
  }
  #reconcileAsyncQuestions(): void {
    const pending = [...this.#asyncQuestions.values()];
    this.asyncQuestions.reconcileScope(this.threadId, {
      generation: this.#generation,
      // Questions stay answerable until the Agent settles them, across its Runs.
      turnId: pending.length ? AGENT_RUNTIME_QUESTION_SCOPE : null,
      entityKey: AGENT_RUNTIME_QUESTION_SCOPE,
      questions: pending.flatMap((item) =>
        expandCodexAsyncQuestions(projectAgentRuntimeAsyncQuestionMessage(item)),
      ),
      answers: new Map(),
    });
  }
  /** The pending requests that receive these replies, with each answer keyed by its question. */
  asyncQuestionAnswers(replies: readonly CodexAsyncQuestionReply[]): Array<{
    readonly requestId: string;
    readonly runId: string | null;
    readonly answers: Readonly<Record<string, string>>;
  }> {
    const answers = new Map<string, Record<string, string>>();
    for (const item of this.#asyncQuestions.values()) {
      const questions = expandCodexAsyncQuestions(projectAgentRuntimeAsyncQuestionMessage(item));
      for (const reply of replies) {
        const index = questions.findIndex((question) => question.id === reply.questionItemId);
        const question = item.questions[index];
        if (!question) continue;
        answers.set(item.requestId, {
          ...answers.get(item.requestId),
          [question.id]: reply.answer,
        });
      }
    }
    return [...answers].map(([requestId, entries]) => ({
      requestId,
      runId: this.#asyncQuestions.get(requestId)?.runId ?? null,
      answers: entries,
    }));
  }
  #publishView(): void {
    const conversation = this.#state.conversation;
    if (!conversation) return;
    const thread = conversation.snapshot.projection.thread;
    const latestRun = conversation.snapshot.projection.runs.reduce<AgentRuntimeRun | undefined>(
      (latest, run) =>
        run.status !== "queued" && (!latest || latest.ordinal < run.ordinal) ? run : latest,
      undefined,
    );
    const requests = [...this.#requests.values()];
    const active =
      latestRun !== undefined && agentRuntimeTurnStatus(latestRun.status) === "inProgress";
    const view: CodexConversationSnapshot = {
      threadId: conversation.threadId,
      projectId: conversation.projectId,
      executionHostId: "local",
      source: null,
      forkedFromId: thread.forkedFrom?.type === "run" ? thread.forkedFrom.threadId : null,
      threadName: thread.title,
      threadPreview: "",
      modelProvider: thread.modelSelection.instanceId,
      cwd: thread.worktreePath,
      statusType: latestRun?.status === "failed" ? "systemError" : active ? "active" : "idle",
      statusActiveFlags: requests.length
        ? [
            requests.some((request) => request.type === "userInput")
              ? "waitingOnUserInput"
              : "waitingOnApproval",
          ]
        : [],
      archived: thread.archivedAt !== null,
      createdAt: agentRuntimeTime(thread.createdAt) ?? 0,
      updatedAt: agentRuntimeTime(thread.updatedAt) ?? 0,
      linkedAt: thread.createdAt,
      resumeState: "resumed",
      turns: [],
      canonicalRequests: [],
      requests,
      pendingSteers: [],
      backgroundTerminalRows: [],
      queuedFollowUps: this.#queuedFollowUps(),
      historyRows: this.readOwner.readStructure()?.timeline ?? undefined,
      historyTopologyGeneration: this.#historyGeneration,
      turnPagination: {
        source: "ordinary",
        olderCursor: this.#cursor,
        backwardsCursor: this.#cursor,
        oldestLoadedTurnId: this.#turnKeys[0] ?? null,
        isLoadingOlder: this.#state.historyLoading,
        hasLoadedOldest: this.#cursor === null,
        loadedTurnCount: this.#turnKeys.length,
        itemsView: "full",
      },
      capabilityFlags: {
        canEditLastUserTurn: this.#canEditLastUserTurn,
        canForkFromTurn: true,
        canSearch: false,
        canCollapseTurns: true,
      },
    };
    this.#patch({ view });
  }
}
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
/** Pending questions share one draft scope, so drafts survive while the Agent moves between Runs. */
const AGENT_RUNTIME_QUESTION_SCOPE = "agent-runtime:pending-questions";

// Active viewers share one delivery subscription. Unretained owners keep no
// engine bodies, and disappear when their last caller releases the lease.
const owners = new Map<
  string,
  { readonly owner: AgentRuntimeConversationOwner; references: number }
>();
export function acquireAgentRuntimeConversationOwner(target: ResolvedAgentRuntimeTarget): {
  readonly owner: AgentRuntimeConversationOwner;
  readonly retain: () => () => void;
} {
  const key = JSON.stringify([target.sessionId, target.threadId]);
  const entry = owners.get(key) ?? {
    owner: new AgentRuntimeConversationOwner(target),
    references: 0,
  };
  owners.set(key, entry);
  return {
    owner: entry.owner,
    retain: () => {
      if (!owners.has(key)) owners.set(key, entry);
      entry.references += 1;
      const release = entry.owner.retain();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
        entry.references -= 1;
        if (entry.references > 0 || owners.get(key) !== entry) return;
        owners.delete(key);
        // A render-held lease can be retained again after an effect cleanup.
        // Releasing its last subscription clears data without killing that lease.
      };
    },
  };
}
