import type {
  AgentRuntimeConversation,
  AgentRuntimeControlInput,
  AgentRuntimeInspection,
  AgentRuntimeOverviewInput,
  AgentRuntimeLaunch,
  AgentRuntimeLaunchResult,
  AgentRuntimeSessionTarget,
  AgentRuntimeMessageInput,
  AgentRuntimeStopInput,
  AgentRuntimeResponseInput,
  AgentRuntimeModeInput,
  AgentRuntimeClearContextInput,
  AgentRuntimeCompactInput,
  AgentRuntimeRewriteMessageInput,
  AgentRuntimeTaskStopInput,
  AgentRuntimeBackgroundStopInput,
  AgentRuntimeBackgroundOutputInput,
  AgentRuntimeBackgroundOutput,
  AgentRuntimeTaskCancelInput,
  AgentRuntimePreparationRetryInput,
  AgentRuntimeQueueInput,
  AgentRuntimeMergeBackInput,
  AgentRuntimeForkInput,
  AgentRuntimeSideChatCreateInput,
  AgentRuntimeSideChatDiscardInput,
  AgentRuntimeSideChatSaveInput,
  AgentRuntimeHistoryInput,
  AgentRuntimeQueueReadInput,
  AgentRuntimeQueuePage,
  AgentRuntimeRunInput,
  AgentRuntimePromptIndex,
  AgentRuntimeRunMessage,
  AgentRuntimeQueuedPreview,
  AgentRuntimeItemInput,
  AgentRuntimeAttachmentInput,
  AgentRuntimeSessionEvent,
  AgentRuntimeObserveInput,
  AgentRuntimeSessionActivitySnapshot,
  AgentRuntimeSessionMoveInput,
  AgentRuntimeConnectionState,
  ClaudeUsageSnapshot,
  AgentRuntimeIpcApi,
} from "../../shared/agent-runtime-api";
import type {
  AgentHistoryPage,
  AgentRuntimeOperations,
  AgentTurnItem,
} from "@nodex/agent-runtime/contracts";
import type { ConversationIdentity } from "../../shared/conversation-identity";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "./renderer-command";
import { resolveRendererTransport } from "./renderer-transport";

const launch = defineRendererCommand({
  key: "agent_runtime.session.launch",
  channel: "agent-runtime:session:launch",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "session" },
});
const message = defineRendererCommand({
  key: "agent_runtime.session.message",
  channel: "agent-runtime:session:message",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "session" },
});
const queueMessage = defineRendererCommand({
  key: "agent_runtime.session.queue_message",
  channel: "agent-runtime:session:queue-message",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "session" },
});
const queue = defineRendererCommand({
  key: "agent_runtime.session.queue",
  channel: "agent-runtime:session:queue",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});
const fork = defineRendererCommand({
  key: "agent_runtime.session.fork",
  channel: "agent-runtime:session:fork",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});
const mergeBack = defineRendererCommand({
  key: "agent_runtime.session.merge_back",
  channel: "agent-runtime:session:merge-back",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});
const createSideChat = defineRendererCommand({
  key: "agent_runtime.session.create_side_chat",
  channel: "agent-runtime:session:create-side-chat",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});
const discardSideChat = defineRendererCommand({
  key: "agent_runtime.session.discard_side_chat",
  channel: "agent-runtime:session:discard-side-chat",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});
const saveSideChat = defineRendererCommand({
  key: "agent_runtime.session.save_side_chat",
  channel: "agent-runtime:session:save-side-chat",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});
const stop = defineRendererCommand({
  key: "agent_runtime.session.stop",
  channel: "agent-runtime:session:stop",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});
const respond = defineRendererCommand({
  key: "agent_runtime.session.respond",
  channel: "agent-runtime:session:respond",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});
const setModes = defineRendererCommand({
  key: "agent_runtime.session.modes",
  channel: "agent-runtime:session:set-modes",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});
const compact = defineRendererCommand({
  key: "agent_runtime.session.compact",
  channel: "agent-runtime:session:compact",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});
const clearContext = defineRendererCommand({
  key: "agent_runtime.session.clear_context",
  channel: "agent-runtime:session:clear-context",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});
const rewriteMessage = defineRendererCommand({
  key: "agent_runtime.session.rewrite_message",
  channel: "agent-runtime:session:rewrite-message",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});
