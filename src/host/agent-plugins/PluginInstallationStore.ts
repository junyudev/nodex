import type * as Effect from "effect/Effect";
import type { PluginRegistry } from "../../shared/agent-plugins/installation-registry";
import type { AgentPluginRejectionReason } from "../../shared/agent-plugins/types";

export type PluginPackageRejected = {
  readonly code: "package-rejected";
  readonly reasons: readonly AgentPluginRejectionReason[];
};

export type PluginStoreError =
  | { readonly code: "invalid-registry" }
  | { readonly code: "revision-conflict"; readonly expected: number; readonly actual: number }
  | { readonly code: "store-busy" }
  | { readonly code: "store-io"; readonly operation: string };

export type PluginCleanupWarning =
  | { readonly kind: "generation" | "data"; readonly installationId: string }
  | { readonly kind: "writer-lock" };

export interface PluginStoreCommit {
  readonly publish?: {
    readonly directory: string;
    readonly installationId: string;
  };
  readonly deleteData?: string;
}

/** The registry replacement is the commit point for a staged generation. */
export interface PluginInstallationStore {
  readonly read: Effect.Effect<PluginRegistry, PluginStoreError>;
  readonly canonicalSource: (
    directory: string,
  ) => Effect.Effect<string, PluginPackageRejected | PluginStoreError>;
  readonly createStage: Effect.Effect<string, PluginStoreError>;
  readonly copyToStage: (
    source: string,
    stage: string,
  ) => Effect.Effect<void, PluginPackageRejected>;
  readonly discardStage: (directory: string) => Effect.Effect<void, PluginStoreError>;
  readonly compareAndSwap: (
    expected: number,
    next: PluginRegistry,
    commit?: PluginStoreCommit,
  ) => Effect.Effect<readonly PluginCleanupWarning[], PluginStoreError>;
}
