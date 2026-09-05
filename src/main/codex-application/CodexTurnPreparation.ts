import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { TurnStartParams, TurnSteerParams } from "@nodex/codex-app-server-protocol/v2";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseAssetSource } from "../../shared/assets";
import { dedupeCodexLiveFileAttachments } from "../../shared/codex-live-file-attachments";
import { prepareCodexPrompt } from "../../shared/codex-prompt-preparation";
import {
  decodeCodexAsyncQuestionReplies,
  expandCodexAsyncQuestions,
} from "../../shared/codex-async-user-input";
import { normalizeCodexServiceTier } from "../../shared/codex-service-tier";
import {
  parseCodexReasoningSummary,
  resolveCodexReasoningSummary,
} from "../../shared/codex-reasoning-summary-policy";
import { buildCodexSteeringCompareKey } from "../../shared/codex-conversation-state/codex-steering-compare";
import type {
  CodexCanonicalWorktreeInitItem,
  CodexCanonicalLiveTurnParams,
  CodexCanonicalHydratedPermissionContext,
  CodexCollaborationModeKind,
  CodexConversationThreadSettings,
  CodexLiveFileAttachment,
  CodexPreparedPrompt,
  CodexPromptInput,
  CodexQueuedFollowUp,
  CodexReasoningEffort,
  CodexReviewDiffCommentAttachment,
  CodexServiceTier,
  CodexSteerTurnInput,
} from "../../shared/types";
import type { CodexCanonicalSteeringUserMessageItem } from "../../shared/codex-conversation-state/codex-conversation-state";
import { CodexInputAssets } from "./CodexInputAssets";
import { CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { CODEX_APP_LOCAL_HOST_ID } from "../codex/codex-app-meta-thread-tools";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import { buildTurnPermissionOverrides } from "../codex/codex-permission-resolver";
import {
  CodexAgentConfigRuntime,
  validateCodexAgentConfigPermissionDecision,
} from "./CodexAgentConfigRuntime";
import { CodexAttachments } from "./CodexAttachments";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexConversationContext } from "./CodexConversationContext";
import { CodexPermissions, resolveCanonicalPermissionContext } from "./CodexPermissions";
import { CodexPreferences } from "./CodexPreferences";
import { CodexThreadSettingsRuntime } from "./CodexThreadSettingsRuntime";

export interface CodexTurnStartPlan {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly request: TurnStartParams;
  readonly canonicalParams: CodexCanonicalLiveTurnParams<
    CodexLiveFileAttachment,
    CodexReviewDiffCommentAttachment
  > | null;
  readonly currentCollaborationModel: string;
  readonly settings: CodexConversationThreadSettings;
  readonly permissionContext: CodexCanonicalHydratedPermissionContext | null;
  readonly clientUserMessageId: string;
  readonly rendererOwnsState: boolean;
  readonly verifiedBuiltinFullAccess: boolean;
  readonly promptText: string;
  readonly startedAtMs: number;
  readonly worktreeInit?: CodexCanonicalWorktreeInitItem;
}

export interface CodexTurnSteerPlan {
  readonly threadId: string;
  readonly expectedTurnId: string;
  readonly steerId: string;
  readonly request: TurnSteerParams;
  readonly item: CodexCanonicalSteeringUserMessageItem;
  /** Question replies may correct the active Turn identity but cannot start new work. */
  readonly fallbackStart: {
    readonly prompt: string;
    readonly overrides: {
      readonly collaborationMode?: CodexCollaborationModeKind;
      readonly serviceTier?: CodexServiceTier;
      readonly summary?: TurnStartParams["summary"];
      readonly promptInput?: CodexPromptInput;
      readonly clientUserMessageId?: string;
    };
  } | null;
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
  readonly threadId: string;
  readonly prompt: string;
  readonly overrides?: {
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
    readonly worktreeInit?: CodexCanonicalWorktreeInitItem;
  };
  readonly rendererOwnsState: boolean;
}

export interface CodexTurnSteerPreparationInput {
  readonly command: CodexSteerTurnInput;
  readonly steerId: string;
  readonly recoveryRow: CodexQueuedFollowUp;
}

