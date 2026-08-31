import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import type { PluginInstalledResponse } from "@nodex/codex-app-server-protocol/v2/PluginInstalledResponse";
import type { SkillsListResponse } from "@nodex/codex-app-server-protocol/v2/SkillsListResponse";
import type { ExperimentalFeature } from "@nodex/codex-app-server-protocol/v2/ExperimentalFeature";
import type {
  CodexHooksListInput,
  CodexHooksListResponse,
  CodexHooksStateUpdateInput,
} from "../../shared/codex-hooks";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import type {
  CodexComposerPlugin,
  CodexComposerPluginActivateInput,
  CodexComposerSkill,
  CodexCollaborationModePreset,
  CodexModelOption,
} from "../../shared/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import {
  buildComposerPluginInventory,
  COMPOSER_INSTALL_SUGGESTION_PLUGIN_NAMES,
  hydrateComposerPluginInventoryIcons,
  resolveComposerPluginActivation,
} from "../codex/composer-plugin-inventory";
import {
  buildComposerSkillInventory,
  hydrateComposerSkillInventoryIcons,
} from "../codex/composer-skill-inventory";
import { parseCollaborationModePreset, parseModelOption } from "./ComposerCatalogState";

export class ComposerCatalogInputError extends Schema.TaggedError<ComposerCatalogInputError>()(
  "ComposerCatalogInputError",
  { message: Schema.String },
) {}

export class ComposerCatalogProjectionError extends Schema.TaggedError<ComposerCatalogProjectionError>()(
  "ComposerCatalogProjectionError",
  { cause: Schema.Defect() },
) {}

export type ComposerCatalogError =
  | CodexRuntimeError
  | ComposerCatalogInputError
  | ComposerCatalogProjectionError;

export class ComposerCatalog extends Context.Service<
  ComposerCatalog,
  {
    readonly listModels: Effect.Effect<readonly CodexModelOption[], ComposerCatalogError>;
    readonly listExperimentalFeatures: Effect.Effect<
      readonly ExperimentalFeature[],
      CodexRuntimeError
    >;
    readonly listCollaborationModes: Effect.Effect<
      readonly CodexCollaborationModePreset[],
      CodexRuntimeError
    >;
    readonly listPlugins: (
      cwds: readonly string[],
    ) => Effect.Effect<readonly CodexComposerPlugin[], ComposerCatalogError>;
    readonly activatePlugin: (
      input: CodexComposerPluginActivateInput,
    ) => Effect.Effect<void, ComposerCatalogError>;
    readonly listSkills: (
      cwds: readonly string[],
    ) => Effect.Effect<readonly CodexComposerSkill[], ComposerCatalogError>;
    readonly listHooks: (
      input: CodexHooksListInput,
    ) => Effect.Effect<CodexHooksListResponse, ComposerCatalogError>;
    readonly updateHooksState: (
      input: CodexHooksStateUpdateInput,
    ) => Effect.Effect<void, ComposerCatalogError>;
  }
>()("nodex/main/codex-application/ComposerCatalog") {}

const normalizeCwds = (cwds: readonly string[]): string[] => [
  ...new Set(cwds.map((cwd) => cwd.trim()).filter(Boolean)),
];

export const CODEX_MODEL_CATALOG_PAGE_SIZE = 100;
export const CODEX_MODEL_CATALOG_MAX_PAGES = 100;

// Both trees are generated from the same pinned app-server schema. The Effect tree is the wire
// authority; the product projection helpers still consume the plain generated aliases.
const asPlainPluginResponse = (
  response: ClientRequestResponsesByMethod["plugin/installed"],
): PluginInstalledResponse => response as unknown as PluginInstalledResponse;

const asPlainSkillsResponse = (
  response: ClientRequestResponsesByMethod["skills/list"],
): SkillsListResponse => response as unknown as SkillsListResponse;

