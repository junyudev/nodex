import type { AgentInteractionResponse } from "../../shared/agent-conversation";
import type {
  AgentBackendAuthenticateInput,
  AgentBackendConfigOptionInput,
  AgentBackendModeInput,
  AgentBackendPromptInput,
  AgentBackendSessionChangedEvent,
  AgentBackendSessionOpenInput,
  AgentBackendThreadStartInput,
  AgentBackendIntelligenceInput,
  AgentBackendControlInput,
  AgentBackendForkInput,
  NativePermissionMode,
} from "../../shared/agent-backend-api";
import type { IpcApi } from "../../shared/ipc-api";
import type { ClaudeModelCatalogInput } from "../../shared/claude-models";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "./renderer-command";
import { resolveRendererTransport } from "./renderer-transport";

const openAgentSessionCommand = defineRendererCommand({
  key: "agent_conversation.session.open",
  channel: "agent-backend:session:open",
  authority: "external",
  owner: "AgentConversationOwner",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "thread" },
});

const promptAgentSessionCommand = defineRendererCommand({
  key: "agent_conversation.session.prompt",
  channel: "agent-backend:session:prompt",
  authority: "external",
  owner: "AgentConversationOwner",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "thread" },
});

const startAgentThreadCommand = defineRendererCommand({
  key: "agent_conversation.thread.start",
  channel: "agent-backend:thread:start",
  authority: "external",
  owner: "AgentConversationOwner",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "session" },
});

const authenticateAgentSessionCommand = defineRendererCommand({
  key: "agent_conversation.session.authenticate",
  channel: "agent-backend:session:authenticate",
  authority: "external",
  owner: "AgentConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "thread" },
});

const cancelAgentSessionCommand = defineRendererCommand({
  key: "agent_conversation.session.cancel",
  channel: "agent-backend:session:cancel",
  authority: "external",
  owner: "AgentConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "thread" },
});

const closeAgentSessionCommand = defineRendererCommand({
  key: "agent_conversation.session.close",
  channel: "agent-backend:session:close",
  authority: "external",
  owner: "AgentConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "thread" },
});

const setConfigOptionAgentSessionCommand = defineRendererCommand({
  key: "agent_conversation.session.set-config-option",
  channel: "agent-backend:session:set-config-option",
  authority: "external",
  owner: "AgentConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "thread" },
});

const setModeAgentSessionCommand = defineRendererCommand({
  key: "agent_conversation.session.set-mode",
  channel: "agent-backend:session:set-mode",
  authority: "external",
  owner: "AgentConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "thread" },
});

const respondAgentSessionCommand = defineRendererCommand({
  key: "agent_conversation.session.respond",
  channel: "agent-backend:session:respond",
  authority: "external",
  owner: "AgentConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "thread" },
});
const intelligenceCommand = defineRendererCommand({
  key: "agent_conversation.session.intelligence",
  channel: "agent-backend:session:set-intelligence",
  authority: "external",
  owner: "AgentConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "thread" },
});
const nativeControlCommand = defineRendererCommand({
  key: "agent_conversation.session.control",
  channel: "agent-backend:session:control",
  authority: "external",
  owner: "AgentConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "thread" },
});
const nativePermissionCommand = defineRendererCommand({
  key: "agent_conversation.permission-mode.set",
  channel: "agent-backend:permission-mode:set",
  authority: "core",
  owner: "AgentConversationOwner",
  protocol: { kind: "pending_operation" },
});
const nativeForkCommand = defineRendererCommand({
  key: "agent_conversation.session.fork",
  channel: "agent-backend:session:fork",
  authority: "external",
  owner: "AgentConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "thread" },
});
const nativeTitleCommand = defineRendererCommand({
  key: "agent_conversation.session.title",
  channel: "agent-backend:session:generate-title",
  authority: "external",
  owner: "AgentConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "thread" },
});