export class CodexTurnPreparation extends Context.Service<
  CodexTurnPreparation,
  {
    readonly start: (
      input: CodexTurnStartPreparationInput,
    ) => Effect.Effect<CodexTurnStartPlan, CodexTurnPreparationError>;
    readonly steer: (
      input: CodexTurnSteerPreparationInput,
    ) => Effect.Effect<CodexTurnSteerPlan, CodexTurnPreparationError>;
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

/**
 * Preserves the wire distinction between an explicit Standard reset (`null`)
 * and an absent override, while canonicalizing app-server Standard aliases.
 */
export function projectCodexTurnServiceTier(
  overrides: CodexTurnStartPreparationInput["overrides"],
  inheritedServiceTier: unknown,
): Pick<TurnStartParams, "serviceTier"> {
  if (overrides?.serviceTier !== undefined) {
    return { serviceTier: normalizeCodexServiceTier(overrides.serviceTier) };
  }
  const inherited = normalizeCodexServiceTier(inheritedServiceTier);
  return inherited === null ? {} : { serviceTier: inherited };
}

export const make: Effect.Effect<
  CodexTurnPreparation["Service"],
  never,
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
> = Effect.gen(function* () {
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
      const cwd = liveContext.cwd;
      const workspaceRoots = [...liveContext.writableRoots];
      const preparedAgentConfig = yield* agentConfig.prepare({
        target: { kind: "existing-thread", threadId: input.threadId },
        configs: prepared.agentConfigs,
        permissionContext: { projectId, workspaceRoots },
      });
      const state = yield* projection.read(input.threadId);
      const settings = state.canonical.sidecar.latestThreadSettings;
      const hydration = state.canonical.sidecar.hydrationContext;
      const hydratedSettings = hydration?.latestThreadSettings ?? null;
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
      const fallbackCollaboration =
        settings?.collaborationMode ?? hydratedSettings?.collaborationMode ?? null;
      const model =
        normalizeText(preparedAgentConfig.executionProfile?.modelId) ??
        normalizeText(input.overrides?.model) ??
        normalizeText(settings?.model) ??
        normalizeText(hydratedSettings?.model) ??
        normalizeText(fallbackCollaboration?.settings.model);
      const effort =
        preparedAgentConfig.executionProfile?.reasoningEffort ??
        input.overrides?.reasoningEffort ??
        settings?.effort ??
        hydratedSettings?.effort ??
        fallbackCollaboration?.settings.reasoning_effort ??
        null;
      const mode =
        preparedAgentConfig.collaborationMode ??
        input.overrides?.collaborationMode ??
        fallbackCollaboration?.mode ??
        null;
      const selectedCollaborationMode = collaborationMode({ mode, model, effort });
      const explicitSummary =
        input.overrides && Object.hasOwn(input.overrides, "summary")
          ? parseCodexReasoningSummary(input.overrides.summary)
          : undefined;
      const summary = resolveCodexReasoningSummary({
        configuredSummary: settings?.summary ?? hydratedSettings?.summary,
        explicitSummary,
      });
      const serviceTierRequest = preparedAgentConfig.executionProfile
        ? projectCodexTurnServiceTier(
            { serviceTier: preparedAgentConfig.executionProfile.serviceTier },
            settings?.serviceTier ?? hydratedSettings?.serviceTier,
          )
        : projectCodexTurnServiceTier(
            input.overrides,
            settings?.serviceTier ?? hydratedSettings?.serviceTier,
          );
      const serviceTier = serviceTierRequest.serviceTier ?? null;
      const clientUserMessageId = input.overrides?.clientUserMessageId ?? randomUUID();
      prepared = yield* inputAssets.retainPrepared(
        input.threadId,
        clientUserMessageId,
        prepared,
        (yield* hosts.resolve(input.threadId)) === CODEX_APP_LOCAL_HOST_ID,
      );
      const request: TurnStartParams = {
        threadId: input.threadId,
        clientUserMessageId,
        ...(cwd ? { cwd } : {}),
        ...(prepared.additionalContext ? { additionalContext: prepared.additionalContext } : {}),
        ...turnPermissions,
        ...(model ? { model } : {}),
        ...serviceTierRequest,
        ...(effort ? { effort } : {}),
        summary,
        ...(selectedCollaborationMode ? { collaborationMode: selectedCollaborationMode } : {}),
        ...(input.overrides?.responsesapiClientMetadata
          ? { responsesapiClientMetadata: input.overrides.responsesapiClientMetadata }
          : {}),
        input: prepared.inputItems,
      };
      const canonicalPermissions = hydration?.currentPermissions
        ? resolveCanonicalPermissionContext(
            permission.state,
            workspaceRoots,
            hydration.currentPermissions,
          )
        : null;
      const canonicalRequired = canonicalPermissions
        ? ({
            cwd,
            approvalPolicy: turnPermissions.approvalPolicy ?? canonicalPermissions.approvalPolicy,
            approvalsReviewer:
              turnPermissions.approvalsReviewer ?? canonicalPermissions.approvalsReviewer,
            model: selectedCollaborationMode ? null : (model ?? null),
            effort: selectedCollaborationMode ? null : (effort ?? null),
            summary,
            personality:
              settings?.personality ?? hydratedSettings?.personality ?? preferences.current(),
            outputSchema: null,
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
      const canonicalParams: CodexTurnStartPlan["canonicalParams"] =
        hydration && canonicalPermissions && canonicalRequired
          ? {
              threadId: input.threadId,
              clientUserMessageId,
              input: prepared.inputItems,
              ...(prepared.additionalContext
                ? { additionalContext: prepared.additionalContext }
                : {}),
              ...(input.overrides?.responsesapiClientMetadata
                ? { responsesapiClientMetadata: input.overrides.responsesapiClientMetadata }
                : {}),
              ...canonicalRequired,
              sandboxPolicy: turnPermissions.sandboxPolicy ?? canonicalPermissions.sandboxPolicy,
              permissions: canonicalPermissions.activePermissionProfile?.id ?? null,
              runtimeWorkspaceRoots: canonicalPermissions.activePermissionProfile
                ? [...workspaceRoots]
                : null,
              useAppServerPermissionDefault: permission.state.effectivePreset === "custom",
              serviceTier,
              multiAgentMode: hydratedSettings?.multiAgentMode ?? "explicitRequestOnly",
              attachments: dedupeCodexLiveFileAttachments([
                ...prepared.fileAttachments,
                ...prepared.addedFiles,
              ]),
              commentAttachments: [...prepared.commentAttachments],
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
      const effectiveSettings: CodexConversationThreadSettings = {
        model: model ?? "",
        modelProvider:
          normalizeText(settings?.modelProvider) ??
          normalizeText(state.canonical.protocol.modelProvider) ??
          null,
        serviceTier,
        reasoningEffort: effort,
        summary,
        collaborationMode: effectiveCollaborationMode,
        personality:
          settings?.personality ?? hydratedSettings?.personality ?? preferences.current(),
      };
      const startedAtMs = yield* Clock.currentTimeMillis;
      return {
        threadId: input.threadId,
        projectId,
        request,
        canonicalParams,
        currentCollaborationModel:
          normalizeText(effectiveCollaborationMode.settings.model) ??
          model ??
          normalizeText(fallbackCollaboration?.settings.model) ??
          "",
        settings: effectiveSettings,
        permissionContext: canonicalPermissions,
        clientUserMessageId,
        rendererOwnsState: input.rendererOwnsState,
        verifiedBuiltinFullAccess: permission.verifiedBuiltinFullAccess,
        promptText: prepared.promptText,
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
      const state = yield* projection.read(threadId);
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
      const activeTurn = input.command.expectedTurnId
        ? state.canonical.turns.find((turn) => turn.protocol.id === input.command.expectedTurnId)
        : state.canonical.turns.findLast((turn) => turn.protocol.status === "inProgress");
      const expectedTurnId = input.command.expectedTurnId ?? activeTurn?.protocol.id ?? null;
      if (!expectedTurnId) return yield* fail(new Error("No active Turn is available to steer"));
      const questionReplies = decodeCodexAsyncQuestionReplies(input.command.prompt);
      if (questionReplies) {
        const questionIds = new Set(
          activeTurn?.items.flatMap(expandCodexAsyncQuestions).map((question) => question.id),
        );
        if (
          !input.command.expectedTurnId ||
          activeTurn?.protocol.status !== "inProgress" ||
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
      const request: TurnSteerParams = {
        threadId,
        expectedTurnId,
        clientUserMessageId: input.recoveryRow.clientUserMessageId,
        input: prepared.inputItems,
        ...(prepared.additionalContext ? { additionalContext: prepared.additionalContext } : {}),
      };
      const item: CodexCanonicalSteeringUserMessageItem = {
        type: "steeringUserMessage",
        id: input.steerId,
        targetTurnId: expectedTurnId,
        targetTurnStartedAtMs: activeTurn?.sidecar.turnStartedAtMs ?? null,
        status: "pending",
        clientUserMessageId: input.recoveryRow.clientUserMessageId,
        input: prepared.inputItems,
        attachments: dedupeCodexLiveFileAttachments([
          ...prepared.fileAttachments,
          ...prepared.addedFiles,
        ]),
        restoreMessage: {
          queueRow: input.recoveryRow,
          context: { commentAttachments: [...prepared.commentAttachments] },
        },
        compareKey: buildCodexSteeringCompareKey(prepared.inputItems, prepared.commentAttachments),
      };
      return {
        threadId,
        expectedTurnId,
        steerId: input.steerId,
        request,
        item,
        fallbackStart: questionReplies
          ? null
          : {
              prompt: input.command.prompt,
              overrides: {
                clientUserMessageId: input.recoveryRow.clientUserMessageId,
                ...(input.command.collaborationMode
                  ? { collaborationMode: input.command.collaborationMode }
                  : {}),
                ...(Object.hasOwn(input.command, "serviceTier") &&
                input.command.serviceTier !== undefined
                  ? { serviceTier: normalizeCodexServiceTier(input.command.serviceTier) }
                  : {}),
                ...(input.command.summary !== undefined ? { summary: input.command.summary } : {}),
                ...(input.command.promptInput ? { promptInput: input.command.promptInput } : {}),
              },
            },
      } satisfies CodexTurnSteerPlan;
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

  return CodexTurnPreparation.of({ start, steer });
});
