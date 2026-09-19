import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { CodexPersonality } from "../../shared/types";
import {
  buildCodexDesktopDeveloperInstructions,
  buildCodexThreadDeveloperInstructions,
} from "../codex/codex-developer-instructions";
import { buildCodexDesktopThreadFeatureConfig } from "../codex/codex-thread-config";
import { CodexGateway, type CodexGatewayRequestOptions } from "../codex-runtime/CodexGateway";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { CodexGitProbe } from "./CodexGitProbe";
import { parseCodexPersonality } from "./CodexPersonality";

export interface CodexMaterializedThreadRequestSettings {
  readonly config: Readonly<Record<string, unknown>>;
  readonly personality: CodexPersonality;
  readonly developerInstructions: string | null;
}

export interface CodexThreadRequestSettingsInput {
  readonly hostId: string;
  readonly cwd: string;
  readonly appServerVersion?: string | null;
  readonly threadId?: string | null;
  readonly includeDeveloperInstructions: boolean;
  readonly baseInstructions?: string | null;
  readonly additionalDeveloperInstructions?: string | null;
  readonly heartbeatEnabled?: boolean;
  readonly isNonGitWorkspace?: boolean;
  readonly sidebarSectionToolsEnabled?: boolean;
  readonly requestOptions?: CodexGatewayRequestOptions;
}

export interface CodexDesktopDeveloperInstructionsInput {
  readonly hostId: string;
  readonly cwd: string;
  readonly isNonGitWorkspace?: boolean;
  readonly requestOptions?: CodexGatewayRequestOptions;
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const readNonGitWorkspace = (
  input: {
    readonly hostId: string;
    readonly cwd: string;
    readonly isNonGitWorkspace?: boolean;
  },
  gitProbe: CodexGitProbe["Service"],
): Effect.Effect<boolean> =>
  input.isNonGitWorkspace !== undefined
    ? Effect.succeed(input.isNonGitWorkspace)
    : gitProbe.isNonGitWorkspaceOnHost(input.hostId, input.cwd);

/**
 * Workspace dependencies is an app-server experimental capability. Query the
 * target host directly instead of duplicating the answer in Desktop policy.
 */
const readWorkspaceDependenciesEnabled = (
  hostId: string,
  gateway: CodexGateway["Service"],
  requestOptions?: CodexGatewayRequestOptions,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const enabledExit = yield* Effect.exit(
      Effect.suspend(() =>
        Effect.gen(function* () {
          let cursor: string | null = null;
          do {
            const response: ClientRequestResponsesByMethod["experimentalFeature/list"] =
              yield* gateway.requestOnHost(
                hostId,
                "experimentalFeature/list",
                { cursor, limit: 100 },
                requestOptions,
              );
            if (
              response.data.some(
                (feature) => feature.name === "workspace_dependencies" && feature.enabled,
              )
            ) {
              return true;
            }
            cursor = response.nextCursor ?? null;
          } while (cursor !== null);
          return false;
        }),
      ),
    );
    return Exit.isSuccess(enabledExit) ? enabledExit.value : false;
  });

/** Mirrors the desktop developer-instructions request used by side conversations. */
export const materializeCodexDesktopDeveloperInstructions = (
  input: CodexDesktopDeveloperInstructionsInput,
  applicationSettings: ApplicationSettings["Service"],
  gateway: CodexGateway["Service"],
  gitProbe: CodexGitProbe["Service"],
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const settings = yield* applicationSettings.snapshot().pipe(Effect.orElseSucceed(() => null));
    if (!settings) return null;

    const workspaceDependenciesEnabled = yield* readWorkspaceDependenciesEnabled(
      input.hostId,
      gateway,
      input.requestOptions,
    );
    const isNonGitWorkspace = yield* readNonGitWorkspace(input, gitProbe);
    const developerInstructions = buildCodexDesktopDeveloperInstructions({
      gitSettings: settings.git,
      isNonGitWorkspace,
      workspaceDependenciesEnabled,
      includeProseDetailLevelInstructions: settings.developer.detailLevel === "STEPS_PROSE",
    });
    return developerInstructions.trim() || null;
  });

/** Materializes product-owned Desktop defaults plus target-host capabilities. */
export const materializeCodexThreadRequestSettings = (
  input: CodexThreadRequestSettingsInput,
  applicationSettings: ApplicationSettings["Service"],
  gateway: CodexGateway["Service"],
  gitProbe: CodexGitProbe["Service"],
): Effect.Effect<CodexMaterializedThreadRequestSettings | null> =>
  Effect.gen(function* () {
    const [settings, configExit] = yield* Effect.all([
      applicationSettings.snapshot().pipe(Effect.orElseSucceed(() => null)),
      Effect.exit(
        Effect.suspend(() =>
          gateway.requestOnHost(
            input.hostId,
            "config/read",
            { cwd: input.cwd, includeLayers: false },
            input.requestOptions,
          ),
        ),
      ),
    ]);
    if (!settings) return null;

    const hostConfig = Exit.isSuccess(configExit) ? asRecord(configExit.value.config) : null;
    const personality =
      parseCodexPersonality(hostConfig?.personality) ??
      parseCodexPersonality(hostConfig?.model_personality) ??
      "friendly";
    const config = buildCodexDesktopThreadFeatureConfig(input.appServerVersion);

    if (!input.includeDeveloperInstructions) {
      return {
        config,
        personality,
        developerInstructions: input.additionalDeveloperInstructions?.trim() || null,
      };
    }

    const includeProseDetailLevelInstructions = settings.developer.detailLevel === "STEPS_PROSE";
    const workspaceDependenciesEnabled = yield* readWorkspaceDependenciesEnabled(
      input.hostId,
      gateway,
      input.requestOptions,
    );
    const isNonGitWorkspace = yield* readNonGitWorkspace(input, gitProbe);
    const developerInstructions = buildCodexThreadDeveloperInstructions({
      baseInstructions: input.baseInstructions,
      gitSettings: settings.git,
      heartbeatEnabled: input.heartbeatEnabled,
      isNonGitWorkspace,
      sidebarSectionToolsEnabled: input.sidebarSectionToolsEnabled ?? true,
      threadToolsEnabled: true,
      workspaceDependenciesEnabled,
      includeProseDetailLevelInstructions,
      writingBlockInstructions: includeProseDetailLevelInstructions,
      additionalDeveloperInstructions: input.additionalDeveloperInstructions,
    });
    return {
      config,
      personality,
      developerInstructions: developerInstructions.trim() || null,
    };
  });