export interface AgentBackendRuntime {
  readonly readPermissionMode: (projectId: string | null) => Promise<NativePermissionMode>;
  readonly setPermissionMode: (
    projectId: string | null,
    mode: NativePermissionMode,
  ) => Promise<NativePermissionMode>;
  readonly claudeDiscovery: (
    input: ClaudeModelCatalogInput,
    signal?: AbortSignal,
  ) => Promise<IpcApi["agent-backend:claude:discover"]["result"]>;
  readonly inspect: (
    threadId: string,
  ) => Promise<IpcApi["agent-backend:session:inspect"]["result"]>;
  readonly historyImage: (
    input: import("../../shared/agent-backend-api").AgentBackendHistoryImageInput,
  ) => Promise<string>;
  readonly toolOutput: (
    input: import("../../shared/agent-backend-api").AgentBackendToolOutputInput,
  ) => Promise<import("../../shared/agent-tool-output").AgentToolOutput>;
  readonly setIntelligence: (
    input: AgentBackendIntelligenceInput,
  ) => Promise<IpcApi["agent-backend:session:set-intelligence"]["result"]>;
  readonly control: (
    input: AgentBackendControlInput,
  ) => Promise<IpcApi["agent-backend:session:control"]["result"]>;
  readonly fork: (
    input: AgentBackendForkInput,
  ) => Promise<IpcApi["agent-backend:session:fork"]["result"]>;
  readonly generateTitle: (threadId: string) => Promise<string | null>;
  readonly claudeModels: (
    input: ClaudeModelCatalogInput,
  ) => Promise<IpcApi["agent-backend:claude:models"]["result"]>;
  readonly respond: (
    threadId: string,
    requestId: string,
    response: AgentInteractionResponse,
  ) => Promise<void>;
  readonly startThread: (
    input: AgentBackendThreadStartInput,
  ) => Promise<IpcApi["agent-backend:thread:start"]["result"]>;
  readonly open: (
    input: AgentBackendSessionOpenInput,
  ) => Promise<IpcApi["agent-backend:session:open"]["result"]>;
  readonly read: (threadId: string) => Promise<IpcApi["agent-backend:session:read"]["result"]>;
  readonly prompt: (
    input: AgentBackendPromptInput,
  ) => Promise<IpcApi["agent-backend:session:prompt"]["result"]>;
  readonly cancel: (threadId: string) => Promise<IpcApi["agent-backend:session:cancel"]["result"]>;
  readonly setMode: (
    input: AgentBackendModeInput,
  ) => Promise<IpcApi["agent-backend:session:set-mode"]["result"]>;
  readonly setConfigOption: (
    input: AgentBackendConfigOptionInput,
  ) => Promise<IpcApi["agent-backend:session:set-config-option"]["result"]>;
  readonly authenticate: (
    input: AgentBackendAuthenticateInput,
  ) => Promise<IpcApi["agent-backend:session:authenticate"]["result"]>;
  readonly close: (threadId: string) => Promise<IpcApi["agent-backend:session:close"]["result"]>;
  readonly subscribe: (
    threadId: string,
    listener: (event: AgentBackendSessionChangedEvent) => void,
  ) => Promise<() => void>;
}

/** Named renderer Adapter for the Main-owned Agent backend lifecycle. */
export const agentBackendRuntime: AgentBackendRuntime = {
  readPermissionMode: (projectId) =>
    invokeRendererQuery("agent-backend:permission-mode:get", projectId),
  setPermissionMode: (projectId, mode) =>
    invokePlainCommand(nativePermissionCommand, projectId, mode),
  claudeDiscovery: async (input, signal) => {
    if (signal?.aborted) throw new DOMException("Claude discovery cancelled", "AbortError");
    const requestId = createUuidV7();
    let rejectCancellation: ((reason: unknown) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancel = () => {
      void invokeRendererControl("agent-backend:claude:cancel-discovery", { requestId }).catch(
        () => {},
      );
      rejectCancellation?.(new DOMException("Claude discovery cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await Promise.race([
        invokeRendererQuery("agent-backend:claude:discover", { ...input, requestId }),
        cancellation,
      ]);
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  },
  inspect: (threadId) => invokeRendererQuery("agent-backend:session:inspect", threadId),
  historyImage: (input) => invokeRendererQuery("agent-backend:session:history-image", input),
  toolOutput: (input) => invokeRendererQuery("agent-backend:session:tool-output", input),
  setIntelligence: (input) => invokePlainCommand(intelligenceCommand, input),
  control: (input) => invokePlainCommand(nativeControlCommand, input),
  fork: (input) => invokePlainCommand(nativeForkCommand, input),
  generateTitle: (threadId) => invokePlainCommand(nativeTitleCommand, threadId),
  claudeModels: (input) => invokeRendererQuery("agent-backend:claude:models", input),
  respond: (threadId, requestId, response) =>
    invokePlainCommand(respondAgentSessionCommand, { threadId, requestId, response }),
  startThread: (input) => invokePlainCommand(startAgentThreadCommand, input),
  open: (input) => invokePlainCommand(openAgentSessionCommand, input),
  read: (threadId) => invokeRendererQuery("agent-backend:session:read", threadId),
  prompt: (input) => invokePlainCommand(promptAgentSessionCommand, input),
  cancel: (threadId) => invokePlainCommand(cancelAgentSessionCommand, threadId),
  setMode: (input) => invokePlainCommand(setModeAgentSessionCommand, input),
  setConfigOption: (input) => invokePlainCommand(setConfigOptionAgentSessionCommand, input),
  authenticate: (input) => invokePlainCommand(authenticateAgentSessionCommand, input),
  close: (threadId) => invokePlainCommand(closeAgentSessionCommand, threadId),
  subscribe: async (threadId, listener) => {
    const releaseDelivery = resolveRendererTransport().subscribeAgentBackendSessionChanges(
      (event) => {
        if (event.threadId !== threadId) return;
        listener(event);
      },
    );
    try {
      await invokeRendererControl("agent-backend:session:observe", threadId);
    } catch (cause) {
      releaseDelivery();
      throw cause;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      releaseDelivery();
      void invokeRendererControl("agent-backend:session:unobserve", threadId);
    };
  },
};
