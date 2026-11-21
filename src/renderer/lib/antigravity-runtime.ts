import type { AntigravityRuntimeSnapshot } from "../../shared/antigravity-runtime";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
import { resolveRendererTransport } from "./renderer-transport";

const start = defineRendererCommand({
  key: "antigravity_runtime.start",
  channel: "antigravity-runtime:start",
  authority: "main",
  owner: "AgentRuntimeAntigravityInstallation",
  protocol: { kind: "pending_operation" },
});

const remove = defineRendererCommand({
  key: "antigravity_runtime.remove",
  channel: "antigravity-runtime:remove",
  authority: "main",
  owner: "AgentRuntimeAntigravityInstallation",
  protocol: { kind: "pending_operation" },
});

const cancel = defineRendererCommand({
  key: "antigravity_runtime.cancel",
  channel: "antigravity-runtime:operation:cancel",
  authority: "main",
  owner: "AgentRuntimeAntigravityInstallation",
  protocol: { kind: "returned_value" },
});

export interface AntigravityRuntimeAdapter {
  readonly read: () => Promise<AntigravityRuntimeSnapshot>;
  readonly check: () => Promise<AntigravityRuntimeSnapshot>;
  readonly install: () => Promise<AntigravityRuntimeSnapshot>;
  readonly remove: () => Promise<AntigravityRuntimeSnapshot>;
  readonly readOperation: (id: string) => Promise<AntigravityRuntimeSnapshot>;
  readonly cancel: (id: string) => Promise<AntigravityRuntimeSnapshot>;
  readonly subscribeInvalidation: (listener: () => void) => () => void;
  readonly subscribe: (listener: (snapshot: AntigravityRuntimeSnapshot) => void) => () => void;
}

export const antigravityRuntime: AntigravityRuntimeAdapter = {
  read: () => invokeRendererQuery("antigravity-runtime:read"),
  check: () => invokeRendererQuery("antigravity-runtime:check"),
  install: () => invokePlainCommand(start),
  remove: () => invokePlainCommand(remove),
  readOperation: (id) => invokeRendererQuery("antigravity-runtime:operation:read", id),
  cancel: (id) => invokePlainCommand(cancel, id),
  subscribeInvalidation: (listener) => {
    const transport = resolveRendererTransport();
    const stopSettings = transport.subscribeAgentSettingsChanges(listener);
    const stopConnection = transport.subscribeAgentRuntimeConnectionChanges?.((state) => {
      if (state.status === "ready") listener();
    });
    return () => {
      stopSettings();
      stopConnection?.();
    };
  },
  subscribe: (listener) =>
    resolveRendererTransport().subscribeAntigravityRuntimeChanges?.(listener) ?? (() => {}),
};
