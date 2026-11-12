import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import {
  effectivePluginContributions,
  reloadPluginInstallation,
  publishPluginInstallation,
  setPluginInstallationEnabled,
  setPluginProjectEnabled,
  uninstallPluginInstallation,
  type EffectivePluginContributions,
  type PluginInstallationRecord,
  type PluginInstallationSource,
  type PluginProject,
  type PluginRegistry,
  type PluginTransitionError,
} from "../../shared/agent-plugins/installation-registry";
import type { AgentPluginPackage } from "../../shared/agent-plugins/types";
import type { AgentPluginReaderService } from "./AgentPluginReader";
import type {
  PluginCleanupWarning,
  PluginInstallationStore,
  PluginPackageRejected,
  PluginStoreError,
} from "./PluginInstallationStore";

export type PluginInstallationError =
  | PluginStoreError
  | PluginPackageRejected
  | PluginTransitionError
  | { readonly code: "unsupported-source"; readonly kind: "git" | "npm" }
  | { readonly code: "staged-digest-mismatch"; readonly expected: string; readonly actual: string };

export interface PluginInstallationMutation {
  readonly installation: PluginInstallationRecord;
  readonly cleanupWarnings: readonly PluginCleanupWarning[];
}

export interface PluginInstallationService {
  readonly list: Effect.Effect<PluginRegistry, PluginStoreError>;
  readonly install: (
    source: PluginInstallationSource,
    previewDigest: string,
  ) => Effect.Effect<PluginInstallationMutation, PluginInstallationError>;
  readonly reload: (
    id: string,
  ) => Effect.Effect<PluginInstallationMutation, PluginInstallationError>;
  readonly setEnabled: (
    id: string,
    enabled: boolean,
  ) => Effect.Effect<PluginInstallationRecord, PluginInstallationError>;
  readonly setProjectEnabled: (
    id: string,
    project: PluginProject,
    enabled: boolean,
  ) => Effect.Effect<PluginInstallationRecord, PluginInstallationError>;
  readonly uninstall: (
    id: string,
    options?: { readonly data: "keep" | "delete" },
  ) => Effect.Effect<PluginInstallationMutation, PluginInstallationError>;
  readonly contributions: (
    project: PluginProject,
  ) => Effect.Effect<readonly EffectivePluginContributions[], PluginStoreError>;
}

export class PluginInstallation extends Context.Service<
  PluginInstallation,
  PluginInstallationService
>()("nodex/host/PluginInstallation") {}

export function makePluginInstallation(
  reader: AgentPluginReaderService,
  store: PluginInstallationStore,
  newGeneration: () => string,
): PluginInstallationService {
  const readPackage = Effect.fnUntraced(function* (directory: string) {
    const result = yield* reader.read(directory);
    if (result.status === "rejected")
      return yield* Effect.fail({
        code: "package-rejected",
        reasons: result.reasons,
      } satisfies PluginPackageRejected);
    return result.package;
  });

  const publish = Effect.fnUntraced(function* (
    registry: PluginRegistry,
    directory: string,
    intent: { readonly previewDigest: string } | { readonly reloadId: string },
  ): Effect.fn.Return<PluginInstallationMutation, PluginInstallationError> {
    const locator = yield* store.canonicalSource(directory);
    const source = { kind: "local", locator } as const;
    const original = yield* readPackage(locator);
    const expectedDigest = "previewDigest" in intent ? intent.previewDigest : original.digest;
    const generation = yield* Effect.sync(newGeneration);
    const transition = (pkg: AgentPluginPackage) =>
      "reloadId" in intent
        ? reloadPluginInstallation(registry, intent.reloadId, source, pkg, generation)
        : publishPluginInstallation(registry, source, pkg, generation);
    const proposed = transition(original);
    if (!proposed.ok) return yield* Effect.fail(proposed.error);

    return yield* Effect.acquireUseRelease(
      store.createStage,
      Effect.fnUntraced(function* (
        stage: string,
      ): Effect.fn.Return<PluginInstallationMutation, PluginInstallationError> {
        yield* store.copyToStage(locator, stage);
        const verified = yield* readPackage(stage);
        if (verified.digest !== expectedDigest)
          return yield* Effect.fail({
            code: "staged-digest-mismatch",
            expected: expectedDigest,
            actual: verified.digest,
          } as const);
        const next = transition(verified);
        if (!next.ok) return yield* Effect.fail(next.error);
        const cleanupWarnings = yield* store.compareAndSwap(registry.revision, next.registry, {
          publish: { directory: stage, installationId: next.installation.id },
        });
        return { installation: next.installation, cleanupWarnings };
      }),
      (stage) =>
        store
          .discardStage(stage)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not discard a staged Agent Plugin", error),
            ),
          ),
    );
  });

  const install = Effect.fn("PluginInstallation.install")(function* (
    source: PluginInstallationSource,
    previewDigest: string,
  ): Effect.fn.Return<PluginInstallationMutation, PluginInstallationError> {
    if (source.kind !== "local")
      return yield* Effect.fail({ code: "unsupported-source", kind: source.kind } as const);
    const registry = yield* store.read;
    return yield* publish(registry, source.locator, { previewDigest });
  });

  const reload = Effect.fn("PluginInstallation.reload")(function* (
    id: string,
  ): Effect.fn.Return<PluginInstallationMutation, PluginInstallationError> {
    const registry = yield* store.read;
    const installation = registry.installations.find((entry) => entry.id === id);
    if (!installation) return yield* Effect.fail({ code: "not-installed", id } as const);
    return yield* publish(registry, installation.source.locator, { reloadId: id });
  });

  const changeEnablement = Effect.fnUntraced(function* (
    change: (registry: PluginRegistry) => ReturnType<typeof setPluginInstallationEnabled>,
  ) {
    const registry = yield* store.read;
    const next = change(registry);
    if (!next.ok) return yield* Effect.fail(next.error);
    if (next.registry !== registry) {
      const warnings = yield* store.compareAndSwap(registry.revision, next.registry);
      if (warnings.length > 0) yield* Effect.logWarning("Agent Plugin registry cleanup", warnings);
    }
    return next.installation;
  });

  const uninstall = Effect.fn("PluginInstallation.uninstall")(function* (
    id: string,
    options?: { readonly data: "keep" | "delete" },
  ) {
    const registry = yield* store.read;
    const next = uninstallPluginInstallation(registry, id);
    if (!next.ok) return yield* Effect.fail(next.error);
    const cleanupWarnings = yield* store.compareAndSwap(
      registry.revision,
      next.registry,
      options?.data === "delete" ? { deleteData: id } : undefined,
    );
    return { installation: next.installation, cleanupWarnings };
  });

  return PluginInstallation.of({
    list: store.read,
    install,
    reload,
    setEnabled: (id, enabled) =>
      changeEnablement((registry) => setPluginInstallationEnabled(registry, id, enabled)),
    setProjectEnabled: (id, project, enabled) =>
      changeEnablement((registry) => setPluginProjectEnabled(registry, id, project, enabled)),
    uninstall,
    contributions: (project) =>
      Effect.map(store.read, (registry) => effectivePluginContributions(registry, project)),
  });
}
