import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import type { CodexPersonality } from "../../shared/types";
import {
  buildCodexDesktopDeveloperInstructions,
  buildCodexThreadDeveloperInstructions,
} from "../codex/codex-developer-instructions";
import { CodexGateway, type CodexGatewayRequestOptions } from "../codex-runtime/CodexGateway";
import {
  CodexExecutionAssignments,
  type CodexExecutionThreadSettings,
} from "./CodexExecutionAssignments";
import { CodexGitProbe } from "./CodexGitProbe";
import { parseCodexPersonality } from "./CodexPersonality";

export interface CodexMaterializedThreadRequestSettings extends CodexExecutionThreadSettings {
  readonly personality: CodexPersonality;
  readonly developerInstructions: string | null;
}

export interface CodexThreadRequestSettingsInput {
  readonly hostId: string;
  readonly appServerVersion?: string | null;
  readonly model?: string | null;
  readonly cwd: string;
  readonly threadId?: string | null;
  readonly includeDeveloperInstructions: boolean;
  readonly allowMemoryPromptOverrides?: boolean;
  readonly baseInstructions?: string | null;
  readonly additionalDeveloperInstructions?: string | null;
  readonly mode?: string | null;
  readonly threadStartKind?: string | null;
  readonly heartbeatEnabled?: boolean;
  readonly isNonGitWorkspace?: boolean;
  readonly sidebarSectionToolsEnabled?: boolean;
  readonly requestOptions?: CodexGatewayRequestOptions;
}

export interface CodexDesktopDeveloperInstructionsInput {
  readonly hostId: string;
  readonly appServerVersion?: string | null;
  readonly model?: string | null;
  readonly cwd: string;
  readonly allowMemoryPromptOverrides?: boolean;
  readonly isNonGitWorkspace?: boolean;
  readonly requestOptions?: CodexGatewayRequestOptions;
}

interface WorkspaceDependenciesCacheEntry {
  readonly assignmentKey: string;
  readonly enabled: boolean;
}

const workspaceDependenciesCache = new WeakMap<
  CodexGateway["Service"],
  Map<string, WorkspaceDependenciesCacheEntry>
>();

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const executionAssignmentCacheKey = (features: Readonly<Record<string, unknown>>): string =>
  JSON.stringify(Object.entries(features).sort(([left], [right]) => left.localeCompare(right)));

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

/** Desktop asks app-server for the effective experimental feature instead of trusting Statsig alone. */
const readWorkspaceDependenciesEnabled = (
  hostId: string,
  assignmentKey: string,
  gateway: CodexGateway["Service"],
  requestOptions?: CodexGatewayRequestOptions,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    let hostCache = workspaceDependenciesCache.get(gateway);
    if (!hostCache) {
      hostCache = new Map();
      workspaceDependenciesCache.set(gateway, hostCache);
    }
    const cached = hostCache.get(hostId);
    if (cached?.assignmentKey === assignmentKey) {
      return cached.enabled;
    }

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
    const enabled = Exit.isSuccess(enabledExit) ? enabledExit.value : false;

    hostCache.set(hostId, { assignmentKey, enabled });
    return enabled;
  });

/** Mirrors the desktop `developer-instructions` host request used by side conversations. */
export const materializeCodexDesktopDeveloperInstructions = (
  input: CodexDesktopDeveloperInstructionsInput,
  executionAssignments: CodexExecutionAssignments["Service"],
  gateway: CodexGateway["Service"],
  gitProbe: CodexGitProbe["Service"],
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const settings = yield* executionAssignments.readThreadSettings({
      appServerVersion: input.appServerVersion,
      model: input.model,
      includeDeveloperInstructions: true,
      allowMemoryPromptOverrides: input.allowMemoryPromptOverrides,
    });
    if (!settings) return null;

    const workspaceDependenciesEnabled = yield* readWorkspaceDependenciesEnabled(
      input.hostId,
      executionAssignmentCacheKey(settings.defaultEnableFeatures),
      gateway,
      input.requestOptions,
    );
    const isNonGitWorkspace = yield* readNonGitWorkspace(input, gitProbe);
    const developerInstructions = buildCodexDesktopDeveloperInstructions({
      gitSettings: settings.gitSettings,
      instructionOverrides: settings.instructionOverrides,
      isNonGitWorkspace,
      workspaceDependenciesEnabled,
      includeProseDetailLevelInstructions: settings.includeProseDetailLevelInstructions,
    });
    return developerInstructions.trim() || null;
  });