const stopTask = defineRendererCommand({
  key: "agent_runtime.session.stop_task",
  channel: "agent-runtime:session:stop-task",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});
const stopBackground = defineRendererCommand({
  key: "agent_runtime.session.stop_background",
  channel: "agent-runtime:session:stop-background",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});
const cancelTask = defineRendererCommand({
  key: "agent_runtime.session.cancel_task",
  channel: "agent-runtime:session:cancel-task",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});

const retryPreparation = defineRendererCommand({
  key: "agent_runtime.session.retry_preparation",
  channel: "agent-runtime:session:retry-preparation",
  authority: "external",
  owner: "AgentRuntimeConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});

const moveSession = defineRendererCommand({
  key: "agent_runtime.session.move",
  channel: "agent-runtime:session:move",
  authority: "main",
  owner: "WorkbenchSidebarController",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "session" },
});

const logoutClaude = defineRendererCommand({
  key: "agent_runtime.claude_usage.logout",
  channel: "agent-runtime:claude-usage:logout",
  authority: "external",
  owner: "AgentRuntimeClaudeUsage",
  protocol: { kind: "returned_value" },
});

export interface AgentRuntimeRendererTransport {
  readonly restart: (input: { readonly generation: string }) => Promise<void>;
  readonly launch: (input: AgentRuntimeLaunch) => Promise<AgentRuntimeLaunchResult>;
  readonly read: (target: AgentRuntimeSessionTarget) => Promise<AgentRuntimeConversation>;
  readonly control: (target: AgentRuntimeControlInput) => Promise<AgentRuntimeConversation>;
  readonly inspect: (target: AgentRuntimeSessionTarget) => Promise<AgentRuntimeInspection>;
  /** Names any execution Thread, root or delegated, with its Session and current Agent. */
  readonly identify: (threadId: string) => Promise<ConversationIdentity | null>;
  readonly overview: (
    input: AgentRuntimeOverviewInput,
  ) => Promise<AgentRuntimeOperations["tasks.overview"]["output"]>;
  readonly message: (
    input: AgentRuntimeMessageInput,
  ) => Promise<AgentRuntimeIpcApi["agent-runtime:session:message"]["result"]>;
  readonly queueMessage: (
    input: AgentRuntimeMessageInput,
  ) => Promise<AgentRuntimeIpcApi["agent-runtime:session:queue-message"]["result"]>;
  readonly queue: (
    input: AgentRuntimeQueueInput,
  ) => Promise<AgentRuntimeIpcApi["agent-runtime:session:queue"]["result"]>;
  readonly fork: (
    input: AgentRuntimeForkInput,
  ) => Promise<AgentRuntimeLaunchResult & { readonly sourceSessionId: string }>;
  readonly mergeBack: (input: AgentRuntimeMergeBackInput) => Promise<AgentRuntimeLaunchResult>;
  readonly createSideChat: (
    input: AgentRuntimeSideChatCreateInput,
  ) => Promise<AgentRuntimeLaunchResult>;
  readonly discardSideChat: (
    input: AgentRuntimeSideChatDiscardInput,
  ) => Promise<{ readonly discarded: boolean }>;
  readonly saveSideChat: (
    input: AgentRuntimeSideChatSaveInput,
  ) => Promise<AgentRuntimeLaunchResult & { readonly sourceSessionId: string }>;
  readonly stop: (input: AgentRuntimeStopInput) => Promise<{ readonly stopped: boolean }>;
  readonly respond: (input: AgentRuntimeResponseInput) => Promise<{ readonly sequence: number }>;
  readonly setModes: (input: AgentRuntimeModeInput) => Promise<{ readonly changed: boolean }>;
  readonly compact: (
    input: AgentRuntimeCompactInput,
  ) => Promise<AgentRuntimeOperations["thread.compact"]["output"]>;
  readonly clearContext: (
    input: AgentRuntimeClearContextInput,
  ) => Promise<{ readonly cleared: true }>;
  readonly rewriteMessage: (
    input: AgentRuntimeRewriteMessageInput,
  ) => Promise<{ readonly sequence: number; readonly sideChatTitle?: string }>;
  readonly stopTask: (input: AgentRuntimeTaskStopInput) => Promise<{ readonly sequence: number }>;
  readonly stopBackground: (
    input: AgentRuntimeBackgroundStopInput,
  ) => Promise<{ readonly stopping: readonly string[] }>;
  readonly backgroundOutput: (
    input: AgentRuntimeBackgroundOutputInput,
  ) => Promise<AgentRuntimeBackgroundOutput | null>;
  readonly cancelTask: (
    input: AgentRuntimeTaskCancelInput,
  ) => Promise<{ readonly taskId: string; readonly status: string }>;
  readonly retryPreparation: (
    input: AgentRuntimePreparationRetryInput,
  ) => Promise<{ readonly retried: true }>;
  readonly moveSession: (
    input: AgentRuntimeSessionMoveInput,
  ) => Promise<{ readonly sessionId: string; readonly projectId: string | null }>;
  readonly catalog: (
    input?: AgentRuntimeOperations["providers.read"]["input"],
  ) => Promise<AgentRuntimeOperations["providers.read"]["output"]>;
  /** What Nodex already knows about providers; never starts execution. */
  readonly knownCatalog: () => Promise<AgentRuntimeOperations["providers.read"]["output"] | null>;
  readonly readWindowsSandbox: (
    input: AgentRuntimeOperations["providers.windows-sandbox.read"]["input"],
  ) => Promise<AgentRuntimeOperations["providers.windows-sandbox.read"]["output"]>;
  readonly setupWindowsSandbox: (
    input: AgentRuntimeOperations["providers.windows-sandbox.setup"]["input"],
  ) => Promise<AgentRuntimeOperations["providers.windows-sandbox.setup"]["output"]>;
  readonly cancelWindowsSandbox: (
    input: AgentRuntimeOperations["providers.windows-sandbox.cancel"]["input"],
  ) => Promise<AgentRuntimeOperations["providers.windows-sandbox.cancel"]["output"]>;
  /** Main's one Claude usage snapshot, shared by every window. */
  readonly claudeUsage: () => Promise<ClaudeUsageSnapshot>;
  /** Reads Claude usage again now, unless it was read moments ago. */
  readonly refreshClaudeUsage: () => Promise<ClaudeUsageSnapshot>;
  /** Signs the named Claude Agents out of Claude Code. */
  readonly logoutClaude: (instanceIds: readonly string[]) => Promise<ClaudeUsageSnapshot>;
  readonly history: (input: AgentRuntimeHistoryInput) => Promise<AgentHistoryPage>;
  readonly promptTurns: (
    input: import("../../shared/prompt-turn").PromptTurnsInput,
  ) => Promise<readonly import("../../shared/prompt-turn").PromptTurnEntry[]>;
  readonly promptIndex: (input: AgentRuntimeSessionTarget) => Promise<AgentRuntimePromptIndex>;
  readonly readQueuePage: (input: AgentRuntimeQueueReadInput) => Promise<AgentRuntimeQueuePage>;
  readonly readQueuedPreview: (input: AgentRuntimeRunInput) => Promise<AgentRuntimeQueuedPreview>;
  readonly readRunMessage: (input: AgentRuntimeRunInput) => Promise<AgentRuntimeRunMessage>;
  readonly item: (input: AgentRuntimeItemInput) => Promise<AgentTurnItem | null>;
  readonly attachment: (
    input: AgentRuntimeAttachmentInput,
  ) => Promise<AgentRuntimeOperations["thread.attachment"]["output"]>;
  readonly activity: () => Promise<AgentRuntimeSessionActivitySnapshot>;
  readonly connection: () => Promise<AgentRuntimeConnectionState>;
  readonly subscribe: (
    input: AgentRuntimeSessionTarget &
      Pick<AgentRuntimeObserveInput, "afterSequence" | "eventTypes">,
    listener: (event: AgentRuntimeSessionEvent) => void,
  ) => Promise<() => void>;
}

/** Typed Session operations; renderer consumers never dispatch engine commands directly. */
export const agentRuntimeRuntime: AgentRuntimeRendererTransport = {
  restart: (input) => invokeRendererControl("agent-runtime:restart", input),
  launch: (input) => invokePlainCommand(launch, input),
  read: (input) => invokeRendererQuery("agent-runtime:session:read", input),
  control: (input) => invokeRendererQuery("agent-runtime:session:control", input),
  inspect: (input) => invokeRendererQuery("agent-runtime:session:inspect", input),
  identify: (threadId) => invokeRendererQuery("agent-runtime:thread:identity", { threadId }),
  overview: (input) => invokeRendererQuery("agent-runtime:session:overview", input),
  message: (input) => invokePlainCommand(message, input),
  queueMessage: (input) => invokePlainCommand(queueMessage, input),
  queue: (input) => invokePlainCommand(queue, input),
  fork: (input) => invokePlainCommand(fork, input),
  mergeBack: (input) => invokePlainCommand(mergeBack, input),
  createSideChat: (input) => invokePlainCommand(createSideChat, input),
  discardSideChat: (input) => invokePlainCommand(discardSideChat, input),
  saveSideChat: (input) => invokePlainCommand(saveSideChat, input),
  stop: (input) => invokePlainCommand(stop, input),
  respond: (input) => invokePlainCommand(respond, input),
  setModes: (input) => invokePlainCommand(setModes, input),
  compact: (input) => invokePlainCommand(compact, input),
  clearContext: (input) => invokePlainCommand(clearContext, input),
  rewriteMessage: (input) => invokePlainCommand(rewriteMessage, input),
  stopTask: (input) => invokePlainCommand(stopTask, input),
  stopBackground: (input) => invokePlainCommand(stopBackground, input),
  backgroundOutput: (input) =>
    invokeRendererQuery("agent-runtime:session:background-output", input),
  cancelTask: (input) => invokePlainCommand(cancelTask, input),
  retryPreparation: (input) => invokePlainCommand(retryPreparation, input),
  moveSession: (input) => invokePlainCommand(moveSession, input),
  catalog: (input) => invokeRendererQuery("agent-runtime:providers:read", input),
  readWindowsSandbox: (input) => invokeRendererQuery("agent-runtime:windows-sandbox:read", input),
  setupWindowsSandbox: (input) =>
    invokeRendererControl("agent-runtime:windows-sandbox:setup", input),
  cancelWindowsSandbox: (input) =>
    invokeRendererControl("agent-runtime:windows-sandbox:cancel", input),
  knownCatalog: () => invokeRendererQuery("agent-runtime:providers:known"),
  claudeUsage: () => invokeRendererQuery("agent-runtime:claude-usage:read"),
  refreshClaudeUsage: () => invokeRendererQuery("agent-runtime:claude-usage:refresh"),
  logoutClaude: (instanceIds) => invokePlainCommand(logoutClaude, { instanceIds }),
  history: (input) => invokeRendererQuery("agent-runtime:session:history", input),
  promptTurns: (input) => invokeRendererQuery("agent-runtime:session:prompt-turns", input),
  promptIndex: (input) => invokeRendererQuery("agent-runtime:session:prompt-index", input),
  readQueuePage: (input) => invokeRendererQuery("agent-runtime:session:queue-read", input),
  readQueuedPreview: (input) => invokeRendererQuery("agent-runtime:session:queued-preview", input),
  readRunMessage: (input) => invokeRendererQuery("agent-runtime:session:run-message", input),
  item: (input) => invokeRendererQuery("agent-runtime:session:item", input),
  attachment: (input) => invokeRendererQuery("agent-runtime:session:attachment", input),
  activity: () => invokeRendererQuery("agent-runtime:activity:read"),
  connection: () => invokeRendererQuery("agent-runtime:connection:read"),
  subscribe: async (input, listener) => {
    const observe = resolveRendererTransport().subscribeAgentRuntimeSessionEvents;
    if (!observe) throw new Error("Agent Runtime event delivery is unavailable");
    const subscriptionId = createUuidV7();
    const release = observe((event) => {
      if (
        event.subscriptionId === subscriptionId &&
        event.sessionId === input.sessionId &&
        (!input.threadId || event.threadId === input.threadId)
      )
        listener(event);
    });
    try {
      await invokeRendererControl("agent-runtime:session:observe", { ...input, subscriptionId });
    } catch (cause) {
      release();
      throw cause;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      release();
      void invokeRendererControl("agent-runtime:session:unobserve", { subscriptionId }).catch(
        () => {},
      );
    };
  },
};
