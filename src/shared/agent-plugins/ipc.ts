import type { McpRenderableResource } from "../mcp-app/mcp-app-resource-contract";
import type {
  PluginAppBinding,
  PluginAppCatalogEntry,
  PluginAppLaunchInput,
} from "./app-entrypoints";
export type AgentPluginFailure = {
  readonly code: string;
  readonly message: string;
};

export type AgentPluginResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AgentPluginFailure };

export interface PluginAppLaunch {
  readonly viewId: string;
  readonly resource: McpRenderableResource;
  readonly toolInput: PluginAppLaunchInput;
  readonly toolResult: unknown;
}

export type PluginAppViewEvent =
  | { readonly kind: "catalog-changed" }
  | { readonly viewId: string; readonly kind: "revoked" }
  | { readonly viewId: string; readonly kind: "resource-updated"; readonly uri: string };

export interface PluginAppIpcApi {
  "agent-plugins:app-entries": {
    args: [projectId: string | null];
    result: AgentPluginResult<readonly PluginAppCatalogEntry[]>;
  };
  "agent-plugins:app-open": {
    args: [binding: PluginAppBinding];
    result: AgentPluginResult<PluginAppLaunch>;
  };
  "agent-plugins:app-close": { args: [viewId: string]; result: AgentPluginResult<void> };
  "agent-plugins:app-request": {
    args: [input: { viewId: string; method: string; params?: unknown }];
    result: AgentPluginResult<unknown>;
  };
}