/** Materializes the experiment-backed settings that become physical thread start/resume fields. */
export const materializeCodexThreadRequestSettings = (
  input: CodexThreadRequestSettingsInput,
  executionAssignments: CodexExecutionAssignments["Service"],
  gateway: CodexGateway["Service"],
  gitProbe: CodexGitProbe["Service"],
): Effect.Effect<CodexMaterializedThreadRequestSettings | null> =>
  Effect.gen(function* () {
    const settings = yield* executionAssignments.readThreadSettings({
      appServerVersion: input.appServerVersion,
      model: input.model,
      includeDeveloperInstructions: input.includeDeveloperInstructions,
      allowMemoryPromptOverrides: input.allowMemoryPromptOverrides,
    });
    if (!settings) return null;

    const configExit = yield* Effect.exit(
      Effect.suspend(() =>
        gateway.requestOnHost(
          input.hostId,
          "config/read",
          { cwd: input.cwd, includeLayers: false },
          input.requestOptions,
        ),
      ),
    );
    const hostConfig = Exit.isSuccess(configExit) ? asRecord(configExit.value.config) : null;
    const personality =
      parseCodexPersonality(hostConfig?.personality) ??
      parseCodexPersonality(hostConfig?.model_personality) ??
      settings.defaultPersonality;

    if (!input.includeDeveloperInstructions) {
      return {
        ...settings,
        personality,
        developerInstructions: input.additionalDeveloperInstructions?.trim() || null,
      };
    }

    const automaticTitleCheckpoints =
      settings.automaticTitleCheckpoints &&
      (input.mode ?? "default") === "default" &&
      (input.threadStartKind ?? "default") === "default";
    const writingBlockInstructions =
      settings.writingBlocks && settings.includeProseDetailLevelInstructions;
    const workspaceDependenciesEnabled = yield* readWorkspaceDependenciesEnabled(
      input.hostId,
      executionAssignmentCacheKey(settings.defaultEnableFeatures),
      gateway,
      input.requestOptions,
    );
    const sidebarSectionToolsEnabled =
      input.sidebarSectionToolsEnabled ??
      (settings.identity.accountId !== null &&
        settings.values.toolCatalog.gates.sidebarCustomSections);
    const isNonGitWorkspace = yield* readNonGitWorkspace(input, gitProbe);
    const developerInstructions = buildCodexThreadDeveloperInstructions({
      baseInstructions: input.baseInstructions,
      gitSettings: settings.gitSettings,
      instructionOverrides: settings.instructionOverrides,
      heartbeatEnabled: input.heartbeatEnabled,
      isNonGitWorkspace,
      sidebarSectionToolsEnabled,
      threadToolsEnabled: settings.defaultEnableFeatures.thread_tools === true,
      workspaceDependenciesEnabled,
      includeProseDetailLevelInstructions: settings.includeProseDetailLevelInstructions,
      automaticTitleCheckpoints,
      writingBlockInstructions,
      presentationOutlineInstructions: settings.presentationOutlines,
      additionalDeveloperInstructions: input.additionalDeveloperInstructions,
    });
    return {
      ...settings,
      personality,
      developerInstructions: developerInstructions.trim() || null,
    };
  });

export const readCodexThreadRequestSettings = (
  input: CodexThreadRequestSettingsInput,
): Effect.Effect<
  CodexMaterializedThreadRequestSettings | null,
  never,
  CodexExecutionAssignments | CodexGateway | CodexGitProbe
> =>
  Effect.gen(function* () {
    const executionAssignments = yield* CodexExecutionAssignments;
    const gateway = yield* CodexGateway;
    const gitProbe = yield* CodexGitProbe;
    return yield* materializeCodexThreadRequestSettings(
      input,
      executionAssignments,
      gateway,
      gitProbe,
    );
  });
