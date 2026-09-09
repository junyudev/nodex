import type {
  AcpBackendAuthenticateInput,
  AcpBackendConfigOptionInput,
  AcpBackendModeInput,
  AcpBackendPromptInput,
  AcpBackendSessionChangedEvent,
  AcpBackendSessionOpenInput,
  AcpBackendThreadStartInput,
} from "../../shared/agent-backend-api";
import type { IpcApi } from "../../shared/ipc-api";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "./renderer-command";
import { resolveRendererTransport } from "./renderer-transport";

const openAcpSessionCommand = defineRendererCommand({
  key: "acp_conversation.session.open",
  channel: "agent-backend:acp:session:open",
  authority: "external",
  owner: "AcpConversationOwner",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "thread" },
});

const promptAcpSessionCommand = defineRendererCommand({
  key: "acp_conversation.session.prompt",
  channel: "agent-backend:acp:session:prompt",
  authority: "external",
  owner: "AcpConversationOwner",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "thread" },
});

const startAcpThreadCommand = defineRendererCommand({
  key: "acp_conversation.thread.start",
  channel: "agent-backend:acp:thread:start",
  authority: "external",
  owner: "AcpConversationOwner",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "session" },
});

const authenticateAcpSessionCommand = defineRendererCommand({
  key: "acp_conversation.session.authenticate",
  channel: "agent-backend:acp:session:authenticate",
  authority: "external",
  owner: "AcpConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "thread" },
});

const cancelAcpSessionCommand = defineRendererCommand({
  key: "acp_conversation.session.cancel",
  channel: "agent-backend:acp:session:cancel",
  authority: "external",
  owner: "AcpConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "thread" },
});

const closeAcpSessionCommand = defineRendererCommand({
  key: "acp_conversation.session.close",
  channel: "agent-backend:acp:session:close",
  authority: "external",
  owner: "AcpConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "thread" },
});

const setConfigOptionAcpSessionCommand = defineRendererCommand({
  key: "acp_conversation.session.set-config-option",
  channel: "agent-backend:acp:session:set-config-option",
  authority: "external",
  owner: "AcpConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "thread" },
});

const setModeAcpSessionCommand = defineRendererCommand({
  key: "acp_conversation.session.set-mode",
  channel: "agent-backend:acp:session:set-mode",
  authority: "external",
  owner: "AcpConversationOwner",
  protocol: { kind: "returned_value" },
  trace: { scopeKind: "thread" },
});

export interface AcpBackendRuntime {
  readonly startThread: (
    input: AcpBackendThreadStartInput,
  ) => Promise<IpcApi["agent-backend:acp:thread:start"]["result"]>;
  readonly open: (
    input: AcpBackendSessionOpenInput,
  ) => Promise<IpcApi["agent-backend:acp:session:open"]["result"]>;
  readonly read: (threadId: string) => Promise<IpcApi["agent-backend:acp:session:read"]["result"]>;
  readonly prompt: (
    input: AcpBackendPromptInput,
  ) => Promise<IpcApi["agent-backend:acp:session:prompt"]["result"]>;
  readonly cancel: (
    threadId: string,
  ) => Promise<IpcApi["agent-backend:acp:session:cancel"]["result"]>;
  readonly setMode: (
    input: AcpBackendModeInput,
  ) => Promise<IpcApi["agent-backend:acp:session:set-mode"]["result"]>;
  readonly setConfigOption: (
    input: AcpBackendConfigOptionInput,
  ) => Promise<IpcApi["agent-backend:acp:session:set-config-option"]["result"]>;
  readonly authenticate: (
    input: AcpBackendAuthenticateInput,
  ) => Promise<IpcApi["agent-backend:acp:session:authenticate"]["result"]>;
  readonly close: (
    threadId: string,
  ) => Promise<IpcApi["agent-backend:acp:session:close"]["result"]>;
  readonly subscribe: (
    threadId: string,
    listener: (event: AcpBackendSessionChangedEvent) => void,
  ) => Promise<() => void>;
}

/** Named renderer Adapter for the Main-owned ACP backend lifecycle. */
export const acpBackendRuntime: AcpBackendRuntime = {
  startThread: (input) => invokePlainCommand(startAcpThreadCommand, input),
  open: (input) => invokePlainCommand(openAcpSessionCommand, input),
  read: (threadId) => invokeRendererQuery("agent-backend:acp:session:read", threadId),
  prompt: (input) => invokePlainCommand(promptAcpSessionCommand, input),
  cancel: (threadId) => invokePlainCommand(cancelAcpSessionCommand, threadId),
  setMode: (input) => invokePlainCommand(setModeAcpSessionCommand, input),
  setConfigOption: (input) => invokePlainCommand(setConfigOptionAcpSessionCommand, input),
  authenticate: (input) => invokePlainCommand(authenticateAcpSessionCommand, input),
  close: (threadId) => invokePlainCommand(closeAcpSessionCommand, threadId),
  subscribe: async (threadId, listener) => {
    const releaseDelivery = resolveRendererTransport().subscribeAcpBackendSessionChanges(
      (event) => {
        if (event.threadId !== threadId) return;
        listener(event);
      },
    );
    try {
      await invokeRendererControl("agent-backend:acp:session:observe", threadId);
    } catch (cause) {
      releaseDelivery();
      throw cause;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      releaseDelivery();
      void invokeRendererControl("agent-backend:acp:session:unobserve", threadId);
    };
  },
};
