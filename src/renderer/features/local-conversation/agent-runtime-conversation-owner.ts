import { resolveAssistantResponseStartedAtMs } from "../../../shared/codex-assistant-response-timing";
import { createAgentApprovalRuntime } from "./agent-approval-runtime";
import {
  agentApprovalSuppressesItem,
  projectAgentPendingApproval,
} from "./agent-runtime-transcript-projection";
import {
  isConversationRewindRun,
  resolveConversationRewindTargets,
} from "@nodex/agent-runtime/rewind";
import { providerThreadActivatesThread } from "@nodex/agent-runtime/context-usage";
import {
  agentRuntimeContextReport,
  projectAgentRuntimeContextUsage,
  retainAgentRuntimeContextMetadata,
} from "./agent-runtime-context-usage";
import { readRuntimeThreadTextSelections } from "../../../shared/thread-text-selection";
import {
  resolveAgentReplyPhases,
  type AgentReplyItemRole,
} from "../../../shared/agent-reply-phase";
import type {
  AgentEvent,
  AgentHistoryPage,
  AgentHistoryPosition,
  AgentSnapshot,
  AgentTurnItem,
} from "@nodex/agent-runtime/contracts";
import type {
  AgentRuntimeConversation,
  AgentRuntimeSessionTarget,
  AgentRuntimeQueuePage,
  AgentRuntimeRunMessage,
} from "../../../shared/agent-runtime-api";
import { AGENT_RUNTIME_CONTROL_EVENT_TYPES } from "../../../shared/agent-runtime-api";
import type {
  CodexConversationChildMembership,
  CodexConversationServerRequest,
  CodexConversationSnapshot,
  CodexCanonicalItem,
  CodexPromptInput,
} from "../../../shared/types";
import {
  buildAgentRuntimeAttachmentSource,
  parseAgentRuntimeAttachmentSource,
} from "../../../shared/agent-runtime-attachments";
import {
  agentRuntimeSubagentAgent,
  projectAgentRuntimeSubagentDisplay,
} from "../../../shared/agent-runtime-subagent-display";
import {
  CODEX_INTERRUPTED_STEER_REASON,
  EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION,
  type CodexQueuedFollowUpPause,
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
  type CodexHistoryBoundaryRef,
  type CodexHistoryRow,
} from "../../../shared/codex-conversation-state/codex-history-topology";
import {
  CODEX_ACTIVE_HISTORY_EVICTION_TRIGGER_ITEMS,
  planCodexHistoryWindow,
  type CodexHistoryWindowPlan,
} from "../../../shared/codex-conversation-state/codex-active-history-eviction";
import type { CodexHistoryViewportBoundary } from "../../../shared/codex-history-policy";
import { truncateCodexPromptRailPreview } from "../../../shared/codex-prompt-rail-history";
import { CodexTranscriptReadOwner } from "./normalized-transcript-read-owner";
import {
  agentRuntimeRuntime,
  type AgentRuntimeRendererTransport,
} from "../../lib/agent-runtime-runtime";
import {
  agentRuntimeItemStatus,
  agentRuntimeItemVersion as itemVersion,
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
import type { ConversationPromptTurn } from "./conversation-runtime";
import { createAsyncQuestionRuntime } from "./async-question-runtime";
import { questionDraftStore } from "./question-draft-store";
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
  | "promptIndex"
  | "item"
  | "subscribe"
  | "readQueuePage"
  | "readRunMessage"
  | "readQueuedPreview"
  | "attachment"
> &
  Partial<Pick<AgentRuntimeRendererTransport, "respond">>;
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
  readonly version?: string;
  readonly detailVersion?: string;
  readonly nativeItemRef?: AgentTurnItem["nativeItemRef"];
  readonly providerTurnId?: AgentTurnItem["providerTurnId"];
  readonly providerThreadId?: AgentTurnItem["providerThreadId"];
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
/** Older history a reader just asked for stays resident until they can reach it. */
const HISTORY_REVEAL_GRACE_MS = 2_000;
const emptyChildren: readonly CodexConversationChildMembership[] = [];

function replyItemRole(type: AgentTurnItem["type"] | undefined): AgentReplyItemRole {
  switch (type) {
    case "assistant_message":
      return "message";
    case "proposed_plan":
    case "todo_list":
    case "system_notice":
    case "error":
    case "notification":
    case "checkpoint":
    case "fork":
    case "run_interrupt_result":
    case "context_cleared":
    case "handoff":
      return "transparent";
    default:
      return "work";
  }
}

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
    case "mcpToolCall":
      return { ...item, status: "failed", durationMs };
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
  const projection = retainAgentRuntimeContextMetadata(value.snapshot.projection);
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
/**
 * Why an Agent chat's queue waits for an explicit resume, read from the Run that ended last:
 * Stop holds it, and so does a message the provider could not run.
 */
export function agentRuntimeQueueHoldPause(
  runs: readonly Pick<AgentRuntimeRun, "status" | "ordinal">[],
): CodexQueuedFollowUpPause {
  const latest = runs.reduce<Pick<AgentRuntimeRun, "status" | "ordinal"> | undefined>(
    (latest, run) =>
      run.status !== "queued" && (!latest || latest.ordinal < run.ordinal) ? run : latest,
    undefined,
  );
  if (latest?.status === "interrupted" || latest?.status === "cancelled")
    return { kind: "interrupted", reason: CODEX_INTERRUPTED_STEER_REASON };
  if (latest?.status === "failed")
    return { kind: "held", reason: "Queue paused because a message failed" };
  return { kind: "held", reason: "Queue paused" };
}

export class AgentRuntimeConversationOwner {
  readonly readOwner: CodexTranscriptReadOwner;
  readonly #transport: AgentRuntimeReadTransport;
  readonly #target: ResolvedAgentRuntimeTarget;
  readonly #listeners = new Set<() => void>();
  readonly #items = new Map<string, ResidentItem>();
  readonly #messageItems = new Map<string, string>();
  readonly #liveItemsByRun = new Map<string, Set<string>>();
  readonly #nodeRuns = new Map<string, { readonly runId: string | null; readonly live: boolean }>();
  readonly #cohortHeads = new Map<
    string,
    Pick<NonNullable<AgentRuntimeRun["delegatedCompletion"]>, "disposition" | "nextGeneration">
  >();
  readonly #residentTaskIds = new Set<string>();
  /** Opening message of each Run the prompt index listed, by Run. */
  readonly #promptMessageIds = new Map<string, string>();
  readonly #turns = new Map<string, ResidentTurn>();
  /** Each Turn's hooks by item, presented with its reply rather than as transcript rows. */
  readonly #hookRuns = new Map<string, Map<string, CodexCanonicalHookRun>>();
  readonly approvals: ReturnType<typeof createAgentApprovalRuntime>;
  readonly #approvalItems = new Map<string, Extract<AgentTurnItem, { type: "approval_request" }>>();
  readonly #approvalRequests = new Map<
    string,
    AgentSnapshot["projection"]["runtimeRequests"][number]
  >();
  readonly #requests = new Map<string, CodexConversationServerRequest>();
  /** Unanswered asynchronous questions by request, answerable until the Agent settles them. */
  readonly #asyncQuestions = new Map<string, AgentRuntimeQuestionRequest>();
  /** Drafts and panel state for this conversation's asynchronous questions. */
  readonly asyncQuestions: ReturnType<typeof createAsyncQuestionRuntime>;
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
  #sourceEpoch = 0;
  #historyGeneration = 0;
  #sequence = 0;
  readonly #observers = new Set<{ readonly sequence: number; readonly resolve: () => void }>();
  /** Identifies the position older pages continue from; a released anchor is keyed by its item. */
  #cursor: string | null = null;
  /** The item older pages continue before, once retention released what preceded it. */
  #cursorAnchor: Exclude<AgentHistoryPosition, string> | null = null;
  /** Set while resident items older than the cursor keep their Turns above the history gap. */
  #windowAnchorItemId: string | null = null;
  /** Whether the reader has asked for older history since retention last moved its boundary. */
  #olderHistoryRequested = false;
  #viewports: readonly (CodexHistoryViewportBoundary | null)[] = [];
  #historyWindowTimer: ReturnType<typeof setTimeout> | null = null;
  #historyHolds = 0;
  readonly #historyHoldTimers = new Set<ReturnType<typeof setTimeout>>();
  readonly #historyCursors = new Set<string>();
  #transcriptActive = false;
  #transcriptHydrated = false;
  #readMode: "control" | "transcript" | null = null;
  #releaseEvents: (() => void) | null = null;
  #opening: Promise<void> | null = null;
  #historyRequest: Promise<"applied" | "stale"> | null = null;
  #disposed = false;
  #supportsUserTurnEdits = false;
  #memberEdits: ReadonlyMap<string, MemberMessageEdit> | undefined;
  #supportsForks = true;
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
    this.approvals = createAgentApprovalRuntime(async (approval, response) => {
      const accepted = await (transport.respond ?? agentRuntimeRuntime.respond)({
        ...target,
        requestId: approval.requestId,
        runId: approval.runId,
        ...response,
      });
      await this.whenObserved(accepted.sequence);
    });
    this.asyncQuestions = createAsyncQuestionRuntime({
      drafts: questionDraftStore,
      namespace: JSON.stringify(["agent-runtime", target.sessionId, target.threadId]),
    });
    this.readOwner = new CodexTranscriptReadOwner({
      hostId: "local",
      threadId: target.threadId,
      connect: () => {
        this.#transcriptActive = true;
        const release = this.retain();
        this.#restart();
        return Object.assign(
          () => {
            this.#transcriptActive = false;
            this.#viewports = [];
            this.#clearTranscript();
            release();
            if (this.#leases > 0) this.#restart();
          },
          {
            setHistoryViewport: (
              boundaries: readonly (CodexHistoryViewportBoundary | null)[],
            ): void => {
              this.#viewports = boundaries;
              this.#scheduleHistoryWindow();
            },
          },
        );
      },
    });
  }
  get threadId(): string {
    return this.#target.threadId;
  }
  readonly getSnapshot = (): AgentRuntimeConversationOwnerSnapshot => this.#state;
  readonly contentSource = (): ConversationContentSource | null =>
    this.#contentSource?.isCurrent() ? this.#contentSource : null;
  /**
   * Whether the bound Provider can rewind its conversation to an earlier user message, and
   * whether this Device can fork it into a new chat.
   */
  readonly setCapabilities = (input: {
    readonly supportsUserTurnEdits: boolean;
    readonly supportsForks: boolean;
    /**
     * Which person messages the reader may edit, by their Run, when the chat belongs to more
     * than one Member; absent, every message the Provider can rewind to is the reader's own.
     */
    readonly memberEdits?: ReadonlyMap<string, MemberMessageEdit>;
  }): void => {
    if (
      this.#supportsUserTurnEdits === input.supportsUserTurnEdits &&
      this.#supportsForks === input.supportsForks &&
      this.#memberEdits === input.memberEdits
    )
      return;
    this.#supportsUserTurnEdits = input.supportsUserTurnEdits;
    this.#supportsForks = input.supportsForks;
    this.#memberEdits = input.memberEdits;
    this.#publishView();
  };
  /** The person messages the Provider can rewind to, before any Member's authorship applies. */
  readonly rewindTargetIds = (): readonly string[] => this.#editEligibility();
  readonly children = (): readonly CodexConversationChildMembership[] => this.#children;
  readonly queueBoundary = (): string | null => this.#queuePage?.nextRunId ?? null;
  /**
   * Resolves once the conversation has applied the event a write reported, so what the write
   * shows appears together with whatever the writer clears. A missing event waits no longer
   * than the bound.
   */
  readonly whenObserved = (sequence: number, boundMs = 500): Promise<void> => {
    if (this.#disposed || this.#sequence >= sequence) return Promise.resolve();
    return new Promise((resolve) => {
      const observer = {
        sequence,
        resolve: () => {
          clearTimeout(timer);
          this.#observers.delete(observer);
          resolve();
        },
      };
      const timer = setTimeout(observer.resolve, boundMs);
      this.#observers.add(observer);
    });
  };
  #settleObservers(): void {
    for (const observer of [...this.#observers])
      if (this.#disposed || observer.sequence <= this.#sequence) observer.resolve();
  }
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
    const message = await this.#transport.readRunMessage({ ...this.#target, runId });
    if (!message || message.id !== row.userMessageId || message.threadId !== this.#target.threadId)
      throw new Error("This queued message is no longer available");
    if (!row.userItemId && message.attachments.some((attachment) => attachment.type === "image"))
      throw new Error("This queued image is not available yet");
    const images = row.userItemId
      ? await this.#resolveMessageImages(message, message.threadId, row.userItemId)
      : [];
    if (!this.#queuePage?.entries.some((entry) => entry.runId === runId))
      throw new Error("This queued message is no longer available");
    return {
      text: message.text,
      images,
      ...readRuntimeThreadTextSelections(message.context),
    };
  };
  /** Resolves only the selected sent images; removed or unloaded originals do not block edits. */
  readonly readSentMessage = async (
    runId: string,
    attached: NonNullable<CodexPromptInput["images"]>,
  ): Promise<{
    readonly message: NonNullable<AgentRuntimeRunMessage>;
    readonly images: NonNullable<CodexPromptInput["images"]>;
  }> => {
    const message = await this.#transport.readRunMessage({ ...this.#target, runId });
    if (!message || message.threadId !== this.#target.threadId || message.role !== "user")
      throw new Error("This message is no longer available");
    const images: NonNullable<CodexPromptInput["images"]> = [];
    for (const image of attached) {
      const reference = parseAgentRuntimeAttachmentSource(image.source);
      if (!reference) {
        images.push(image);
        continue;
      }
      const source = await this.#transport.attachment({ ...this.#target, ...reference });
      if (!source) throw new Error("An image in this message is no longer available");
      const attachment = message.attachments.find((entry) => entry.id === reference.attachmentId);
      images.push({
        source: "dataUrl" in source ? source.dataUrl : source.path,
        caption: attachment?.name ?? image.caption,
      });
    }
    return { message, images };
  };
  async #resolveMessageImages(
    message: NonNullable<AgentRuntimeRunMessage>,
    sourceThreadId: string,
    itemId: string,
  ): Promise<NonNullable<CodexPromptInput["images"]>> {
    const images: NonNullable<CodexPromptInput["images"]> = [];
    for (const attachment of message.attachments) {
      if (attachment.type !== "image") continue;
      const source = await this.#transport.attachment({
        ...this.#target,
        sourceThreadId,
        itemId,
        attachmentId: attachment.id,
      });
      if (!source) throw new Error("An image in this message is no longer available");
      images.push({
        source: "dataUrl" in source ? source.dataUrl : source.path,
        caption: attachment.name,
      });
    }
    return images;
  }
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
      this.#approvalItems.clear();
      this.#approvalRequests.clear();
      this.approvals.clear();
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
  /** A viewport intent reads only its current source boundary; failures stay with that gap. */
  readonly loadHistoryBoundary = (
    boundary: CodexHistoryBoundaryRef,
  ): Promise<"applied" | "stale"> => this.#loadOlderPage(boundary);
  /**
   * The thread's own Runs, each with its opening prompt and latest reply, including Runs that
   * resident history has not loaded. Inherited and imported history has no Run to index.
   */
  readonly readPromptIndex = async (): Promise<readonly ConversationPromptTurn[] | null> => {
    const generation = this.#generation;
    const index = await this.#transport.promptIndex(this.#target);
    if (generation !== this.#generation || this.#disposed) return null;
    for (const prompt of index.prompts) this.#promptMessageIds.set(prompt.runId, prompt.messageId);
    return index.prompts.map((prompt) => ({
      turnId: prompt.runId,
      previews: [
        {
          itemId: prompt.messageId,
          promptPreview: truncateCodexPromptRailPreview(prompt.prompt),
          responsePreview: truncateCodexPromptRailPreview(prompt.response),
          isHeartbeat: prompt.scheduled,
        },
      ],
    }));
  };
  /** Loads older pages until one Run's opening message is resident. */
  readonly loadHistoryThroughRun = async (runId: string): Promise<"applied" | "stale"> => {
    const generation = this.#generation;
    const entityKey = runKey(this.threadId, runId);
    // Bounded snapshots omit older Run records; the prompt index names their opening messages.
    const throughEntryId = this.#promptMessageIds.get(runId) ?? this.#run(runId)?.userMessageId;
    if (!throughEntryId) return "stale";
    return this.#holdingHistory(async () => {
      while (this.#turnHead(entityKey)?.opening !== true) {
        const boundary = this.#historyBoundary();
        if (generation !== this.#generation || !boundary) return "stale";
        if ((await this.#loadOlderPage(boundary, throughEntryId)) === "stale") return "stale";
      }
      return "applied";
    });
  };
  /** Makes an exact user message resident, including steers within a Run and old Runs outside the index. */
  readonly loadHistoryThroughMessage = async (
    messageId: string,
    signal: AbortSignal,
  ): Promise<"applied" | "stale"> => {
    const generation = this.#generation;
    const isResident = () => {
      const itemId = this.#messageItems.get(messageId);
      return itemId !== undefined && this.#items.get(itemId)?.sourceThreadId === this.threadId;
    };
    return this.#holdingHistory(async () => {
      while (!isResident()) {
        const boundary = this.#historyBoundary();
        if (signal.aborted || this.#disposed || generation !== this.#generation || !boundary)
          return "stale";
        if ((await this.#loadOlderPage(boundary, messageId)) === "stale") return "stale";
      }
      return signal.aborted ? "stale" : "applied";
    });
  };
  /** Retention waits out a jump's pages, then the moment before its reader arrives. */
  async #holdingHistory<T>(load: () => Promise<T>): Promise<T> {
    this.#historyHolds += 1;
    try {
      return await load();
    } finally {
      this.#historyHolds -= 1;
      this.#holdForReader();
    }
  }
  #holdForReader(): void {
    this.#historyHolds += 1;
    const timer = setTimeout(() => {
      this.#historyHoldTimers.delete(timer);
      this.#historyHolds -= 1;
      this.#scheduleHistoryWindow();
    }, HISTORY_REVEAL_GRACE_MS);
    this.#historyHoldTimers.add(timer);
  }
  #loadOlderPage(
    boundary: CodexHistoryBoundaryRef,
    throughEntryId?: string,
  ): Promise<"applied" | "stale"> {
    if (!this.#isCurrentHistoryBoundary(boundary)) return Promise.resolve("stale");
    if (this.#historyRequest) return this.#historyRequest;
    this.#olderHistoryRequested = true;
    const generation = this.#generation;
    const cursor = boundary.handle.cursor;
    const position = this.#cursorAnchor ?? cursor;
    const isCurrent = () =>
      generation === this.#generation && this.#isCurrentHistoryBoundary(boundary);
    const pending = Promise.resolve()
      .then(() =>
        isCurrent()
          ? this.#transport.history({
              ...this.#target,
              cursor: position,
              ...(throughEntryId === undefined ? {} : { throughEntryId }),
            })
          : null,
      )
      .then((page) => {
        if (!page || !isCurrent()) return "stale" as const;
        if (page.nextCursor === cursor) throw new Error("History cursor did not advance");
        if (page.hasMoreHistory !== (page.nextCursor !== null) || page.nextCursor?.trim() === "")
          throw new Error("History continuation is invalid");
        if (page.nextCursor !== null && this.#historyCursors.has(page.nextCursor))
          throw new Error("History cursor repeated an earlier page");
        this.#prepend(page);
        if (page.nextCursor !== null) this.#historyCursors.add(page.nextCursor);
        return "applied" as const;
      })
      .catch((cause: unknown) => {
        if (!isCurrent()) return "stale" as const;
        throw cause;
      })
      .finally(() => {
        if (this.#historyRequest !== pending) return;
        this.#historyRequest = null;
        if (generation !== this.#generation) return;
        this.#patch({ historyLoading: false });
        this.#publishView();
        this.#holdForReader();
      });
    this.#historyRequest = pending;
    this.#patch({ historyLoading: true });
    this.#publishView();
    return pending;
  }
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
    const current = this.#items.get(itemId);
    if (
      generation !== this.#generation ||
      !this.#transcriptActive ||
      !item ||
      !current ||
      current.version !== source.version
    )
      return item;
    this.#rememberItem(current, item);
    const value = projectAgentRuntimeItem(item, this.#thread()?.worktreePath ?? "", {
      sessionId: this.#target.sessionId,
      rootThreadId: this.#thread()?.lineage.rootThreadId ?? this.#target.threadId ?? "",
      parentThreadId: this.#thread()?.lineage.parentThreadId,
    });
    if (value) {
      this.#items.set(itemId, {
        ...this.#items.get(itemId)!,
        detailVersion: itemVersion(item),
      });
      this.#applyChanges([
        {
          type: "item",
          key: { ...this.readOwner.key, entityKey: source.entityKey, itemId },
          value,
        },
      ]);
    }
    return item;
  };
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#releaseEvents?.();
    this.#releaseEvents = null;
    for (const timer of this.#historyHoldTimers) clearTimeout(timer);
    this.#historyHoldTimers.clear();
    this.#clearTranscript();
    this.#nodeRuns.clear();
    this.#cohortHeads.clear();
    this.readOwner.dispose();
    this.#listeners.clear();
    this.#settleObservers();
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
  #restart(background = false): void {
    if (this.#disposed || this.#leases === 0 || this.#opening) return;
    let generation = background ? this.#generation : ++this.#generation;
    // A background read of the same chat keeps its content's identity, so the pictures and other
    // media it shows are not read again each time its host's snapshot is refreshed.
    const sourceEpoch = background ? this.#sourceEpoch : ++this.#sourceEpoch;
    const transcript = this.#transcriptActive;
    this.#readMode = transcript ? "transcript" : "control";
    this.#historyRequest = null;
    if (!background) {
      this.#releaseEvents?.();
      this.#releaseEvents = null;
      this.#patch({ connection: "connecting", error: null, historyLoading: false });
    }
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
        if (background) {
          generation = ++this.#generation;
          this.#releaseEvents?.();
          this.#releaseEvents = null;
        }
        this.#contentSource = {
          identity: JSON.stringify([this.#target.sessionId, this.#target.threadId, sourceEpoch]),
          isCurrent: () =>
            generation === this.#generation &&
            !this.#disposed &&
            this.#leases > 0 &&
            this.#transcriptActive &&
            this.#state.connection === "ready" &&
            this.readOwner.readStructure() !== null,
        };
        this.#sequence = conversation.snapshot.snapshotSequence;
        this.#settleObservers();
        if (transcript) {
          const cursor = conversation.snapshot.historyCursor ?? null;
          const hasMoreHistory = conversation.snapshot.hasMoreHistory ?? false;
          if (hasMoreHistory !== (cursor !== null) || cursor?.trim() === "")
            throw new Error("History continuation is invalid");
          this.#cursor = cursor;
          this.#cursorAnchor = null;
          this.#historyGeneration += 1;
        }
        this.#requests.clear();
        this.#approvalItems.clear();
        this.#approvalRequests.clear();
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
            if (notification.type === "reset-required" && notification.reason === "host-refresh") {
              this.#restart(true);
              return;
            }
            if (notification.type === "reset-required") {
              this.#releaseEvents?.();
              this.#releaseEvents = null;
              this.#opening = null;
              this.#restart();
              return;
            }
            this.#accept(notification.event);
            this.#settleObservers();
          },
        );
        if (generation !== this.#generation || this.#disposed) {
          release();
          return;
        }
        this.#releaseEvents = release;
      })
      .catch((cause: unknown) => {
        if (generation === this.#generation && !background)
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

  /** Publish each touched Turn's phases atomically with its bodies, slots and lifecycle. */
  #applyChanges(
    changes: readonly CodexTranscriptChange[],
    reset?: Omit<CodexTranscriptSnapshot, "itemsByKey">,
  ): void {
    const corrected = [...changes];
    const turnsByKey = reset ? { ...reset.turnsByKey } : undefined;
    const touched = new Set<string>();
    const itemChanges = new Map<string, number>();
    changes.forEach((change, index) => {
      if (!("key" in change)) return;
      touched.add(change.key.entityKey);
      if (change.type === "item")
        itemChanges.set(codexTranscriptItemAddress(change.key.entityKey, change.key.itemId), index);
    });
    for (const entityKey of touched) {
      const turn = this.#turns.get(entityKey);
      if (!turn) continue;
      const phases = resolveAgentReplyPhases(
        turn.itemIds.map((itemId) => replyItemRole(this.#items.get(itemId)?.type)),
        turn.details.status === "inProgress",
      );
      turn.itemIds.forEach((itemId, index) => {
        // Async questions use message presentation, but remain work rather than a reply.
        const phase =
          phases[index] ??
          (this.#items.get(itemId)?.type === "user_input_request" ? "commentary" : null);
        if (phase == null) return;
        const address = codexTranscriptItemAddress(entityKey, itemId);
        const changeIndex = itemChanges.get(address);
        const change = changeIndex === undefined ? undefined : corrected[changeIndex];
        const current =
          change?.type === "item" ? change.value : this.readOwner.readItem(entityKey, itemId);
        if (current?.type !== "agentMessage" || current.phase === phase) return;
        const replacement: CodexTranscriptChange = {
          type: "item",
          key: { ...this.readOwner.key, entityKey, itemId },
          value: { ...current, phase },
        };
        if (changeIndex === undefined) corrected.push(replacement);
        else corrected[changeIndex] = replacement;
      });
      const finalAssistantStartedAtMs = resolveAssistantResponseStartedAtMs({
        items: turn.itemIds.map((id) => {
          const source = this.#items.get(id);
          return {
            id,
            type: source?.type === "assistant_message" ? "agentMessage" : (source?.type ?? ""),
            startedAtMs: agentRuntimeTime(source?.startedAt),
          };
        }),
      });
      if (turn.details.finalAssistantStartedAtMs === finalAssistantStartedAtMs) continue;
      const details = { ...turn.details, finalAssistantStartedAtMs };
      this.#turns.set(entityKey, { ...turn, details });
      const turnChange: CodexTranscriptChange = {
        type: "turn",
        key: { ...this.readOwner.key, entityKey },
        details,
        hasSubagentActivity: turn.hasSubagentActivity,
      };
      const index = corrected.findIndex(
        (change) => change.type === "turn" && change.key.entityKey === entityKey,
      );
      if (index < 0) corrected.push(turnChange);
      else corrected[index] = turnChange;
      if (turnsByKey?.[entityKey]) turnsByKey[entityKey] = { ...turnsByKey[entityKey], details };
    }
    if (!reset || !turnsByKey) {
      this.readOwner.applyEvent({ type: "changes", changes: corrected });
      return;
    }
    const itemsByKey: Record<string, CodexCanonicalItem> = {};
    for (const change of corrected) {
      if (change.type === "item" && change.value)
        itemsByKey[codexTranscriptItemAddress(change.key.entityKey, change.key.itemId)] =
          change.value;
    }
    this.readOwner.applyEvent({ type: "reset", value: { ...reset, turnsByKey, itemsByKey } });
  }

  #reset(snapshot: AgentSnapshot): void {
    const details = new Map<
      string,
      { readonly source: ResidentItem; readonly value: CodexCanonicalItem }
    >();
    for (const [id, source] of this.#items) {
      if (source.detailVersion === undefined) continue;
      const value = this.readOwner.readItem(source.entityKey, id);
      if (value) details.set(id, { source, value });
    }
    this.#clearTranscript();
    if (this.#cursor !== null) this.#historyCursors.add(this.#cursor);
    const changes = this.#admit(snapshot.projection.visibleTurnItems, true);
    changes.forEach((change, index) => {
      if (change.type !== "item") return;
      const retained = details.get(change.key.itemId);
      const current = this.#items.get(change.key.itemId);
      if (
        !retained ||
        !current ||
        retained.source.detailVersion !== current.version ||
        retained.source.sourceThreadId !== current.sourceThreadId ||
        retained.source.sourceItemId !== current.sourceItemId
      )
        return;
      this.#items.set(change.key.itemId, { ...current, detailVersion: current.version });
      changes[index] = { ...change, value: retained.value };
    });
    const turnsByKey: Record<string, CodexTranscriptSnapshot["turnsByKey"][string]> = {};
    for (const [entityKey, turn] of this.#turns)
      turnsByKey[entityKey] = {
        details: turn.details,
        hasSubagentActivity: turn.hasSubagentActivity,
        itemSlots: {
          length: turn.itemIds.length,
          entries: turn.itemIds.map((itemId, index) => ({ index, itemId })),
        },
      };
    this.#applyChanges(changes, {
      resumeState: "resumed",
      historyComplete: !snapshot.hasMoreHistory,
      timeline: this.#timeline(),
      itemTimeline: null,
      turnEntityKeys: this.#turnKeys,
      turnsByKey,
      realtimeItems: {},
    });
    this.#transcriptHydrated = true;
    this.#scheduleHistoryWindow();
  }
  #clearTranscript(): void {
    this.#transcriptHydrated = false;
    if (this.#historyWindowTimer !== null) clearTimeout(this.#historyWindowTimer);
    this.#historyWindowTimer = null;
    this.#windowAnchorItemId = null;
    this.#olderHistoryRequested = false;
    this.#historyCursors.clear();
    this.#items.clear();
    this.#messageItems.clear();
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
  #refreshQueue(background = false): Promise<void> {
    if (!this.#transcriptActive || this.#disposed) return Promise.resolve();
    if (this.#queueRequest) {
      this.#queueDirty = true;
      return this.#queueRequest;
    }
    this.#queueDirty = false;
    const silent = background && this.#queuePage !== null;
    if (!silent) {
      this.#queueStatus = "loading";
      this.#queueError = null;
      this.#publishView();
    }
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
            // The reason follows the latest Run when the view is published.
            pause: row.held ? { kind: "held", reason: "" } : null,
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
        // An invalidation with no user messages must not open an empty queue tray.
        if (silent && this.#queueEntries.length === 0) return;
        this.#queueEntries = [];
        this.#queueStatus = "error";
        this.#queueError = messageOf(error);
        this.#publishView();
      })
      .finally(() => {
        if (this.#queueRequest !== request) return;
        this.#queueRequest = null;
        if (this.#queueDirty) void this.#refreshQueue(true);
      });
    this.#queueRequest = request;
    return request;
  }
  #historyBoundary(): CodexHistoryBoundaryRef | null {
    if (!this.#cursor) return null;
    return {
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
    };
  }
  #isCurrentHistoryBoundary(boundary: CodexHistoryBoundaryRef): boolean {
    if (
      this.#disposed ||
      !this.#transcriptActive ||
      !this.#transcriptHydrated ||
      this.#state.connection !== "ready"
    )
      return false;
    const current = this.#historyBoundary();
    return (
      current !== null &&
      boundary.generation === current.generation &&
      boundary.islandId === current.islandId &&
      boundary.edge === current.edge &&
      boundary.boundaryId === current.boundaryId &&
      boundary.progressKey === current.progressKey &&
      boundary.handle.source === current.handle.source &&
      boundary.handle.cursor === current.handle.cursor &&
      boundary.handle.oldestLoadedTurnId === current.handle.oldestLoadedTurnId
    );
  }
  #timeline(): readonly CodexHistoryRow[] {
    const content: CodexHistoryRow[] = this.#turnKeys.map((entityKey) => ({
      kind: "content",
      key: entityKey,
      turnKey: entityKey,
      entityKey,
    }));
    const boundary = this.#historyBoundary();
    if (!boundary) return content;
    const anchorKey = this.#items.get(this.#windowAnchorItemId ?? "")?.entityKey;
    const gapIndex = anchorKey === undefined ? 0 : Math.max(0, this.#turnKeys.indexOf(anchorKey));
    const below = this.#turnHead(this.#turnKeys[gapIndex] ?? "");
    return [
      ...content.slice(0, gapIndex),
      {
        kind: "gap",
        key: `agent-history:${this.#historyGeneration}`,
        estimatedHeightPx: CODEX_HISTORY_GAP_ESTIMATED_HEIGHT_PX,
        olderBoundary: null,
        newerBoundary: boundary,
        insideTurn:
          !this.#olderHistoryRequested &&
          below !== undefined &&
          below.runId !== null &&
          !below.opening,
      },
      ...content.slice(gapIndex),
    ];
  }
  /** Whether an item lies in history that older pages have yet to bring back. */
  #precedesResidentHistory(item: AgentTurnItem): boolean {
    if (this.#cursor === null) return false;
    const oldest = this.#items.get(
      this.#windowAnchorItemId ?? this.#turns.get(this.#turnKeys[0] ?? "")?.itemIds[0] ?? "",
    );
    return oldest?.sourceThreadId === item.threadId && item.ordinal < oldest.ordinal;
  }
  #isItemLive(itemId: string): boolean {
    const item = this.#items.get(itemId);
    return (
      item === undefined ||
      workIsActive(item.status) ||
      this.#liveItemsByRun.get(item.entityKey)?.has(itemId) === true
    );
  }
  #scheduleHistoryWindow(): void {
    if (
      this.#historyWindowTimer !== null ||
      !this.#transcriptHydrated ||
      this.#items.size <= CODEX_ACTIVE_HISTORY_EVICTION_TRIGGER_ITEMS
    )
      return;
    this.#historyWindowTimer = setTimeout(() => {
      this.#historyWindowTimer = null;
      this.#releaseOlderHistory();
    }, 0);
  }
  /** History stays readable from the Runtime, so only what a reader is near needs to stay here. */
  #releaseOlderHistory(): void {
    if (
      this.#disposed ||
      !this.#transcriptActive ||
      !this.#transcriptHydrated ||
      this.#state.connection !== "ready" ||
      this.#historyRequest !== null ||
      this.#historyHolds > 0 ||
      this.#viewports.includes(null)
    )
      return;
    const entries = this.#turnKeys.flatMap((entityKey) => {
      const turn = this.#turns.get(entityKey);
      return turn
        ? [
            {
              entityKey,
              turn: {
                turnId: turn.details.turnId ?? entityKey,
                status: turn.details.status,
                items: turn.itemIds.map((id) => ({ id })),
              },
            },
          ]
        : [];
    });
    const plan = planCodexHistoryWindow({
      entries,
      size: entries.reduce((total, { turn }) => total + Math.max(1, turn.items.length), 0),
      boundaries: this.#viewports,
      isTurnResidentElsewhere: () => false,
      isItemReleasable: (turn, index) => !this.#isItemLive(turn.items[index]!.id),
    });
    if (plan) this.#applyHistoryWindow(entries, plan);
  }
  #applyHistoryWindow(
    entries: readonly {
      readonly entityKey: string;
      readonly turn: { readonly items: readonly { readonly id: string }[] };
    }[],
    plan: CodexHistoryWindowPlan,
  ): void {
    const lastCut = plan.itemCuts.at(-1);
    const lastCutEntry = lastCut
      ? entries.findIndex(({ entityKey }) => entityKey === lastCut.entityKey)
      : -1;
    const anchorEntry = Math.max(lastCutEntry, plan.turns?.to ?? 0);
    const anchorItemId =
      entries[anchorEntry]!.turn.items[anchorEntry === lastCutEntry ? lastCut!.end : 0]!.id;
    const anchor = this.#items.get(anchorItemId)!;
    const changes: CodexTranscriptChange[] = [];
    const released = new Set<string>();
    for (const { entityKey, turn } of entries.slice(plan.turns?.from ?? 0, plan.turns?.to ?? 0)) {
      for (const { id } of turn.items) released.add(id);
      this.#turns.delete(entityKey);
      this.#hookRuns.delete(entityKey);
      this.#liveItemsByRun.delete(entityKey);
      changes.push({ type: "remove-turn", key: { ...this.readOwner.key, entityKey } });
    }
    for (const { entityKey, end, retained } of plan.itemCuts) {
      const turn = this.#turns.get(entityKey)!;
      const key = { ...this.readOwner.key, entityKey };
      const itemIds = turn.itemIds.filter((itemId, index) => {
        if (index >= end || retained.has(index)) return true;
        released.add(itemId);
        changes.push({ type: "item", key: { ...key, itemId }, value: null });
        return false;
      });
      this.#turns.set(entityKey, { ...turn, itemIds });
      changes.push({
        type: "item-slots",
        key,
        slots: {
          length: itemIds.length,
          entries: itemIds.map((itemId, index) => ({ index, itemId })),
        },
      });
    }
    for (const id of released) this.#items.delete(id);
    for (const [messageId, itemId] of this.#messageItems)
      if (released.has(itemId)) this.#messageItems.delete(messageId);
    for (const [requestId, item] of this.#approvalItems)
      if (released.has(item.id)) this.#approvalItems.delete(requestId);
    this.#residentTaskIds.clear();
    for (const item of this.#items.values())
      if (item.taskId) this.#residentTaskIds.add(item.taskId);
    this.#turnKeys = this.#turnKeys.filter((entityKey) => this.#turns.has(entityKey));
    this.#cursorAnchor = {
      type: "item",
      sourceThreadId: anchor.sourceThreadId,
      sourceItemId: anchor.sourceItemId,
      ...(anchor.type === "fork" ? {} : { ordinal: anchor.ordinal }),
    };
    this.#cursor = JSON.stringify(this.#cursorAnchor);
    this.#historyCursors.clear();
    this.#olderHistoryRequested = false;
    this.#settleWindowAnchor(anchorItemId);
    changes.push(
      { type: "structure", timeline: this.#timeline(), turnEntityKeys: this.#turnKeys },
      { type: "history", resumeState: "resumed", historyComplete: false },
    );
    this.#applyChanges(changes);
    this.#publishView();
  }
  /** The default position, the first resident item, needs no anchor of its own. */
  #settleWindowAnchor(itemId: string | null): void {
    const first = this.#turns.get(this.#turnKeys[0] ?? "")?.itemIds[0];
    this.#windowAnchorItemId = itemId === first || this.#cursor === null ? null : itemId;
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
    // Older rows land just before the resident run they continue, after any Turn held above it.
    const windowAnchor = prepend ? this.#items.get(this.#windowAnchorItemId ?? "") : undefined;
    const first = windowAnchor?.entityKey ?? this.#turnKeys[0];
    const firstItem =
      windowAnchor ??
      (first ? this.#items.get(this.#turns.get(first)?.itemIds[0] ?? "") : undefined);
    const prependedOrder = prepend ? [...this.#turnKeys] : null;
    let insertAt = first === undefined ? 0 : Math.max(0, this.#turnKeys.indexOf(first));
    const passTurn = (entityKey: string | undefined) => {
      if (!prependedOrder || entityKey === undefined) return;
      const at = prependedOrder.indexOf(entityKey);
      if (at >= 0 && at < insertAt) insertAt = at;
    };
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
      if (this.#items.has(row.sourceItemId)) {
        passTurn(this.#items.get(row.sourceItemId)!.entityKey);
        continue;
      }
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
      const value = projectAgentRuntimeItem(item, thread.worktreePath ?? "", {
        sessionId: this.#target.sessionId,
        rootThreadId: thread.lineage.rootThreadId,
        parentThreadId: thread.lineage.parentThreadId,
      });
      if (!value) continue;
      if (item.type === "subagent") this.#residentTaskIds.add(item.subagentId);
      let entityKey: string;
      if (item.runId !== null) entityKey = runKey(item.threadId, item.runId);
      else if (item.type === "fork") entityKey = JSON.stringify(["agent-marker", item.id]);
      else {
        // Live history continues the history Turn it follows, as a reopened snapshot groups it.
        if (!prepend && !isTurnOpening(item)) {
          runlessKey = this.#historyTurnBefore(row.sourceThreadId, item.ordinal);
          runlessSource = row.sourceThreadId;
        }
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
      passTurn(entityKey);
      if (!this.#turns.has(entityKey) && !newKeys.includes(entityKey)) {
        newKeys.unshift(entityKey);
        prependedOrder?.splice(insertAt, 0, entityKey);
      }
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
    const ordinalOf = (itemId: string) => this.#items.get(itemId)?.ordinal ?? 0;
    for (const [entityKey, incoming] of incomingByTurn) {
      const current = this.#turns.get(entityKey);
      // Items retention kept in place can fall between older rows returning around them.
      const interleaved =
        prepend &&
        current !== undefined &&
        current.itemIds.length > 0 &&
        ordinalOf(incoming.ids.at(-1)!) > ordinalOf(current.itemIds[0]!);
      const itemIds = interleaved
        ? [...incoming.ids, ...current.itemIds].toSorted((a, b) => ordinalOf(a) - ordinalOf(b))
        : prepend
          ? [...incoming.ids, ...(current?.itemIds ?? [])]
          : [...(current?.itemIds ?? []), ...incoming.ids];
      const head = this.#items.get(itemIds[0]!);
      const runId = head?.runId ?? null;
      const details = projectAgentRuntimeTurnDetails({
        thread,
        entityKey,
        run: this.#run(runId),
        // A bounded snapshot omits Run records for older pages; their Turns keep the Run's identity.
        runId: head?.sourceThreadId === this.threadId ? runId : null,
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
        current && !interleaved
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
    this.#turnKeys = prependedOrder ?? this.#placeLive(newKeys);
    return changes;
  }
  #turnHead(entityKey: string): ResidentItem | undefined {
    return this.#items.get(this.#turns.get(entityKey)?.itemIds[0] ?? "");
  }
  #isHistoryTurn(head: ResidentItem | undefined): head is ResidentItem {
    return head?.runId === null && head.type !== "fork";
  }
  /** The resident history Turn that immediately precedes an ordinal, if the ordinal follows all of it. */
  #historyTurnBefore(sourceThreadId: string, ordinal: number): string | undefined {
    let found: { key: string; head: ResidentItem } | undefined;
    for (const key of this.#turnKeys) {
      const head = this.#turnHead(key);
      if (!this.#isHistoryTurn(head) || head.sourceThreadId !== sourceThreadId) continue;
      if (head.ordinal < ordinal && (!found || head.ordinal > found.head.ordinal))
        found = { key, head };
    }
    const last = found && this.#items.get(this.#turns.get(found.key)?.itemIds.at(-1) ?? "");
    return last && last.ordinal < ordinal ? found!.key : undefined;
  }
  /**
   * Run-less history occupies the start of a thread's ordinal space. History restored after a Run
   * started (an imported conversation's first Continue) still precedes that Run, as on reopening.
   */
  #placeLive(keys: readonly string[]): string[] {
    const order = [...this.#turnKeys];
    for (const key of keys) {
      const head = this.#turnHead(key);
      const before = this.#isHistoryTurn(head)
        ? order.findIndex((existing) => {
            const other = this.#turnHead(existing);
            return other?.sourceThreadId === head.sourceThreadId && other.ordinal > head.ordinal;
          })
        : -1;
      order.splice(before === -1 ? order.length : before, 0, key);
    }
    return order;
  }
  #turnHookRuns(entityKey: string): readonly CodexCanonicalHookRun[] | undefined {
    const runs = this.#hookRuns.get(entityKey);
    return runs ? [...runs.values()] : undefined;
  }
  #mergeRewindContext(incoming: AgentSnapshot["projection"]["rewindContext"]): void {
    const conversation = this.#state.conversation;
    if (!conversation || !incoming) return;
    const projection = conversation.snapshot.projection;
    const previous = projection.rewindContext;
    const merge = <T extends { readonly id: string }>(
      old: readonly T[],
      next: readonly T[],
    ): T[] => [...new Map([...old, ...next].map((value) => [value.id, value])).values()];
    this.#state = {
      ...this.#state,
      conversation: {
        ...conversation,
        snapshot: {
          ...conversation.snapshot,
          projection: {
            ...projection,
            rewindContext: {
              runs: merge(previous?.runs ?? [], incoming.runs),
              checkpoints: merge(previous?.checkpoints ?? [], incoming.checkpoints),
              checkpointScopes: merge(previous?.checkpointScopes ?? [], incoming.checkpointScopes),
            },
          },
        },
      },
    };
  }
  #updateRewindContext(event: AgentEvent["event"]): void {
    if (!this.#transcriptActive) return;
    const projection = this.#state.conversation?.snapshot.projection;
    if (!projection) return;
    const context = projection.rewindContext ?? { runs: [], checkpoints: [], checkpointScopes: [] };
    if (event.type === "run.created" || event.type === "run.updated") {
      const run = event.payload;
      const existing = context.runs.find((candidate) => candidate.id === run.id);
      const previous = context.runs
        .filter(
          (candidate) => candidate.ordinal < run.ordinal && isConversationRewindRun(candidate),
        )
        .toSorted((a, b) => b.ordinal - a.ordinal)[0];
      this.#mergeRewindContext({
        ...context,
        runs: [
          {
            id: run.id,
            ordinal: run.ordinal,
            status: run.status,
            started: run.startedAt !== null,
            activeAttemptId: run.activeAttemptId,
            hasProviderTurn:
              (existing?.activeAttemptId === run.activeAttemptId && existing.hasProviderTurn) ||
              projection.providerTurns.some(
                (turn) => run.activeAttemptId !== null && turn.runAttemptId === run.activeAttemptId,
              ),
            previousRunId:
              existing?.previousRunId !== undefined && existing.status !== "queued"
                ? existing.previousRunId
                : (previous?.id ?? null),
          },
        ],
      });
      return;
    }
    if (event.type === "provider-turn.updated") {
      const metadata = context.runs.find(
        (candidate) =>
          event.payload.runAttemptId !== null &&
          candidate.activeAttemptId === event.payload.runAttemptId,
      );
      if (metadata && !metadata.hasProviderTurn)
        this.#mergeRewindContext({ ...context, runs: [{ ...metadata, hasProviderTurn: true }] });
      return;
    }
    if (event.type === "checkpoint.captured") {
      const { id, scopeId, runId, ordinalWithinScope, appRunOrdinal, status } = event.payload;
      this.#mergeRewindContext({
        ...context,
        checkpoints: [{ id, scopeId, runId, ordinalWithinScope, appRunOrdinal, status }],
      });
      return;
    }
    if (event.type === "checkpoint-scope.created") {
      const { id, kind } = event.payload;
      this.#mergeRewindContext({ ...context, checkpointScopes: [{ id, kind }] });
    }
  }
  #prepend(page: AgentHistoryPage): void {
    this.#mergeRewindContext(page.rewindContext);
    this.#cursor = page.nextCursor;
    this.#cursorAnchor = null;
    const sources = page.items.filter(
      (row) =>
        !this.#items.has(row.item.id) &&
        row.visibility !== "inherited" &&
        isAgentRuntimeAsyncQuestion(row.item),
    );
    const changes = this.#admit(page.items, true);
    this.#settleWindowAnchor(
      page.items.find((row) => this.#items.has(row.sourceItemId))?.sourceItemId ??
        this.#windowAnchorItemId,
    );
    for (const row of sources) this.#captureRequest(row.item, true);
    if (sources.length) this.#reconcileAsyncQuestions();
    changes.push(
      { type: "structure", timeline: this.#timeline(), turnEntityKeys: this.#turnKeys },
      { type: "history", resumeState: "resumed", historyComplete: !page.hasMoreHistory },
    );
    this.#applyChanges(changes);
    this.#publishView();
  }
  #captureRequest(item: AgentTurnItem, local: boolean): boolean {
    if (!local || (item.type !== "approval_request" && item.type !== "user_input_request"))
      return false;
    if (item.type === "approval_request") this.#approvalItems.set(item.requestId, item);
    if (isAgentRuntimeAsyncQuestion(item)) {
      const pending =
        item.status === "pending" || item.status === "waiting" || item.status === "completed";
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
    if (item.type === "user_message") this.#messageItems.set(item.messageId, item.id);
    const resident = {
      ...source,
      type: item.type,
      nodeId: item.nodeId,
      status: item.status,
      startedAt: item.startedAt ?? (item.type === source.type ? source.startedAt : null),
      version: itemVersion(item),
      detailVersion: source.detailVersion === itemVersion(item) ? source.detailVersion : undefined,
      nativeItemRef: item.nativeItemRef,
      providerTurnId: item.providerTurnId,
      providerThreadId: item.providerThreadId,
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
    if (changes.length > 0) this.#applyChanges(changes);
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
        const retained =
          resident?.detailVersion === itemVersion(item)
            ? this.readOwner.readItem(resident.entityKey, item.id)
            : null;
        const value = resident
          ? (retained ??
            projectAgentRuntimeItem(item, this.#thread()?.worktreePath ?? "", {
              sessionId: this.#target.sessionId,
              rootThreadId: this.#thread()?.lineage.rootThreadId ?? this.#target.threadId ?? "",
              parentThreadId: this.#thread()?.lineage.parentThreadId,
            }))
          : null;
        if (resident) {
          const settled = this.#isItemLive(item.id) && !itemIsLive(item);
          this.#rememberItem(resident, item);
          if (value)
            this.#applyChanges([
              {
                type: "item",
                key: { ...this.readOwner.key, entityKey: resident.entityKey, itemId: item.id },
                value,
              },
            ]);
          if (settled) this.#scheduleHistoryWindow();
        } else if (!this.#precedesResidentHistory(item)) {
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
            this.#applyChanges(changes);
            this.#scheduleHistoryWindow();
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
        void this.#refreshQueue(true);
      }
      return;
    }
    this.#updateRewindContext(event);
    const conversation = this.#state.conversation;
    if (!conversation) return;
    if (event.type === "checkpoint.captured" || event.type === "checkpoint-scope.created") {
      this.#publishView();
      return;
    }
    if (event.type === "node.updated") {
      this.#captureNode(event.payload);
      return;
    }
    if (event.type === "run.execution-retired") {
      this.#retireExecution(event);
      return;
    }
    if (event.type === "message.delivery.updated") {
      const itemId = this.#messageItems.get(event.payload.messageId);
      const source = itemId ? this.#items.get(itemId) : undefined;
      const item = source && itemId ? this.readOwner.readItem(source.entityKey, itemId) : null;
      if (item?.type === "userMessage" && source && itemId && item.runtimeDelivery !== "accepted")
        this.#applyChanges([
          {
            type: "item",
            key: { ...this.readOwner.key, entityKey: source.entityKey, itemId },
            value: { ...item, runtimeDelivery: event.payload.delivery },
          },
        ]);
      return;
    }
    if (event.type === "message.updated") {
      if (this.#queuePage?.entries.some((row) => row.userMessageId === event.payload.id)) {
        this.#queueEntries = this.#queueEntries.filter(
          (entry) => entry.clientUserMessageId !== event.payload.id,
        );
        void this.#refreshQueue(true);
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
      const contextReport = agentRuntimeContextReport(conversation.snapshot.projection);
      if (contextReport) retained.add(contextReport.runId);
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
      if (wasQueued || run.status === "queued") void this.#refreshQueue(true);
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
        // Rewound history replaces the topology, so readers of it, including the prompt index, rebind.
        this.#historyGeneration += 1;
        this.#applyChanges([
          { type: "remove-turn", key: { ...this.readOwner.key, entityKey } },
          { type: "structure", timeline: this.#timeline(), turnEntityKeys: this.#turnKeys },
        ]);
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
        this.#applyChanges([
          {
            type: "turn",
            key: { ...this.readOwner.key, entityKey },
            details,
            hasSubagentActivity: turn.hasSubagentActivity,
          },
        ]);
        this.#scheduleHistoryWindow();
      }
      this.#publishView();
      return;
    }
    if (event.type === "run-attempt.created" || event.type === "run-attempt.updated") {
      const projection = conversation.snapshot.projection;
      if (!projection.runs.some((run) => run.id === event.payload.runId)) return;
      const attempts = [
        ...projection.attempts.filter((attempt) => attempt.id !== event.payload.id),
        event.payload,
      ];
      this.#state = {
        ...this.#state,
        conversation: {
          ...conversation,
          snapshot: { ...conversation.snapshot, projection: { ...projection, attempts } },
        },
      };
      this.#publishView();
      return;
    }
    if (event.type === "provider-turn.updated") {
      const projection = conversation.snapshot.projection;
      const previous = projection.providerTurns.find((turn) => turn.id === event.payload.id);
      const turn = {
        ...event.payload,
        tokenUsage: event.payload.tokenUsage ?? previous?.tokenUsage,
      };
      const providerTurns = [
        ...projection.providerTurns.filter((value) => value.id !== turn.id),
        turn,
      ];
      this.#state = {
        ...this.#state,
        conversation: {
          ...conversation,
          snapshot: { ...conversation.snapshot, projection: { ...projection, providerTurns } },
        },
      };
      this.#publishView();
      return;
    }
    if (event.type === "runtime-request.updated") {
      if (event.payload.kind !== "user_input")
        this.#approvalRequests.set(event.payload.id, event.payload);
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
        if (event.payload.status !== "resolved" && this.#asyncQuestions.delete(event.payload.id))
          this.#reconcileAsyncQuestions();
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
      if (
        projection.providerThreads.some(
          (provider) => provider.id === event.payload.id && provider.status === "closed",
        )
      )
        return;
      const activates = providerThreadActivatesThread(event.payload, projection.thread.id);
      const referenced =
        activates ||
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
          snapshot: {
            ...conversation.snapshot,
            projection: {
              ...projection,
              providerThreads,
              thread: activates
                ? { ...projection.thread, activeProviderThreadId: event.payload.id }
                : projection.thread,
            },
          },
        },
      };
      this.#publishView();
      return;
    }
    // Which Agents the next message may use follows the chat's live provider session.
    if (
      event.type === "provider-session.attached" ||
      event.type === "provider-session.updated" ||
      event.type === "provider-session.detached"
    ) {
      const projection = conversation.snapshot.projection;
      const providerSessions =
        event.type === "provider-session.detached"
          ? projection.providerSessions.filter(
              (session) => session.id !== event.payload.providerSessionId,
            )
          : [
              ...projection.providerSessions.filter((session) => session.id !== event.payload.id),
              event.payload,
            ];
      this.#state = {
        ...this.#state,
        conversation: {
          ...conversation,
          snapshot: { ...conversation.snapshot, projection: { ...projection, providerSessions } },
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
      const { displayName } = projectAgentRuntimeSubagentDisplay(task);
      return {
        threadId: task.childThreadId ?? task.id,
        parentThreadId: this.#target.threadId,
        role: "backgroundChild",
        taskId: task.id,
        agent: agentRuntimeSubagentAgent(task),
        displayName,
        actorName: displayName ?? "Agent",
        thread: { displayName, model: task.model },
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
                description: displayName ?? "Agent",
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
  /** Held rows explain the hold from the Run that ended last; unchanged rows keep identity. */
  #heldQueueEntries(): readonly CodexQueuedFollowUp[] {
    const pause = agentRuntimeQueueHoldPause(
      this.#state.conversation?.snapshot.projection.runs ?? [],
    );
    if (
      this.#queueEntries.every(
        (entry) =>
          entry.pause === null ||
          (entry.pause.kind === pause.kind && entry.pause.reason === pause.reason),
      )
    )
      return this.#queueEntries;
    this.#queueEntries = this.#queueEntries.map((entry) =>
      entry.pause === null ? entry : { ...entry, pause },
    );
    return this.#queueEntries;
  }
  #queuedFollowUps(): CodexQueuedFollowUpProjection {
    if (!this.#transcriptActive) return EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION;
    return {
      ...EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION,
      status: this.#queueStatus,
      error: this.#queueError,
      ledgerRevision: this.#queuePage?.snapshotSequence ?? 0,
      projectionRevision: this.#queuePage?.snapshotSequence ?? 0,
      entries: this.#heldQueueEntries(),
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
        expandCodexAsyncQuestions(projectAgentRuntimeAsyncQuestionMessage(item)).map(
          (question, index) => ({
            ...question,
            sourceTurnId: item.runId ?? undefined,
            isSecret: item.questions[index]?.isSecret,
            initialAnswer: item.questions[index]?.initialAnswer,
            required: item.questions[index]?.required,
          }),
        ),
      ),
      answers: new Map(
        pending.flatMap((item) => {
          const questions = expandCodexAsyncQuestions(
            projectAgentRuntimeAsyncQuestionMessage(item),
          );
          return questions.flatMap((question, index) => {
            const answer = item.questionAnswer?.answers[item.questions[index]?.id ?? ""];
            return typeof answer === "string" ? [[question.id, answer] as const] : [];
          });
        }),
      ),
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
  #lastRewindContext: AgentSnapshot["projection"]["rewindContext"];
  #editableUserTurnIds: readonly string[] = [];
  #editEligibility(): readonly string[] {
    const context = this.#state.conversation?.snapshot.projection.rewindContext;
    if (context === this.#lastRewindContext) return this.#editableUserTurnIds;
    this.#lastRewindContext = context;
    this.#editableUserTurnIds = context
      ? [...resolveConversationRewindTargets(context).keys()]
      : [];
    return this.#editableUserTurnIds;
  }
  #publishView(): void {
    const conversation = this.#state.conversation;
    if (!conversation) return;
    const projection = retainAgentRuntimeContextMetadata(conversation.snapshot.projection);
    this.#state = {
      ...this.#state,
      conversation: { ...conversation, snapshot: { ...conversation.snapshot, projection } },
    };
    const thread = projection.thread;
    const latestRun = conversation.snapshot.projection.runs.reduce<AgentRuntimeRun | undefined>(
      (latest, run) =>
        run.status !== "queued" && (!latest || latest.ordinal < run.ordinal) ? run : latest,
      undefined,
    );
    for (const request of projection.runtimeRequests)
      if (request.kind !== "user_input") this.#approvalRequests.set(request.id, request);
    const pending = [...this.#approvalItems.values()].flatMap((item) => {
      const approval = projectAgentPendingApproval(
        item,
        this.#approvalRequests.get(item.requestId),
      );
      return approval ? [approval] : [];
    });
    const pendingIds = new Set(pending.map((approval) => approval.requestId));
    const awaiting = [...this.#approvalItems.values()].filter(
      (item) =>
        pendingIds.has(item.requestId) || item.decision === "decline" || item.decision === "cancel",
    );
    const awaitingRuns = new Set(awaiting.map((approval) => approval.runId));
    const suppressedItemIds = new Set(
      awaiting.length === 0
        ? []
        : [...this.#items].flatMap(([id, item]) =>
            awaitingRuns.has(item.runId) &&
            awaiting.some((approval) => agentApprovalSuppressesItem(approval, { id, ...item }))
              ? [id]
              : [],
          ),
    );
    this.approvals.update({ pending, suppressedItemIds });
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
      statusActiveFlags: [
        ...(pending.length ? ["waitingOnApproval" as const] : []),
        ...(requests.length ? ["waitingOnUserInput" as const] : []),
      ],
      archived: thread.archivedAt !== null,
      createdAt: agentRuntimeTime(thread.createdAt) ?? 0,
      updatedAt: agentRuntimeTime(thread.updatedAt) ?? 0,
      linkedAt: thread.createdAt,
      resumeState: "resumed",
      contextUsage: projectAgentRuntimeContextUsage(projection),
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
        ...memberEditCapabilities(this.#editEligibility(), this.#memberEdits),
        // A rewind races any pending or executing Run, queued messages included.
        canEditUserTurns:
          this.#supportsUserTurnEdits &&
          !(this.#state.conversation?.snapshot.projection.runs ?? []).some(
            (run) => run.status === "queued" || runIsActive(run.status),
          ),
        canForkFromTurn: this.#supportsForks,
        canSearch: false,
        canCollapseTurns: true,
      },
    };
    this.#patch({ view });
  }
}
export type MemberMessageEdit = "available" | "replied_since" | "unavailable";
/** Shown beside a Member's own message once another Member has posted after it. */
export const REPLIED_SINCE_REASON = "Someone else has replied since";
/** Rewind targets narrowed to the reader's own messages, with why their own may not be edited. */
export function memberEditCapabilities(
  rewindTargets: readonly string[],
  memberEdits: ReadonlyMap<string, MemberMessageEdit> | undefined,
): Pick<
  import("../../../shared/types").CodexConversationCapabilityFlags,
  "editableUserTurnIds" | "userTurnEditRefusals"
> {
  if (!memberEdits) return { editableUserTurnIds: rewindTargets };
  return {
    editableUserTurnIds: rewindTargets.filter((runId) => memberEdits.get(runId) === "available"),
    userTurnEditRefusals: Object.fromEntries(
      rewindTargets
        .filter((runId) => memberEdits.get(runId) === "replied_since")
        .map((runId) => [runId, REPLIED_SINCE_REASON]),
    ),
  };
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
