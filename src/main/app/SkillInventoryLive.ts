import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { SkillInventoryContext } from "../../shared/skill-inventory";
import { localProjectSourceRoots } from "../../shared/project-sources";
import { CodexPlatform } from "../../host/ProviderPlatform";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { PluginManager } from "../codex-application/PluginManager";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { ClaudeNativeCatalog } from "../agent-backend/claude/ClaudeNativeCatalog";
import { ClaudeSdk } from "../platform/node/ClaudeSdk";
import { SkillFileMutationLane } from "../host-runtime/SkillFileMutationLane";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { trashSkillDirectory } from "../platform/electron/SkillTrash";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import { canonicalBase, SkillFileError, skillIdentity } from "../platform/node/SkillFilesNode";
import {
  makeSkillInventory,
  SkillInventory,
  type SkillInventoryScope,
} from "../host-runtime/SkillInventory";
import { MainConfig } from "./MainConfig";

export const live = Layer.effect(
  SkillInventory,
  Effect.gen(function* () {
    const settings = yield* ApplicationSettings;
    const workspace = yield* ProjectWorkspace;
    const plugins = yield* PluginManager;
    const codex = yield* CodexPlatform;
    const gateway = yield* CodexGateway;
    const claude = yield* ClaudeSdk;
    const claudeCatalog = yield* ClaudeNativeCatalog;
    const desktop = yield* ElectronDesktop;
    const config = yield* MainConfig;
    const fileLane = yield* SkillFileMutationLane;
    const lifecycle = yield* ProjectRuntimeLifecycleRuntime;

    const resolve = Effect.fn("SkillInventory.resolve")(function* (
      input: SkillInventoryContext,
    ): Effect.fn.Return<SkillInventoryScope, SkillFileError> {
      if (input.hostId !== gateway.localHostId)
        return yield* Effect.fail(
          new SkillFileError("unavailable", "Skills are available on the local host."),
        );
      const project =
        input.projectId === null
          ? null
          : yield* workspace
              .getProject(input.projectId)
              .pipe(
                Effect.mapError(
                  () => new SkillFileError("unavailable", "The Project is unavailable."),
                ),
              );
      if (input.projectId !== null && project?.lifecycle !== "active")
        return yield* Effect.fail(new SkillFileError("unavailable", "The Project is unavailable."));
      const snapshot = yield* settings
        .snapshot()
        .pipe(
          Effect.mapError(
            () => new SkillFileError("unavailable", "Agent settings are unavailable."),
          ),
        );
      const sourceRoots = localProjectSourceRoots(
        (project?.sources ?? []).toSorted((a, b) => a.order - b.order),
      );
      const physicalPaths = yield* Effect.forEach(
        [config.homeDirectory, codex.accountHome.effectiveHome, ...sourceRoots],
        (root) =>
          Effect.tryPromise(() => canonicalBase(root)).pipe(Effect.orElseSucceed(() => null)),
      );
      const connection = yield* gateway
        .connection(input.hostId)
        .pipe(Effect.orElseSucceed(() => null));
      const profiles = yield* Effect.forEach(
        snapshot.claudeAgents.instances.filter((instance) => instance.enabled),
        (instance) =>
          Effect.gen(function* () {
            const launch = yield* settings
              .claudeLaunchConfiguration(instance.id)
              .pipe(Effect.orElseSucceed(() => null));
            const environment = { ...config.environment, ...launch?.environment };
            const scope = { instance: launch?.instance ?? instance, environment };
            const nativeHome = launch
              ? yield* claude.nativeHome(scope).pipe(
                  Effect.timeout("3 seconds"),
                  Effect.orElseSucceed(() => null),
                )
              : null;
            const home = nativeHome
              ? yield* Effect.tryPromise(() => canonicalBase(nativeHome)).pipe(
                  Effect.orElseSucceed(() => null),
                )
              : null;
            return {
              instanceId: instance.id,
              home,
              configuration: (cwd: string | null) =>
                claude
                  .configuration({
                    ...scope,
                    cwd: cwd ?? config.homeDirectory,
                    userSettingsOnly: cwd === null,
                  })
                  .pipe(Effect.timeout("5 seconds")),
            };
          }),
        { concurrency: 4 },
      );
      return {
        binding: skillIdentity(
          JSON.stringify([
            project?.bindingRevision,
            sourceRoots,
            physicalPaths,
            connection && "generation" in connection ? connection.generation : null,
            snapshot.revision,
            profiles.map(({ instanceId, home }) => [instanceId, home]),
          ]),
        ),
        projectRoots: sourceRoots,
        claude: profiles,
      };
    });
    const inventory = yield* makeSkillInventory({
      hostId: gateway.localHostId,
      home: config.homeDirectory,
      codexHome: codex.accountHome.effectiveHome,
      codexSharedHome: codex.codexHome,
      resolve,
      codexList: ({ hostId, projectId, forceRefresh }) =>
        plugins
          .query("skills", {
            hostId,
            projectId,
            forceReload: forceRefresh ?? false,
          })
          .pipe(Effect.timeout("5 seconds")),
      codexSetEnabled: (context, skillPath, enabled) =>
        plugins
          .command("skill-enabled", {
            ...context,
            path: skillPath,
            enabled,
          })
          .pipe(
            Effect.flatMap((result) =>
              result.status === "success" || result.status === "success-with-refresh-warning"
                ? Effect.void
                : Effect.fail(
                    new SkillFileError(
                      "unavailable",
                      "Codex could not change this skill's availability.",
                    ),
                  ),
            ),
          ),
      fileLane,
      runInProject: lifecycle.runExclusive,
      trashDirectory: (directory) => trashSkillDirectory(desktop, directory),
      refreshComposers: claudeCatalog.invalidateSkills,
      changes: plugins.changes.pipe(
        Stream.filter((event) =>
          ["skills", "plugins", "connection", "account"].includes(event.kind),
        ),
      ),
    });
    return inventory;
  }),
);
