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

const defineAcpReturnedCommand = <
  const Channel extends
    | "agent-backend:acp:session:authenticate"
    | "agent-backend:acp:session:cancel"
    | "agent-backend:acp:session:close"
    | "agent-backend:acp:session:set-config-option"
    | "agent-backend:acp:session:set-mode",
>(
  channel: Channel,
) =>
  defineRendererCommand({
    key: `acp_conversation.${channel}`,
    channel,
    authority: "external",
    owner: "AcpConversationOwner",
    protocol: { kind: "returned_value" },
    trace: { scopeKind: "thread" },
  });

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

const acpCommands = {
  authenticate: defineAcpReturnedCommand("agent-backend:acp:session:authenticate"),
  cancel: defineAcpReturnedCommand("agent-backend:acp:session:cancel"),
  close: defineAcpReturnedCommand("agent-backend:acp:session:close"),
  setConfigOption: defineAcpReturnedCommand("agent-backend:acp:session:set-config-option"),
  setMode: defineAcpReturnedCommand("agent-backend:acp:session:set-mode"),
} as const;

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
  cancel: (threadId) => invokePlainCommand(acpCommands.cancel, threadId),
  setMode: (input) => invokePlainCommand(acpCommands.setMode, input),
  setConfigOption: (input) => invokePlainCommand(acpCommands.setConfigOption, input),
  authenticate: (input) => invokePlainCommand(acpCommands.authenticate, input),
  close: (threadId) => invokePlainCommand(acpCommands.close, threadId),
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
