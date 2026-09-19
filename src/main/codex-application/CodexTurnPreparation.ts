import { isReviewDiffCommentAttachment } from "../../shared/codex-canonical-item-projector";
import type { ConversationFollowerTurnStart } from "../../shared/codex-thread-follower-request";
import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import { latestAssignedConversationTurn } from "../../shared/codex-conversation-state/codex-turn-selectors";
import { resolveConversationTurnPermissions } from "../../shared/codex-conversation-state/codex-turn-permissions";
import type { CodexPreparedTurnExecution } from "../../shared/codex-conversation-state/codex-turn-execution";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { MainConfig } from "../app/MainConfig";
import { buildNodexCliBootstrap } from "../platform/node/NodexCliBootstrap";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { TurnStartParams } from "@nodex/codex-app-server-protocol/v2";
import type { CanonicalOwnerSteerInput } from "../../shared/codex-conversation-state/codex-owner-steer";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseAssetSource } from "../../shared/assets";
import {
  dedupeCodexLiveFileAttachments,
  isCodexLiveFileAttachment,
} from "../../shared/codex-live-file-attachments";
import { prepareCodexPrompt } from "../../shared/codex-prompt-preparation";
import {
  decodeCodexAsyncQuestionReplies,
  expandCodexAsyncQuestions,
} from "../../shared/codex-async-user-input";
import {
  parseCodexReasoningSummary,
  resolveCodexReasoningSummary,
} from "../../shared/codex-reasoning-summary-policy";
import type {
  CodexCanonicalWorktreeInitItem,
  CodexCanonicalLiveTurnParams,
  CodexCollaborationModeKind,
  CodexLiveFileAttachment,
  CodexPreparedPrompt,
  CodexPromptInput,
  CodexPromptTextAttachmentInput,
  CodexQueuedFollowUp,
  CodexReasoningEffort,
  CodexReviewDiffCommentAttachment,
  CodexServiceTier,
  CodexSteerTurnInput,
} from "../../shared/types";
import { CodexInputAssets } from "./CodexInputAssets";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { CODEX_APP_LOCAL_HOST_ID } from "../codex/codex-app-meta-thread-tools";
import { createCodexProjectlessWorkspace } from "../codex/codex-projectless-workspace";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import { isNodexAgentTurnReadOnly } from "../codex/nodex-agent-access";
import { buildTurnPermissionOverrides } from "../codex/codex-permission-resolver";
import {
  CodexAgentConfigRuntime,
  validateCodexAgentConfigPermissionDecision,
} from "./CodexAgentConfigRuntime";
import { CodexAttachments } from "./CodexAttachments";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexConversationContext } from "./CodexConversationContext";
import { CodexPermissions } from "./CodexPermissions";
import { CodexPreferences } from "./CodexPreferences";
import { parseCodexPersonality } from "./CodexPersonality";
import { CodexThreadSettingsRuntime } from "./CodexThreadSettingsRuntime";
import type { CodexTurnPresentationClaim } from "./CodexTurnPresentation";
import {
  resolveCodexPreparedWorkspaceKind,
  resolveExistingCodexProjectlessWorkspace,
  prepareCodexTurnWorkspace,
  prepareCodexTurnWorkspaceCommit,
  shouldMaterializeCodexProjectlessWorkspace,
  type CodexTurnWorkspaceCommit,
} from "./CodexTurnWorkspace";
import type { CodexConversationWorkspace } from "./CodexConversationContext";

/** Preserve explicit null effort and full collaboration settings across owner transfer. */
export function resolveNativeTurnExecutionSettings(
  request: TurnStartParams,
  inherited: {
    model: string | null;
    effort: CodexReasoningEffort | null;
    collaborationMode: TurnStartParams["collaborationMode"];
  },
): {
  model: string | null;
  effort: CodexReasoningEffort | null;
  collaborationMode: NonNullable<TurnStartParams["collaborationMode"]> | null;
} {
  const explicitCollaboration = request.collaborationMode != null;
  return {
    model: explicitCollaboration ? null : (request.model ?? inherited.model)?.trim() || null,
    effort: explicitCollaboration
      ? null
      : request.effort === undefined
        ? inherited.effort
        : request.effort,
    collaborationMode: request.collaborationMode ?? inherited.collaborationMode ?? null,
  };
}

