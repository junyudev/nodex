import type { OpenCodeSetupState } from "../../shared/opencode-setup";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
import { resolveRendererTransport } from "./renderer-transport";

const installOpenCodeCommand = defineRendererCommand({
  key: "opencode_setup.install",
  channel: "opencode-setup:install",
  authority: "main",
  owner: "OpenCodeSetup",
  protocol: { kind: "pending_operation" },
});

const cancelOpenCodeInstallCommand = defineRendererCommand({
  key: "opencode_setup.cancel",
  channel: "opencode-setup:cancel",
  authority: "main",
  owner: "OpenCodeSetup",
  protocol: { kind: "returned_value" },
});

/** Host OpenCode setup is Main-owned; every result and event carries a monotonic revision. */
export interface OpenCodeSetupRuntime {
  readonly read: () => Promise<OpenCodeSetupState>;
  readonly install: () => Promise<OpenCodeSetupState>;
  readonly cancel: () => Promise<OpenCodeSetupState>;
  readonly subscribe: (listener: (state: OpenCodeSetupState) => void) => () => void;
}

export const openCodeSetupRuntime: OpenCodeSetupRuntime = {
  read: () => invokeRendererQuery("opencode-setup:read"),
  install: () => invokePlainCommand(installOpenCodeCommand),
  cancel: () => invokePlainCommand(cancelOpenCodeInstallCommand),
  subscribe: (listener) => resolveRendererTransport().subscribeOpenCodeSetupChanges(listener),
};
