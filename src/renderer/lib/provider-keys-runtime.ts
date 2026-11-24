import type { ProviderKeyUsageSnapshot } from "../../shared/provider-key-usage";
import type {
  ProviderKeyConnectInput,
  ProviderKeyResult,
  ProviderKeySettings,
  ProviderKeyUpdateInput,
} from "../../shared/provider-keys";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
import { resolveRendererTransport } from "./renderer-transport";

const connectCommand = defineRendererCommand({
  key: "provider_keys.connect",
  channel: "provider-keys:connect",
  authority: "main",
  owner: "ProviderKeys",
  protocol: { kind: "returned_value" },
});

const updateCommand = defineRendererCommand({
  key: "provider_keys.update",
  channel: "provider-keys:update",
  authority: "main",
  owner: "ProviderKeys",
  protocol: { kind: "returned_value" },
});

const refreshCommand = defineRendererCommand({
  key: "provider_keys.refresh_models",
  channel: "provider-keys:refresh-models",
  authority: "main",
  owner: "ProviderKeys",
  protocol: { kind: "returned_value" },
});

const removeCommand = defineRendererCommand({
  key: "provider_keys.remove",
  channel: "provider-keys:remove",
  authority: "main",
  owner: "ProviderKeys",
  protocol: { kind: "returned_value" },
});

/**
 * API key connections are Main-owned: Main checks each key with its provider, keeps it in the
 * system keychain and broadcasts every saved change to all windows.
 */
export interface ProviderKeysRuntime {
  readonly read: () => Promise<ProviderKeySettings>;
  readonly connect: (input: ProviderKeyConnectInput) => Promise<ProviderKeyResult>;
  readonly update: (input: ProviderKeyUpdateInput) => Promise<ProviderKeyResult>;
  readonly refreshModels: (input: { readonly id: string }) => Promise<ProviderKeyResult>;
  readonly remove: (input: { readonly id: string }) => Promise<ProviderKeySettings>;
  readonly subscribe: (listener: (settings: ProviderKeySettings) => void) => () => void;
}

export const providerKeysRuntime: ProviderKeysRuntime = {
  read: () => invokeRendererQuery("provider-keys:read"),
  connect: (input) => invokePlainCommand(connectCommand, input),
  update: (input) => invokePlainCommand(updateCommand, input),
  refreshModels: (input) => invokePlainCommand(refreshCommand, input),
  remove: (input) => invokePlainCommand(removeCommand, input),
  subscribe: (listener) => resolveRendererTransport().subscribeProviderKeyChanges(listener),
};

export const providerKeyUsageRuntime = {
  read: () => invokeRendererQuery("provider-keys:usage:read"),
  refresh: (connectionId?: string) =>
    invokeRendererQuery("provider-keys:usage:refresh", connectionId),
  subscribe: (listener: (snapshot: ProviderKeyUsageSnapshot) => void) =>
    resolveRendererTransport().subscribeProviderKeyUsageChanges?.(listener),
};
