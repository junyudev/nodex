import type {
  AgentRuntimeConversation,
  AgentRuntimeInspection,
  AgentRuntimeOverviewInput,
  AgentRuntimeLaunch,
  AgentRuntimeLaunchResult,
  AgentRuntimeSessionTarget,
  AgentRuntimeMessageInput,
  AgentRuntimeStopInput,
  AgentRuntimeResponseInput,
  AgentRuntimeModeInput,
  AgentRuntimeCompactInput,
  AgentRuntimeRollbackInput,
  AgentRuntimeTaskStopInput,
  AgentRuntimePreparationRetryInput,
  AgentRuntimeQueueInput,
  AgentRuntimeForkInput,
  AgentRuntimeHistoryInput,
  AgentRuntimeQueueReadInput,
  AgentRuntimeQueuePage,
  AgentRuntimeRunInput,
  AgentRuntimeRunMessage,
  AgentRuntimeQueuedPreview,
  AgentRuntimeItemInput,
  AgentRuntimeAttachmentInput,
  AgentRuntimeSessionEvent,
  AgentRuntimeObserveInput,
  AgentRuntimeSessionActivitySnapshot,
  AgentRuntimeSessionMoveInput,
  AgentRuntimeConnectionState,
} from "../../shared/agent-runtime-api";
import type {
  AgentHistoryPage,
  AgentRuntimeOperations,
  AgentTurnItem,
} from "@nodex/agent-runtime/contracts";
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
const rollback = defineRendererCommand({
  key: "agent_runtime.session.rollback",
  channel: "agent-runtime:session:rollback",
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

export interface AgentRuntimeRendererTransport {
  readonly launch: (input: AgentRuntimeLaunch) => Promise<AgentRuntimeLaunchResult>;
  readonly read: (target: AgentRuntimeSessionTarget) => Promise<AgentRuntimeConversation>;
  readonly control: (target: AgentRuntimeSessionTarget) => Promise<AgentRuntimeConversation>;
  readonly inspect: (target: AgentRuntimeSessionTarget) => Promise<AgentRuntimeInspection>;
  readonly overview: (
    input: AgentRuntimeOverviewInput,
  ) => Promise<AgentRuntimeOperations["tasks.overview"]["output"]>;
  readonly message: (input: AgentRuntimeMessageInput) => Promise<{ readonly sequence: number }>;
  readonly queueMessage: (
    input: AgentRuntimeMessageInput,
  ) => Promise<{ readonly sequence: number }>;
  readonly queue: (input: AgentRuntimeQueueInput) => Promise<{ readonly sequence: number }>;
  readonly fork: (
    input: AgentRuntimeForkInput,
  ) => Promise<AgentRuntimeLaunchResult & { readonly sourceSessionId: string }>;
  readonly stop: (input: AgentRuntimeStopInput) => Promise<{ readonly stopped: boolean }>;
  readonly respond: (input: AgentRuntimeResponseInput) => Promise<{ readonly sequence: number }>;
  readonly setModes: (input: AgentRuntimeModeInput) => Promise<{ readonly changed: boolean }>;
  readonly compact: (
    input: AgentRuntimeCompactInput,
  ) => Promise<AgentRuntimeOperations["thread.compact"]["output"]>;
  readonly rollback: (input: AgentRuntimeRollbackInput) => Promise<{ readonly rolledBack: true }>;
  readonly stopTask: (input: AgentRuntimeTaskStopInput) => Promise<{ readonly sequence: number }>;
  readonly retryPreparation: (
    input: AgentRuntimePreparationRetryInput,
  ) => Promise<{ readonly retried: true }>;
  readonly moveSession: (
    input: AgentRuntimeSessionMoveInput,
  ) => Promise<{ readonly sessionId: string; readonly projectId: string | null }>;
  readonly catalog: (
    input?: AgentRuntimeOperations["providers.read"]["input"],
  ) => Promise<AgentRuntimeOperations["providers.read"]["output"]>;
  readonly history: (input: AgentRuntimeHistoryInput) => Promise<AgentHistoryPage>;
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
  launch: (input) => invokePlainCommand(launch, input),
  read: (input) => invokeRendererQuery("agent-runtime:session:read", input),
  control: (input) => invokeRendererQuery("agent-runtime:session:control", input),
  inspect: (input) => invokeRendererQuery("agent-runtime:session:inspect", input),
  overview: (input) => invokeRendererQuery("agent-runtime:session:overview", input),
  message: (input) => invokePlainCommand(message, input),
  queueMessage: (input) => invokePlainCommand(queueMessage, input),
  queue: (input) => invokePlainCommand(queue, input),
  fork: (input) => invokePlainCommand(fork, input),
  stop: (input) => invokePlainCommand(stop, input),
  respond: (input) => invokePlainCommand(respond, input),
  setModes: (input) => invokePlainCommand(setModes, input),
  compact: (input) => invokePlainCommand(compact, input),
  rollback: (input) => invokePlainCommand(rollback, input),
  stopTask: (input) => invokePlainCommand(stopTask, input),
  retryPreparation: (input) => invokePlainCommand(retryPreparation, input),
  moveSession: (input) => invokePlainCommand(moveSession, input),
  catalog: (input) => invokeRendererQuery("agent-runtime:providers:read", input),
  history: (input) => invokeRendererQuery("agent-runtime:session:history", input),
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