export interface CodexTurnStartPlan extends CodexPreparedTurnExecution {
  readonly localMetadata?: unknown;
  readonly mcpAppModelContextAttachments?: unknown;
  readonly presentationClaim?: CodexTurnPresentationClaim;
  readonly threadId: string;
  readonly projectId: string | null;
  readonly request: TurnStartParams;
  readonly canonicalParams: CodexCanonicalLiveTurnParams<
    CodexLiveFileAttachment,
    CodexReviewDiffCommentAttachment
  > | null;
  readonly clientUserMessageId: string;
  readonly rendererOwnsState: boolean;
  readonly verifiedBuiltinFullAccess: boolean;
  readonly executionReadOnly: boolean;
  readonly promptText: string;
  readonly serviceName?: string | null;
  readonly pendingWorkspace: CodexConversationWorkspace | null;
  readonly workspaceCommit: CodexTurnWorkspaceCommit;
  readonly autoTitlePastedTextAttachments: readonly CodexPromptTextAttachmentInput[];
  readonly isFirstTurn: boolean;
  readonly skipAutoTitleGeneration: boolean;
  readonly startedAtMs: number;
  readonly worktreeInit?: CodexCanonicalWorktreeInitItem;
}

export class CodexTurnPreparationError extends Schema.TaggedError<CodexTurnPreparationError>()(
  "CodexTurnPreparationError",
  {
    operation: Schema.Literals(["start", "steer"]),
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface CodexTurnStartPreparationInput {
  /** Original peer request; inherited settings are resolved only at the executing owner. */
  readonly originalRequest?: TurnStartParams;
  readonly originalContext?: ConversationFollowerTurnStart["context"];
  readonly threadId: string;
  readonly prompt: string;
  readonly overrides?: {
    readonly presentationClaim?: CodexTurnPresentationClaim;
    readonly clientUserMessageId?: string;
    readonly preparedPrompt?: CodexPreparedPrompt;
    readonly promptInput?: CodexPromptInput;
    readonly model?: string | null;
    readonly serviceTier?: CodexServiceTier;
    readonly reasoningEffort?: CodexReasoningEffort | null;
    readonly collaborationMode?: CodexCollaborationModeKind | null;
    readonly summary?: TurnStartParams["summary"];
    readonly permissionMode?: import("../../shared/types").CodexPermissionMode;
    /** Preserves the content-origin safety check after new-task preflight consumes the atom. */
    readonly agentConfigPermissionMode?: boolean;
    readonly responsesapiClientMetadata?: TurnStartParams["responsesapiClientMetadata"];
    /** Title-only pasted sources that must not be inserted into the actual turn twice. */
    readonly autoTitlePastedTextAttachments?: readonly CodexPromptTextAttachmentInput[];
    readonly skipAutoTitleGeneration?: boolean;
    readonly worktreeInit?: CodexCanonicalWorktreeInitItem;
  };
  readonly rendererOwnsState: boolean;
}

export interface CodexTurnSteerPreparationInput {
  readonly command: CodexSteerTurnInput;
  readonly recoveryRow: CodexQueuedFollowUp;
}

export class CodexTurnPreparation extends Context.Service<
  CodexTurnPreparation,
  {
    readonly prepareCaptured: (
      threadId: string,
      submissionId: string,
      prompt: string,
      promptInput: CodexPromptInput,
    ) => Effect.Effect<CodexPreparedPrompt, CodexTurnPreparationError>;
    readonly start: (
      input: CodexTurnStartPreparationInput,
    ) => Effect.Effect<CodexTurnStartPlan, CodexTurnPreparationError>;
    readonly steer: (
      input: CodexTurnSteerPreparationInput,
    ) => Effect.Effect<CanonicalOwnerSteerInput, CodexTurnPreparationError>;
  }
>()("nodex/main/codex-application/CodexTurnPreparation") {}

const normalizeText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const imageInput = (
  source: string,
  resolveAssetPath: (fileName: string) => string,
): TurnStartParams["input"][number] => {
  const normalized = source.trim();
  if (
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("data:image/")
  ) {
    return { type: "image", url: normalized };
  }
  const asset = parseAssetSource(normalized);
  if (asset) return { type: "localImage", path: resolveAssetPath(asset.fileName) };
  if (path.isAbsolute(normalized)) return { type: "localImage", path: normalized };
  throw new Error(`Unsupported image source: ${normalized}`);
};

const collaborationMode = (input: {
  readonly mode?: CodexCollaborationModeKind | null;
  readonly model?: string | null;
  readonly effort?: CodexReasoningEffort | null;
}): NonNullable<TurnStartParams["collaborationMode"]> | null => {
  const model = normalizeText(input.model);
  if (!input.mode || !model) return null;
  return {
    mode: input.mode,
    settings: {
      model,
      reasoning_effort: input.effort ?? null,
      developer_instructions: null,
    },
  };
};

/** Native values remain unchanged; only an absent override inherits a retained tier. */
export function projectCodexTurnServiceTier(
  overrides: CodexTurnStartPreparationInput["overrides"],
  inheritedServiceTier: unknown,
): Pick<TurnStartParams, "serviceTier"> {
  if (overrides?.serviceTier !== undefined) {
    return { serviceTier: overrides.serviceTier };
  }
  return { serviceTier: typeof inheritedServiceTier === "string" ? inheritedServiceTier : null };
}

export const make: Effect.Effect<
  CodexTurnPreparation["Service"],
  never,
  | MainConfig
  | CoreAuthority
  | CodexAgentConfigRuntime
  | CodexAttachments
  | CodexConversationContext
  | CodexConversationProjection
  | CodexPermissions
  | CodexPreferences
  | CodexThreadSettingsRuntime
  | TemporaryAssets
  | CodexInputAssets
  | CodexThreadHostResolver
  | CodexGateway
> = Effect.gen(function* () {
  const config = yield* MainConfig;
  const coreAuthority = yield* CoreAuthority;
  const agentConfig = yield* CodexAgentConfigRuntime;
  const attachments = yield* CodexAttachments;
  const conversationContext = yield* CodexConversationContext;
  const projection = yield* CodexConversationProjection;
  const permissions = yield* CodexPermissions;
  const preferences = yield* CodexPreferences;
  const threadSettings = yield* CodexThreadSettingsRuntime;
  const assets = yield* TemporaryAssets;
  const inputAssets = yield* CodexInputAssets;
  const hosts = yield* CodexThreadHostResolver;
  const gateway = yield* CodexGateway;

  const preparePrompt = Effect.fn("CodexTurnPreparation.preparePrompt")(function* (
    prompt: string,
    promptInput: CodexPromptInput | undefined,
    preparedInput?: CodexPreparedPrompt,
  ) {
    const prepared = preparedInput
      ? preparedInput
      : yield* Effect.tryPromise(() =>
          prepareCodexPrompt(prompt, promptInput, {
            resolveImageInput: (source) => imageInput(source, assets.resolveAssetPath),
          }),
        );
    const pasted = yield* Effect.forEach(prepared.pastedTextAttachments, (attachment) =>
      "text" in attachment
        ? Effect.succeed(attachment.text)
        : attachments.readPastedText(attachment.file),
    );
    const pastedItems = pasted.flatMap((text) =>
      text.trim() ? [{ type: "text" as const, text, text_elements: [] }] : [],
    );
    const first = prepared.inputItems[0];
    const insertionIndex = first?.type === "text" && first.text === prepared.promptText ? 1 : 0;
    return {
      ...prepared,
      inputItems: [
        ...prepared.inputItems.slice(0, insertionIndex),
        ...pastedItems,
        ...prepared.inputItems.slice(insertionIndex),
      ],
    };
  });

  const start: CodexTurnPreparation["Service"]["start"] = (input) =>
    Effect.gen(function* () {
      yield* threadSettings.awaitCurrent(input.threadId);
      let prepared: CodexPreparedPrompt = yield* preparePrompt(
        input.prompt,
        input.overrides?.promptInput,
        input.overrides?.preparedPrompt,
      );
      const liveContext = yield* conversationContext.read(input.threadId);
      const projectId = liveContext.projectId;
      const state = yield* projection.read(input.threadId);
      const executionHostId = yield* hosts.resolve(input.threadId);
      const environment = liveContext.environments?.[0];
      const preparedWorkspace = prepareCodexTurnWorkspace({
        conversationCwd: liveContext.conversationCwd ?? liveContext.cwd,
        requestCwd: input.originalRequest?.cwd,
        environment,
        currentPermissionRoots: state.canonical.currentPermissions?.runtimeWorkspaceRoots,
        state: liveContext.workspaceState ?? null,
      });
      const currentWorkspaceKind =
        state.canonical.workspaceKind ?? (projectId === null ? "projectless" : "project");
      const shouldMaterializeProjectless =
        executionHostId === CODEX_APP_LOCAL_HOST_ID &&
        shouldMaterializeCodexProjectlessWorkspace({
          environmentCwd: environment?.cwd ?? null,
          hasPendingWorkspace: preparedWorkspace.pendingWorkspace !== null,
          state: liveContext.workspaceState ?? null,
          stateProjectId: projectId,
          isProjectlessConversation: projectId === null,
          workspaceKind: currentWorkspaceKind,
        });
      let projectlessWorkspace = shouldMaterializeProjectless
        ? resolveExistingCodexProjectlessWorkspace({
            cwd: state.canonical.cwd ?? liveContext.conversationCwd ?? liveContext.cwd,
            retainedWritableRoots: liveContext.writableRoots,
            workspaceKind: currentWorkspaceKind,
            workspaceBrowserRoot:
              state.canonical.workspaceBrowserRoot ??
              state.snapshot?.projectlessWorkspaceBrowserRoot ??
              null,
          })
        : null;
      if (shouldMaterializeProjectless && projectlessWorkspace === null) {
        const created = yield* Effect.tryPromise(() =>
          createCodexProjectlessWorkspace({
            createSplitDirectories: true,
            prompt: prepared.promptText,
          }),
        );
        projectlessWorkspace = {
          cwd: created.cwd,
          workspaceRoot: created.workspaceRoot,
        };
      }
      const workspaceKind = resolveCodexPreparedWorkspaceKind({
        currentWorkspaceKind,
        hasPendingWorkspace: preparedWorkspace.pendingWorkspace !== null,
        hasProjectlessWorkspace: projectlessWorkspace !== null,
        state: liveContext.workspaceState ?? null,
        stateProjectId: projectId,
      });
      const workspaceBrowserRoot =
        workspaceKind === "projectless"
          ? (projectlessWorkspace?.workspaceRoot ??
            state.canonical.workspaceBrowserRoot ??
            state.snapshot?.projectlessWorkspaceBrowserRoot ??
            null)
          : null;
      const cwd =
        environment?.cwd ??
        preparedWorkspace.pendingWorkspace?.cwd ??
        projectlessWorkspace?.cwd ??
        preparedWorkspace.cwd;
      const workspaceRoots = projectlessWorkspace
        ? [...new Set([...liveContext.writableRoots, projectlessWorkspace.workspaceRoot])]
        : [...liveContext.writableRoots];
      const permissionContextRoots =
        preparedWorkspace.pendingWorkspace?.runtimeWorkspaceRoots ?? workspaceRoots;
      const preparedAgentConfig = yield* agentConfig.prepare({
        target: { kind: "existing-thread", threadId: input.threadId },
        configs: prepared.agentConfigs,
        permissionContext: { projectId, workspaceRoots: permissionContextRoots },
      });
      const settings = state.canonical.latestThreadSettings;
      const hydration = state.canonical.hydrationContext;
      const hydratedSettings = hydration?.latestThreadSettings ?? null;
      const originalRequest = input.originalRequest;
      const inheritThreadSettings = input.originalContext?.inheritThreadSettings !== false;
      const nextSettings = inheritThreadSettings ? (settings ?? hydratedSettings) : null;
      const inheritedParams = inheritThreadSettings
        ? latestAssignedConversationTurn(state.canonical)?.params
        : null;
      const requestedPermissionMode =
        preparedAgentConfig.permissionMode ?? input.overrides?.permissionMode;
      const permission =
        preparedAgentConfig.permissionDecision ??
        (yield* permissions.resolve({
          projectId,
          requestedMode: requestedPermissionMode,
          workspaceRoots,
        }));
      if (input.overrides?.agentConfigPermissionMode && requestedPermissionMode) {
        yield* Effect.try(() =>
          validateCodexAgentConfigPermissionDecision(requestedPermissionMode, permission),
        );
      }
      const turnPermissions = buildTurnPermissionOverrides({
        permissionState: permission.state,
        workspaceRoots,
      });
      const fallbackCollaboration = inheritThreadSettings
        ? (nextSettings?.collaborationMode ?? state.canonical.latestCollaborationMode)
        : null;
      const model = normalizeText(
        preparedAgentConfig.executionProfile?.modelId ??
          input.overrides?.model ??
          nextSettings?.model ??
          (inheritThreadSettings ? state.canonical.latestModel : null),
      );
      const inheritedEffort =
        nextSettings?.effort === undefined
          ? inheritThreadSettings
            ? state.canonical.latestReasoningEffort
            : null
          : nextSettings.effort;
      const effort =
        preparedAgentConfig.executionProfile?.reasoningEffort !== undefined
          ? preparedAgentConfig.executionProfile.reasoningEffort
          : input.overrides?.reasoningEffort !== undefined
            ? input.overrides.reasoningEffort
            : inheritedEffort;
      const mode =
        preparedAgentConfig.collaborationMode ?? input.overrides?.collaborationMode ?? null;
      // A resolved Project mode is only a fallback. Caller permission fields and
      // explicit default intent must survive the receiving owner's materialization.
      const explicitPermissions =
        requestedPermissionMode === undefined
          ? {}
          : requestedPermissionMode === "custom"
            ? {
                approvalPolicy: permission.state.approvalPolicy,
                approvalsReviewer: permission.state.approvalsReviewer,
                sandboxPolicy: permission.state.sandbox,
              }
            : turnPermissions;
      const resolvedPermissions = yield* Effect.try({
        try: () =>
          resolveConversationTurnPermissions({
            state: state.canonical,
            request: {
              ...explicitPermissions,
              ...originalRequest,
              ...(environment?.runtimeWorkspaceRoots == null
                ? {}
                : { runtimeWorkspaceRoots: environment.runtimeWorkspaceRoots }),
            },
            context: input.originalContext,
            cwd,
            writableRoots: workspaceRoots,
            workspaceKind,
            workspaceBrowserRoot,
            workspaceTransition: preparedWorkspace.permissionTransition,
          }),
        catch: (cause) =>
          new CodexTurnPreparationError({ operation: "start", threadId: input.threadId, cause }),
      });
      const canonicalPermissions = resolvedPermissions.permissions;
      const workspaceCommit = prepareCodexTurnWorkspaceCommit({
        state: liveContext.workspaceState ?? null,
        pendingWorkspace: preparedWorkspace.pendingWorkspace,
        pendingRevision: preparedWorkspace.pendingRevision,
        roots: resolvedPermissions.workspaceCommitRoots,
        retainedWritableRoots: workspaceRoots,
        cwd,
        conversationCwd: liveContext.conversationCwd ?? liveContext.cwd,
      });
      const preparedEnvironments = liveContext.environments?.map((candidate, index) =>
        index === 0 && resolvedPermissions.params.runtimeWorkspaceRoots != null
          ? {
              ...candidate,
              runtimeWorkspaceRoots: [...resolvedPermissions.params.runtimeWorkspaceRoots],
            }
          : candidate,
      );
      const hasSelectedEnvironment = (preparedEnvironments?.length ?? 0) > 0;
      const verifiedBuiltinFullAccess =
        permission.verifiedBuiltinFullAccess &&
        canonicalPermissions.sandboxPolicy.type === "dangerFullAccess" &&
        (canonicalPermissions.activePermissionProfile?.id === ":danger-full-access" ||
          (requestedPermissionMode === "full-access" &&
            canonicalPermissions.activePermissionProfile === null &&
            !resolvedPermissions.params.useAppServerPermissionDefault));
      const sourceAttachments = input.originalContext?.attachments;
      const sourceComments = input.originalContext?.commentAttachments;
      if (
        sourceAttachments !== undefined &&
        (!Array.isArray(sourceAttachments) || !sourceAttachments.every(isCodexLiveFileAttachment))
      )
        return yield* Effect.fail(
          new CodexTurnPreparationError({
            operation: "start",
            threadId: input.threadId,
            cause: new Error("Invalid turn attachment context"),
          }),
        );
      if (
        sourceComments !== undefined &&
        (!Array.isArray(sourceComments) || !sourceComments.every(isReviewDiffCommentAttachment))
      )
        return yield* Effect.fail(
          new CodexTurnPreparationError({
            operation: "start",
            threadId: input.threadId,
            cause: new Error("Invalid turn comment context"),
          }),
        );
      const nativeSettings = resolveNativeTurnExecutionSettings(
        originalRequest ?? { threadId: input.threadId, input: [] },
        {
          model,
          effort,
          collaborationMode: mode
            ? collaborationMode({ mode, model, effort })
            : fallbackCollaboration,
        },
      );
      const selectedCollaborationMode = nativeSettings.collaborationMode;
      const explicitSummary =
        input.overrides && Object.hasOwn(input.overrides, "summary")
          ? parseCodexReasoningSummary(input.overrides.summary)
          : undefined;
      const summary = resolveCodexReasoningSummary({
        inheritedSummary: inheritedParams?.summary,
        configuredSummary: nextSettings?.summary,
        explicitSummary:
          originalRequest?.summary !== undefined ? originalRequest.summary : explicitSummary,
      });
      const selectedPersonality =
        originalRequest?.personality !== undefined
          ? originalRequest.personality
          : nextSettings?.personality !== undefined
            ? nextSettings.personality
            : (inheritedParams?.personality ?? undefined);
      const defaultPersonality = preferences.current();
      const personality =
        selectedPersonality !== undefined
          ? selectedPersonality
          : yield* gateway
              .requestForThread(
                input.threadId,
                "config/read",
                { cwd, includeLayers: false },
                { priority: "critical" },
              )
              .pipe(
                Effect.map(
                  (response) =>
                    parseCodexPersonality(response.config.personality) ??
                    parseCodexPersonality(response.config.model_personality),
                ),
                Effect.catch(() => Effect.succeed(null)),
                Effect.map((configured) => configured ?? defaultPersonality),
              );
      const inheritedTier =
        nextSettings?.serviceTier === undefined
          ? inheritedParams?.serviceTier
          : nextSettings.serviceTier;
      const serviceTierRequest = preparedAgentConfig.executionProfile
        ? projectCodexTurnServiceTier(
            { serviceTier: preparedAgentConfig.executionProfile.serviceTier },
            inheritedTier,
          )
        : projectCodexTurnServiceTier(
            originalRequest?.serviceTier !== undefined
              ? { serviceTier: originalRequest.serviceTier }
              : input.overrides,
            inheritedTier,
          );
      const requestedServiceTier = serviceTierRequest.serviceTier;
      const serviceTier =
        requestedServiceTier == null
          ? null
          : yield* gateway
              .requestForThread(input.threadId, "configRequirements/read", undefined, {
                priority: "critical",
                timeoutMs: 30_000,
              })
              .pipe(
                Effect.map((response) =>
                  response.requirements?.featureRequirements?.fast_mode === false
                    ? null
                    : requestedServiceTier,
                ),
                Effect.catch((error) =>
                  Effect.logWarning(
                    "Failed to load config requirements for service tier",
                    error,
                  ).pipe(Effect.as(null)),
                ),
              );
      const clientUserMessageId = input.overrides?.clientUserMessageId ?? randomUUID();
      prepared = yield* inputAssets.retainPrepared(
        input.threadId,
        clientUserMessageId,
        prepared,
        executionHostId === CODEX_APP_LOCAL_HOST_ID,
      );
      const cliBootstrap = yield* buildNodexCliBootstrap(config, coreAuthority.identity, {
        threadId: input.threadId,
        hostId: executionHostId,
        projectId,
        verifiedBuiltinFullAccess,
        sandboxPolicy: canonicalPermissions.sandboxPolicy,
        planMode: (selectedCollaborationMode ?? fallbackCollaboration)?.mode === "plan",
      });
      const additionalContext = {
        ...prepared.additionalContext,
        ...originalRequest?.additionalContext,
        "nodex-cli": cliBootstrap,
      };
      const responsesapiClientMetadata = input.overrides?.responsesapiClientMetadata
        ? {
            ...originalRequest?.responsesapiClientMetadata,
            ...input.overrides.responsesapiClientMetadata,
          }
        : originalRequest?.responsesapiClientMetadata;
      const request: TurnStartParams = {
        threadId: input.threadId,
        clientUserMessageId,
        ...(hasSelectedEnvironment ? { cwd: null } : cwd ? { cwd } : {}),
        additionalContext,
        ...resolvedPermissions.request,
        environments: preparedEnvironments,
        runtimeWorkspaceRoots: hasSelectedEnvironment
          ? null
          : resolvedPermissions.request.runtimeWorkspaceRoots,
        model: nativeSettings.model,
        effort: nativeSettings.effort,
        serviceTier,
        summary,
        personality,
        collaborationMode: selectedCollaborationMode,
        multiAgentMode: "explicitRequestOnly",
        outputSchema: originalRequest?.outputSchema ?? null,
        responsesapiClientMetadata: {
          ...responsesapiClientMetadata,
          workspace_kind: workspaceKind,
        },
        ...(originalRequest
          ? {
              ...(originalRequest.turnTrigger === undefined
                ? {}
                : { turnTrigger: originalRequest.turnTrigger }),
              ...(originalRequest.toolOutput === undefined
                ? {}
                : { toolOutput: originalRequest.toolOutput }),
              ...(originalRequest.cyberAccessProgram === undefined
                ? {}
                : { cyberAccessProgram: originalRequest.cyberAccessProgram }),
            }
          : {}),
        input: prepared.inputItems,
      };
      const canonicalRequired = canonicalPermissions
        ? ({
            cwd,
            approvalPolicy: resolvedPermissions.params.approvalPolicy,
            approvalsReviewer: resolvedPermissions.params.approvalsReviewer,
            model: nativeSettings.model,
            effort: nativeSettings.effort,
            summary,
            personality,
            outputSchema: originalRequest?.outputSchema ?? null,
            collaborationMode: selectedCollaborationMode,
          } satisfies Required<
            Pick<
              TurnStartParams,
              | "cwd"
              | "approvalPolicy"
              | "approvalsReviewer"
              | "model"
              | "effort"
              | "summary"
              | "personality"
              | "outputSchema"
              | "collaborationMode"
            >
          >)
        : null;
      const canonicalParams: CodexTurnStartPlan["canonicalParams"] = canonicalRequired
        ? {
            threadId: input.threadId,
            clientUserMessageId,
            input: prepared.inputItems,
            additionalContext,
            ...(responsesapiClientMetadata !== undefined ? { responsesapiClientMetadata } : {}),
            ...(originalRequest
              ? {
                  turnTrigger: originalRequest.turnTrigger,
                  toolOutput: originalRequest.toolOutput,
                  cyberAccessProgram: originalRequest.cyberAccessProgram,
                }
              : {}),
            ...canonicalRequired,
            sandboxPolicy: resolvedPermissions.params.sandboxPolicy,
            permissions: resolvedPermissions.params.permissions,
            runtimeWorkspaceRoots: resolvedPermissions.params.runtimeWorkspaceRoots,
            useAppServerPermissionDefault: resolvedPermissions.params.useAppServerPermissionDefault,
            serviceTier,
            multiAgentMode: "explicitRequestOnly",
            attachments:
              sourceAttachments ??
              dedupeCodexLiveFileAttachments([...prepared.fileAttachments, ...prepared.addedFiles]),
            commentAttachments: sourceComments ?? [...prepared.commentAttachments],
          }
        : null;
      const effectiveCollaborationMode = selectedCollaborationMode ??
        fallbackCollaboration ?? {
          mode: "default" as const,
          settings: {
            model: model ?? "",
            reasoning_effort: effort,
            developer_instructions: null,
          },
        };
      const startedAtMs = yield* Clock.currentTimeMillis;
      return {
        ...(input.overrides?.presentationClaim
          ? { presentationClaim: input.overrides.presentationClaim }
          : {}),
        threadId: input.threadId,
        projectId,
        request,
        canonicalParams,
        localMetadata: input.originalContext?.localTurnMetadata,
        mcpAppModelContextAttachments: input.originalContext?.mcpAppModelContextAttachments,
        model: nativeSettings.model,
        reasoningEffort: nativeSettings.effort,
        shouldUpdateReasoningEffort:
          originalRequest?.effort !== undefined ||
          input.overrides?.reasoningEffort !== undefined ||
          preparedAgentConfig.executionProfile?.reasoningEffort !== undefined ||
          nextSettings !== null,
        collaborationMode: selectedCollaborationMode,
        permissions: canonicalPermissions,
        previousPermissions: state.canonical.currentPermissions,
        environments: preparedEnvironments,
        environmentSelectionEvidence: liveContext.environmentSelectionEvidence,
        workspaceKind,
        projectlessWorkspace,
        clientUserMessageId,
        rendererOwnsState: input.rendererOwnsState,
        verifiedBuiltinFullAccess,
        executionReadOnly: isNodexAgentTurnReadOnly({
          planMode: effectiveCollaborationMode.mode === "plan",
          sandboxPolicy: canonicalPermissions.sandboxPolicy,
        }),
        promptText: prepared.promptText,
        serviceName: state.snapshot?.serviceName ?? null,
        pendingWorkspace: preparedWorkspace.pendingWorkspace,
        workspaceCommit,
        autoTitlePastedTextAttachments: [
          ...(input.overrides?.autoTitlePastedTextAttachments ?? prepared.pastedTextAttachments),
        ],
        // Metadata-only resumes intentionally have no resident turns. Their non-empty preview is
        // the durable signal that this is a follow-up, not a fresh first-turn title callback.
        isFirstTurn:
          residentConversationTurns(state.canonical).length === 0 &&
          (state.snapshot?.threadPreview.trim().length ?? 0) === 0,
        skipAutoTitleGeneration: input.overrides?.skipAutoTitleGeneration === true,
        startedAtMs,
        ...(input.overrides?.worktreeInit ? { worktreeInit: input.overrides.worktreeInit } : {}),
      } satisfies CodexTurnStartPlan;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof CodexTurnPreparationError
          ? cause
          : new CodexTurnPreparationError({
              operation: "start",
              threadId: input.threadId,
              cause,
            }),
      ),
      Effect.withSpan("CodexTurnPreparation.start", {
        attributes: { threadId: input.threadId },
      }),
    );

  const steer: CodexTurnPreparation["Service"]["steer"] = (input) =>
    Effect.gen(function* () {
      const threadId = input.command.threadId;
      let prepared: CodexPreparedPrompt = yield* preparePrompt(
        input.command.prompt,
        input.command.promptInput,
      );
      const fail = (cause: unknown) =>
        Effect.fail(new CodexTurnPreparationError({ operation: "steer", threadId, cause }));
      if (prepared.agentConfigs.length > 0) {
        return yield* fail(new Error("Agent config cannot be steered into a running turn"));
      }
      if (!prepared.promptText.trim())
        return yield* fail(new Error("Turn steer requires a non-empty prompt"));
      if (
        input.recoveryRow.threadId !== threadId ||
        input.recoveryRow.prompt !== input.command.prompt ||
        !input.recoveryRow.followUpId.trim() ||
        !input.recoveryRow.clientUserMessageId.trim() ||
        input.recoveryRow.pause !== null
      ) {
        return yield* fail(new Error("Turn steer recovery identity is invalid"));
      }
      const questionReplies = decodeCodexAsyncQuestionReplies(input.command.prompt);
      if (questionReplies) {
        const state = yield* projection.read(threadId);
        const activeTurn = residentConversationTurns(state.canonical).find(
          (turn) => turn.turnId === input.command.expectedTurnId,
        );
        const questionIds = new Set(
          activeTurn?.items.flatMap(expandCodexAsyncQuestions).map((question) => question.id),
        );
        if (
          !input.command.expectedTurnId ||
          activeTurn?.status !== "inProgress" ||
          questionReplies.some((reply) => !questionIds.has(reply.questionItemId))
        )
          return yield* fail(new Error("The question's Turn is no longer available to answer"));
      }
      prepared = yield* inputAssets.retainPrepared(
        threadId,
        input.recoveryRow.clientUserMessageId,
        prepared,
        (yield* hosts.resolve(threadId)) === CODEX_APP_LOCAL_HOST_ID,
      );
      // The executing owner selects the active Turn after routing and waits for its native ID.
      return {
        conversationId: threadId,
        clientUserMessageId: input.recoveryRow.clientUserMessageId,
        input: prepared.inputItems,
        ...(prepared.additionalContext ? { additionalContext: prepared.additionalContext } : {}),
        ...(input.command.serviceTier !== undefined
          ? { serviceTier: input.command.serviceTier }
          : {}),
        attachments: dedupeCodexLiveFileAttachments([
          ...prepared.fileAttachments,
          ...prepared.addedFiles,
        ]),
        restoreMessage: {
          queueRow: input.recoveryRow,
          context: { commentAttachments: [...prepared.commentAttachments] },
        },
      } satisfies CanonicalOwnerSteerInput;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof CodexTurnPreparationError
          ? cause
          : new CodexTurnPreparationError({
              operation: "steer",
              threadId: input.command.threadId,
              cause,
            }),
      ),
      Effect.withSpan("CodexTurnPreparation.steer", {
        attributes: { threadId: input.command.threadId },
      }),
    );

  return CodexTurnPreparation.of({
    start,
    steer,
    prepareCaptured: (threadId, submissionId, prompt, promptInput) =>
      Effect.gen(function* () {
        const prepared = yield* preparePrompt(prompt, promptInput);
        return yield* inputAssets.retainPrepared(
          threadId,
          submissionId,
          prepared,
          (yield* hosts.resolve(threadId)) === CODEX_APP_LOCAL_HOST_ID,
        );
      }).pipe(
        Effect.mapError(
          (cause) => new CodexTurnPreparationError({ operation: "start", threadId, cause }),
        ),
      ),
  });
});