export const live: Layer.Layer<ComposerCatalog, never, CodexGateway> = Layer.effect(
  ComposerCatalog,
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const awaitReady = gateway.awaitReady(gateway.localHostId);

    const readInstalled = (cwds: readonly string[]) =>
      gateway.requestLocal("plugin/installed", {
        cwds: cwds.length > 0 ? [...cwds] : null,
        installSuggestionPluginNames: [...COMPOSER_INSTALL_SUGGESTION_PLUGIN_NAMES],
      });

    const listPlugins: ComposerCatalog["Service"]["listPlugins"] = (cwds) =>
      Effect.gen(function* () {
        yield* awaitReady;
        const response = yield* readInstalled(normalizeCwds(cwds));
        const plain = asPlainPluginResponse(response);
        return yield* Effect.tryPromise({
          try: () =>
            hydrateComposerPluginInventoryIcons(
              plain,
              buildComposerPluginInventory(plain, {
                installSuggestionPluginNames: COMPOSER_INSTALL_SUGGESTION_PLUGIN_NAMES,
              }),
            ),
          catch: (cause) => new ComposerCatalogProjectionError({ cause }),
        });
      });

    const activatePlugin: ComposerCatalog["Service"]["activatePlugin"] = (input) =>
      Effect.gen(function* () {
        yield* awaitReady;
        const id = input.id.trim();
        if (!id) {
          return yield* new ComposerCatalogInputError({
            message: "Composer plugin id is required",
          });
        }
        const cwds = normalizeCwds(input.cwds);
        const installed = yield* readInstalled(cwds);
        const activation = yield* Effect.try({
          try: () => resolveComposerPluginActivation(asPlainPluginResponse(installed), id),
          catch: (cause) => new ComposerCatalogInputError({ message: String(cause) }),
        });
        if (activation.kind === "active") return;
        if (activation.kind === "enable") {
          yield* gateway.requestLocal(
            "config/batchWrite",
            activation.params as unknown as ClientRequestParamsByMethod["config/batchWrite"],
          );
        } else {
          yield* gateway.requestLocal(
            "plugin/install",
            activation.params as unknown as ClientRequestParamsByMethod["plugin/install"],
          );
        }
        yield* gateway.requestLocal("skills/list", { cwds, forceReload: true });
        const verified = (yield* readInstalled(cwds)).marketplaces
          .flatMap((marketplace) => marketplace.plugins)
          .find((plugin) => plugin.id.trim() === id);
        if (!verified?.installed || !verified.enabled) {
          return yield* new ComposerCatalogInputError({
            message: "Composer plugin activation did not become active",
          });
        }
      });

    const listModels = Effect.fn("ComposerCatalog.listModels")(function* () {
      yield* awaitReady;
      const models: CodexModelOption[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;

      for (let page = 0; page < CODEX_MODEL_CATALOG_MAX_PAGES; page += 1) {
        const response: ClientRequestResponsesByMethod["model/list"] = yield* gateway.requestLocal(
          "model/list",
          {
            cursor,
            limit: CODEX_MODEL_CATALOG_PAGE_SIZE,
          },
        );
        models.push(
          ...response.data
            .map(parseModelOption)
            .filter((option): option is CodexModelOption => option !== null),
        );

        const nextCursor: string | null = response.nextCursor ?? null;
        if (nextCursor === null) return models;
        if (seenCursors.has(nextCursor)) {
          return yield* new ComposerCatalogProjectionError({
            cause: new Error(`Model catalog repeated cursor '${nextCursor}'`),
          });
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      return yield* new ComposerCatalogProjectionError({
        cause: new Error(
          `Model catalog exceeded ${CODEX_MODEL_CATALOG_MAX_PAGES} pages without completing`,
        ),
      });
    });

    return ComposerCatalog.of({
      listModels: listModels(),
      listExperimentalFeatures: Effect.gen(function* () {
        yield* awaitReady;
        const features: ExperimentalFeature[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | null = null;
        do {
          const response: ClientRequestResponsesByMethod["experimentalFeature/list"] =
            yield* gateway.requestLocal("experimentalFeature/list", { cursor, limit: 100 });
          features.push(...response.data.map((feature) => feature as ExperimentalFeature));
          const nextCursor: string | null = response.nextCursor ?? null;
          if (nextCursor === null || seenCursors.has(nextCursor)) break;
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        } while (true);
        return features;
      }),
      listCollaborationModes: Effect.gen(function* () {
        yield* awaitReady;
        const response = yield* gateway.requestLocal("collaborationMode/list", {});
        return response.data
          .map(parseCollaborationModePreset)
          .filter((preset): preset is CodexCollaborationModePreset => preset !== null);
      }),
      listPlugins,
      activatePlugin,
      listSkills: (cwds) =>
        Effect.gen(function* () {
          yield* awaitReady;
          const normalized = normalizeCwds(cwds);
          const response = yield* gateway.requestLocal("skills/list", {
            ...(normalized.length > 0 ? { cwds: normalized } : {}),
          });
          const plain = asPlainSkillsResponse(response);
          return yield* Effect.tryPromise({
            try: () =>
              hydrateComposerSkillInventoryIcons(plain, buildComposerSkillInventory(plain)),
            catch: (cause) => new ComposerCatalogProjectionError({ cause }),
          });
        }),
      listHooks: (input) =>
        Effect.gen(function* () {
          if (input.hostId !== DEFAULT_CODEX_HOST_ID) {
            return yield* new ComposerCatalogInputError({
              message: `Codex host is unavailable: ${input.hostId}`,
            });
          }
          yield* awaitReady;
          return (yield* gateway.requestLocal("hooks/list", {
            cwds: input.cwds,
          })) as unknown as CodexHooksListResponse;
        }),
      updateHooksState: (input) =>
        Effect.gen(function* () {
          if (input.hostId !== DEFAULT_CODEX_HOST_ID) {
            return yield* new ComposerCatalogInputError({
              message: `Codex host is unavailable: ${input.hostId}`,
            });
          }
          if (input.patches.length === 0) {
            return yield* new ComposerCatalogInputError({
              message: "At least one hook state patch is required",
            });
          }
          const seenKeys = new Set<string>();
          for (const patch of input.patches) {
            if (!patch.key.trim()) {
              return yield* new ComposerCatalogInputError({ message: "Hook key is required" });
            }
            if (seenKeys.has(patch.key)) {
              return yield* new ComposerCatalogInputError({
                message: `Duplicate hook state patch: ${patch.key}`,
              });
            }
            if (patch.trustedHash !== undefined && !patch.trustedHash.trim()) {
              return yield* new ComposerCatalogInputError({
                message: "Hook trusted hash is required",
              });
            }
            seenKeys.add(patch.key);
          }
          yield* awaitReady;
          const value = Object.fromEntries(
            input.patches.map((patch) => [
              patch.key,
              {
                ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
                ...(patch.trustedHash === undefined ? {} : { trusted_hash: patch.trustedHash }),
              },
            ]),
          );
          yield* gateway.requestLocal("config/batchWrite", {
            edits: [{ keyPath: "hooks.state", value, mergeStrategy: "upsert" }],
            filePath: null,
            expectedVersion: null,
            reloadUserConfig: true,
          });
        }),
    });
  }),
);
