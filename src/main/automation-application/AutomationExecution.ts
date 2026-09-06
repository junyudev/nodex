import { buildNodexCliBootstrap } from "../platform/node/NodexCliBootstrap";
import { isDevelopmentFeatureEnabled } from "../../shared/development-features";
import { randomUUID } from "node:crypto";
import { open as openFile } from "node:fs/promises";
import * as path from "node:path";
import type { CollaborationMode as CodexAppServerCollaborationMode } from "@nodex/codex-app-server-protocol";
import type { DynamicToolSpec } from "@nodex/codex-app-server-protocol/v2/DynamicToolSpec";
import type { ThreadStartResponse } from "@nodex/codex-app-server-protocol/v2/ThreadStartResponse";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  CODEX_AGENT_BACKEND_BINDING,
  isCodexAgentBackendBinding,
} from "../../shared/agent-backend";
import type { CodexExecutionProfile } from "../../shared/codex-execution-profile";
import { resolveCodexCanonicalHydratedCwd } from "../../shared/codex-conversation-state/codex-conversation-state";
import { createCodexTextUserInput } from "../../shared/codex-prompt-preparation";
import type {
  CodexAutomationRunsUpdatedEvent,
  CodexHeartbeatAutomationCollaborationMode,
  CodexHeartbeatAutomationPermissions,
  CodexScheduledAutomation,
  CodexScheduledAutomationCreateInput,
  CodexScheduledAutomationRunNowInput,
  CodexScheduledAutomationUpdateInput,
} from "../../shared/types";
import { MainConfig } from "../app/MainConfig";
import {
  buildCodexAppMetaThreadToolSpecs,
  CODEX_APP_LOCAL_HOST_ID,
} from "../codex/codex-app-meta-thread-tools";
import { buildCodexDesktopDeveloperInstructions } from "../codex/codex-developer-instructions";
import { resolveDynamicToolCatalogBindings } from "../codex/codex-dynamic-tool-catalog-bindings";
import { rewriteExecutionWorkspaceRoots } from "../codex/codex-execution-workspace-roots";
import { evaluateCodexThreadHandoffCapability } from "../codex/codex-thread-handoff-capability";
import { createCodexProjectlessWorkspace } from "../codex/codex-projectless-workspace";
import { buildCodexThreadConfigOverrides } from "../codex/codex-thread-capabilities";
import { persistCodexWorktreeShellEnvironmentAtGitPath } from "../codex/codex-worktree-shell-environment";
import type { CodexWorktreeWorkerOperation } from "../codex/codex-worktree-worker-protocol";
import {
  CODEX_AUTOMATION_DEVELOPER_INSTRUCTIONS,
  buildCodexProjectlessThreadInstructions,
  buildCodexScheduledAutomationHeartbeatPrompt,
  buildCodexScheduledAutomationRunPrompt,
  resolveCodexScheduledAutomationModelSettings,
} from "../codex-scheduled-automation-runtime";
import {
  buildThreadPermissionOverrides,
  buildTurnPermissionOverrides,
} from "../codex/codex-permission-resolver";
import { computeCodexScheduledAutomationIntervalMs } from "../local-store/codex-scheduled-automation-schedule";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import {
  projectCodexGatewayThreadReadThread,
  projectCodexGatewayThreadResumeResponse,
} from "../codex-runtime/CodexGatewayProtocolProjection";
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import {
  CodexScheduledAutomationRetryError,
  type CodexScheduledAutomationHeartbeatRunContext,
  type CodexScheduledAutomationRunContext,
} from "../host-runtime/ScheduledAutomationPolicy";
import { getLogger } from "../logging/logger";
import { selectNodexAgentDynamicToolSpecs } from "../nodex-agent-application/NodexAgentDynamicTools";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import { CodexHeartbeatTurnCompletion } from "../codex-application/CodexHeartbeatTurnCompletion";
import { CodexHistoryPageAdapter } from "../codex-application/CodexHistoryPageAdapter";
import { CodexPermissions } from "../codex-application/CodexPermissions";
import { CodexRendererConversationRegistry } from "../codex-application/CodexRendererConversationRegistry";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { ThreadCreationRuntime } from "../codex-application/ThreadCreationRuntime";
import { CodexThreadSettingsRuntime } from "../codex-application/CodexThreadSettingsRuntime";
import { CodexThreadTitlePersistence } from "../codex-application/CodexThreadTitlePersistence";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CodexTurnCommands } from "../codex-application/CodexTurnCommands";
import { ComposerCatalog } from "../codex-application/ComposerCatalog";
import { requireExactThreadStartProfile } from "../codex-application/codex-thread-start-profile";
import { CodexConversations } from "../codex-application/CodexConversations";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { ManagedWorktreeRetentionRuntime } from "../codex-application/ManagedWorktreeRetentionRuntime";
import { ManagedWorktreeRuntime } from "../codex-application/ManagedWorktreeRuntime";
import { AutomationApplication } from "./AutomationApplication";
import { requireCodexAutomationBackendBinding } from "./AutomationProjection";
import {
  hasCompleteAutomationArchiveExchange,
  readBoundedAutomationArchiveExcerpt,
  resolveAutomationArchiveMessagesFromTranscript,
  type AutomationArchiveMessages,
} from "./AutomationArchiveExcerpt";

export {
  AUTOMATION_ARCHIVE_ITEM_CAPTURE_LIMIT,
  AUTOMATION_ARCHIVE_PROJECTED_BYTE_LIMIT,
  AUTOMATION_ARCHIVE_TURN_CAPTURE_LIMIT,
  hasCompleteAutomationArchiveExchange,
  resolveAutomationArchiveMessagesFromTranscript,
  type AutomationArchiveMessages,
} from "./AutomationArchiveExcerpt";

const HEARTBEAT_ROLLOUT_TAIL_BYTES = 256 * 1024;
const HEARTBEAT_TERMINAL_ROLLOUT_EVENTS = new Set(["task_complete", "response_item", "event_msg"]);
const HEARTBEAT_ACTIVE_ROLLOUT_EVENTS = new Set(["response_item", "event_msg", "item", "unknown"]);
const THREAD_START_EXPERIMENTAL_RAW_EVENTS = false;
type GatewayThreadStartParams = ClientRequestParamsByMethod["thread/start"];
type GatewayThreadStartResponse = ClientRequestResponsesByMethod["thread/start"];
type GatewayTurnStartParams = ClientRequestParamsByMethod["turn/start"];

interface AutomationRunContext {
  readonly now: number;
  readonly reason: "scheduled" | "run-now";
  readonly leaseId?: string;
  readonly heartbeat?: CodexScheduledAutomationHeartbeatRunContext;
}

export class AutomationExecutionError extends Schema.TaggedError<AutomationExecutionError>()(
  "AutomationExecutionError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

type AutomationExecutionEffect<A> = Effect.Effect<A, AutomationExecutionError>;

export class AutomationExecution extends Context.Service<
  AutomationExecution,
  {
    readonly prepareDefinition: <
      Input extends CodexScheduledAutomationCreateInput | CodexScheduledAutomationUpdateInput,
    >(
      input: Input,
      current?: CodexScheduledAutomation | null,
    ) => AutomationExecutionEffect<Input>;
    readonly runNow: (
      input: CodexScheduledAutomationRunNowInput,
      rendererClientId?: string | null,
    ) => AutomationExecutionEffect<void>;
    readonly executeClaimed: (
      automation: CodexScheduledAutomation,
      context: CodexScheduledAutomationRunContext,
    ) => AutomationExecutionEffect<void>;
    readonly resolveArchiveMessages: (threadId: string) => Effect.Effect<AutomationArchiveMessages>;
  }
>()("nodex/main/automation-application/AutomationExecution") {}

export interface AutomationExecutionOptions {
  readonly runtimeStateHome: string;
  readonly runtimeVersion: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
};

const buildHeartbeatPermissionOverrides = (
  permissions: CodexHeartbeatAutomationPermissions,
): Pick<GatewayTurnStartParams, "approvalPolicy" | "approvalsReviewer" | "sandboxPolicy"> => ({
  ...(permissions.approvalPolicy ? { approvalPolicy: permissions.approvalPolicy } : {}),
  ...(permissions.approvalsReviewer ? { approvalsReviewer: permissions.approvalsReviewer } : {}),
  ...(permissions.sandboxPolicy ? { sandboxPolicy: permissions.sandboxPolicy } : {}),
});

const collaborationMode = (
  mode: CodexHeartbeatAutomationCollaborationMode | null,
): CodexAppServerCollaborationMode | null => {
  if (!mode || typeof mode === "string") return null;
  return {
    mode: mode.mode,
    settings: {
      model: mode.settings.model,
      reasoning_effort: mode.settings.reasoning_effort,
      developer_instructions: mode.settings.developer_instructions,
    },
  };
};

const uniqueResolvedPaths = (paths: readonly string[]): string[] => {
  const seen = new Set<string>();
  return paths.flatMap((candidate) => {
    const normalized = candidate.trim();
    if (!normalized) return [];
    const resolved = path.resolve(normalized);
    if (seen.has(resolved)) return [];
    seen.add(resolved);
    return [resolved];
  });
};

const readLatestHeartbeatRolloutEvent = (rolloutPath: string): Effect.Effect<string | null> =>
  Effect.tryPromise(async () => {
    let handle: Awaited<ReturnType<typeof openFile>> | null = null;
    try {
      handle = await openFile(rolloutPath, "r");
      const stats = await handle.stat();
      if (stats.size <= 0) return null;
      const bytesToRead = Math.min(stats.size, HEARTBEAT_ROLLOUT_TAIL_BYTES);
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, stats.size - bytesToRead);
      const lines = buffer.toString("utf8").split("\n");
      if (stats.size > bytesToRead) lines.shift();
      let latest: string | null = null;
      for (const line of lines) {
        try {
          const event = nonEmptyString(asRecord(JSON.parse(line))?.event);
          if (event && HEARTBEAT_TERMINAL_ROLLOUT_EVENTS.has(event)) latest = event;
        } catch {
          continue;
        }
      }
      return latest;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }).pipe(Effect.catch(() => Effect.succeed(null)));

export const live = (
  options: AutomationExecutionOptions,
): Layer.Layer<
  AutomationExecution,
  never,
  | AutomationApplication
  | CodexApplicationEventHub
  | CodexAppServerCapabilities
  | CodexGateway
  | CodexGitProbe
  | CodexHeartbeatTurnCompletion
  | CodexHistoryPageAdapter
  | CodexPermissions
  | CodexRendererConversationRegistry
  | CodexThreadDirectory
  | ThreadCreationRuntime
  | CodexThreadSettingsRuntime
  | CodexThreadTitlePersistence
  | CodexTurnAuthority
  | CodexTurnCommands
  | ComposerCatalog
  | CodexConversations
  | DesktopToolRuntime
  | ExecutionHostRuntime
  | MainConfig
  | ManagedWorktreeRetentionRuntime
  | ManagedWorktreeRuntime
  | ProjectWorkspace
> =>
  Layer.effect(
    AutomationExecution,
    Effect.gen(function* () {
      const automation = yield* AutomationApplication;
      const events = yield* CodexApplicationEventHub;
      const capabilities = yield* CodexAppServerCapabilities;
      const gateway = yield* CodexGateway;
      const git = yield* CodexGitProbe;
      const heartbeatCompletion = yield* CodexHeartbeatTurnCompletion;
      const historyPages = yield* CodexHistoryPageAdapter;
      const permissions = yield* CodexPermissions;
      const rendererConversations = yield* CodexRendererConversationRegistry;
      const directory = yield* CodexThreadDirectory;
      const threadStarts = yield* ThreadCreationRuntime;
      const threadSettings = yield* CodexThreadSettingsRuntime;
      const titles = yield* CodexThreadTitlePersistence;
      const authority = yield* CodexTurnAuthority;
      const turns = yield* CodexTurnCommands;
      const composer = yield* ComposerCatalog;
      const conversations = yield* CodexConversations;
      const desktopTools = yield* DesktopToolRuntime;
      const executionHosts = yield* ExecutionHostRuntime;
      const config = yield* MainConfig;
      const retention = yield* ManagedWorktreeRetentionRuntime;
      const managedWorktrees = yield* ManagedWorktreeRuntime;
      const workspace = yield* ProjectWorkspace;
      const logger = getLogger({ component: "automation-execution" });
      const runtimeStateHome = path.resolve(options.runtimeStateHome);
      const error = (operation: string, cause: unknown) =>
        cause instanceof AutomationExecutionError
          ? cause
          : new AutomationExecutionError({ operation, cause });
      const protect = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.mapError((cause) => error(operation, cause)));
      const fail = (operation: string, cause: unknown) => Effect.fail(error(operation, cause));
      const requireCodexAutomationBackend = (
        operation: string,
        binding: CodexScheduledAutomation["backendBinding"],
      ) =>
        Effect.try({
          try: () => requireCodexAutomationBackendBinding(binding),
          catch: (cause) => error(operation, cause),
        });
      const requireCodexHeartbeatTarget = Effect.fn(
        "AutomationExecution.requireCodexHeartbeatTarget",
      )(function* (operation: string, targetThreadId: string | null | undefined) {
        const normalized = targetThreadId?.trim() ?? "";
        if (!normalized) {
          return yield* fail(operation, "Heartbeat thread not found.");
        }
        const target = yield* workspace
          .getThread(normalized)
          .pipe(Effect.mapError((cause) => error(operation, cause)));
        if (!target) return yield* fail(operation, "Heartbeat thread not found.");
        if (!isCodexAgentBackendBinding(target.backendBinding)) {
          return yield* fail(
            operation,
            `Heartbeat target '${normalized}' is not owned by the Codex Agent Backend`,
          );
        }
        return normalized;
      });
      const assertHostGeneration = (
        operation: string,
        snapshot: CodexAppServerCapabilitySnapshot,
      ): Effect.Effect<void, AutomationExecutionError> =>
        capabilities.isCurrent(snapshot).pipe(
          Effect.mapError((cause) => error(operation, cause)),
          Effect.flatMap((current) =>
            current
              ? Effect.void
              : fail(
                  operation,
                  new Error(`Codex host '${snapshot.hostId}' generation changed during request`),
                ),
          ),
        );
      const fencedHostRequest = <A, E>(
        operation: string,
        snapshot: CodexAppServerCapabilitySnapshot,
        request: () => Effect.Effect<A, E>,
      ): Effect.Effect<A, E | AutomationExecutionError> =>
        assertHostGeneration(operation, snapshot).pipe(
          Effect.andThen(Effect.suspend(request)),
          Effect.tap(() => assertHostGeneration(operation, snapshot)),
        );
      const notify = (event: CodexAutomationRunsUpdatedEvent): void =>
        events.publish({ kind: "codex", value: { type: "automationRunsUpdated", event } });

      const prepareDefinition: AutomationExecution["Service"]["prepareDefinition"] = (
        input,
        current,
      ) =>
        protect(
          "prepare-definition",
          Effect.gen(function* () {
            yield* requireCodexAutomationBackend(
              "prepare-definition",
              input.backendBinding ?? current?.backendBinding ?? CODEX_AGENT_BACKEND_BINDING,
            );
            if (input.kind === "heartbeat") {
              yield* requireCodexHeartbeatTarget(
                "prepare-definition",
                input.targetThreadId ?? current?.targetThreadId,
              );
            }
            const requestedModelId = input.model?.trim();
            const modelId = requestedModelId || current?.model?.trim();
            if (!modelId) return input;
            const models = yield* composer.listModels;
            const model = models.find(
              (candidate) => candidate.model === modelId || candidate.id === modelId,
            );
            if (!model) {
              return yield* fail("prepare-definition", `Codex model '${modelId}' is unavailable`);
            }
            const modelChanged = Boolean(
              current?.model && requestedModelId && requestedModelId !== current.model,
            );
            return {
              ...input,
              model: model.model,
              reasoningEffort:
                input.reasoningEffort ??
                (modelChanged ? model.defaultReasoningEffort : current?.reasoningEffort) ??
                model.defaultReasoningEffort,
              serviceTier:
                input.serviceTier ??
                (modelChanged ? model.defaultServiceTier : current?.serviceTier) ??
                model.defaultServiceTier,
            };
          }),
        );

      const dynamicToolSpecs = Effect.fn("AutomationExecution.dynamicToolSpecs")(function* () {
        const hosts = yield* executionHosts.hosts();
        const byId = new Map(hosts.map((host) => [host.hostId, host]));
        const local = byId.get(CODEX_APP_LOCAL_HOST_ID);
        const localTransactionEffects = [
          "prepare-handoff",
          "rollback-handoff",
          "cleanup-handoff",
        ].every(
          (operation) =>
            local?.capabilities.includes(operation as CodexWorktreeWorkerOperation) ?? false,
        );
        const availableHandoffHosts = hosts
          .filter((host) => host.supportsFileTransfer)
          .filter((host) => host.capabilities.includes("cleanup-transfer-handoff"))
          .filter(
            (host) =>
              host.capabilities.includes("export-handoff") ||
              host.capabilities.includes("import-handoff"),
          )
          .map((host) => ({ id: host.hostId, displayName: host.displayName }));
        const localHandoff = evaluateCodexThreadHandoffCapability({
          runtimeVersion: options.runtimeVersion,
          appServer: {
            threadSettingsUpdate: threadSettings.remoteUpdateSupport() !== "unsupported",
            threadResumeLocation: true,
            rolloutPathConsistency: true,
          },
          coreAtomicExecutionLocation: true,
          sourceHost: {
            available: local?.capabilities.includes("create") ?? false,
            transactionEffects: localTransactionEffects,
          },
          destinationHost: {
            available: local?.capabilities.includes("create") ?? false,
            transactionEffects: localTransactionEffects,
          },
          crossHost: false,
          crossHostTransfer: false,
        });
        return [
          ...buildCodexAppMetaThreadToolSpecs({
            availableHandoffHosts,
            crossHostHandoffEnabled: availableHandoffHosts.length >= 2,
            handoffEnabled:
              localHandoff.status === "available" || availableHandoffHosts.length >= 2,
          }),
          ...selectNodexAgentDynamicToolSpecs(
            isDevelopmentFeatureEnabled("nodex-dynamic-tools", config.environment),
          ),
        ] satisfies DynamicToolSpec[];
      });

      const heartbeatThread = Effect.fn("AutomationExecution.heartbeatThread")(function* (
        threadId: string,
      ) {
        const durable = yield* directory.resolve({ threadId, fidelity: "durable" });
        if (!durable) return null;
        const hostGeneration = yield* capabilities
          .forHost(durable.durable.executionHostId)
          .pipe(Effect.mapError((cause) => error("read-heartbeat-thread", cause)));
        const response = yield* fencedHostRequest("read-heartbeat-thread", hostGeneration, () =>
          gateway.requestOnHost(
            durable.durable.executionHostId,
            "thread/read",
            {
              threadId,
              includeTurns: false,
            },
            codexGatewayGenerationFence(hostGeneration),
          ),
        );
        if (response.thread.id !== threadId) {
          return yield* fail(
            "read-heartbeat-thread",
            `Expected heartbeat Thread '${threadId}' but received '${response.thread.id}'`,
          );
        }
        const accepted = yield* directory.observeMetadata({
          thread: projectCodexGatewayThreadReadThread(response.thread),
          inferredInitialProjectId: durable.durable.projectId,
          executionHostId: durable.durable.executionHostId,
        });
        return {
          entry: accepted,
          rolloutPath: response.thread.path?.trim() || null,
          hostGeneration,
        };
      });

      const heartbeatBlockReason = Effect.fn("AutomationExecution.heartbeatBlockReason")(function* (
        statusType: string,
        activeFlags: readonly string[],
        rolloutPath: string | null,
      ) {
        if (statusType !== "active") return null;
        if (activeFlags.includes("waitingOnUserInput")) return "waiting_on_user_input";
        if (activeFlags.includes("waitingOnApproval")) return "waiting_on_approval";
        if (activeFlags.length > 0) return "active_with_flags";
        if (!rolloutPath) return "active_without_rollout_path";
        const latest = yield* readLatestHeartbeatRolloutEvent(rolloutPath);
        if (latest === "task_complete") return null;
        if (latest && HEARTBEAT_ACTIVE_ROLLOUT_EVENTS.has(latest)) {
          return "active_recent_rollout_activity";
        }
        return "active_without_terminal_event";
      });

      const deferHeartbeat = (
        definition: CodexScheduledAutomation,
        context: AutomationRunContext,
        reasonCode: string,
      ) =>
        context.leaseId !== undefined
          ? Effect.fail(
              new CodexScheduledAutomationRetryError(
                "Heartbeat automation is temporarily blocked.",
                60_000,
                reasonCode,
              ),
            )
          : automation.definitions
              .reschedule(definition.id, definition.definitionRevision, { retryWithinMs: 60_000 })
              .pipe(Effect.asVoid);

      const startHeartbeat = Effect.fn("AutomationExecution.startHeartbeat")(function* (
        definition: CodexScheduledAutomation,
        context: AutomationRunContext,
      ) {
        const now = context.now ?? (yield* Clock.currentTimeMillis);
        const reason = context.reason ?? "scheduled";
        const targetThreadId = definition.targetThreadId?.trim() ?? "";
        if (!targetThreadId) {
          if (reason === "run-now")
            return yield* fail("run-heartbeat", "Heartbeat thread not found.");
          return yield* deferHeartbeat(definition, context, "heartbeat_thread_missing");
        }
        if (reason === "scheduled" && context.heartbeat?.automationsEnabled !== true) {
          if (context.leaseId !== undefined) {
            return yield* Effect.fail(
              new CodexScheduledAutomationRetryError(
                "Heartbeat automations are disabled.",
                null,
                "heartbeat_disabled",
              ),
            );
          }
          yield* automation.definitions.reschedule(
            definition.id,
            definition.definitionRevision,
            {},
          );
          return;
        }
        const target = yield* heartbeatThread(targetThreadId).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (!target) {
          if (reason === "run-now")
            return yield* fail("run-heartbeat", "Heartbeat thread not found.");
          return yield* deferHeartbeat(definition, context, "heartbeat_thread_missing");
        }
        const renderer = context.heartbeat?.rendererState ?? null;
        const rendererBlock = !renderer
          ? "renderer_owner_lease_missing"
          : rendererConversations.getOwnerClientId(targetThreadId) !== renderer.rendererClientId
            ? "renderer_owner_lease_stale"
            : renderer.isEligible
              ? null
              : renderer.reason?.trim() || "renderer_ineligible";
        if (rendererBlock) {
          if (reason === "run-now") {
            return yield* fail("run-heartbeat", "Heartbeat thread is not eligible right now.");
          }
          return yield* deferHeartbeat(definition, context, rendererBlock);
        }
        const mode = collaborationMode(context.heartbeat?.collaborationMode ?? null);
        if (!mode) {
          if (reason === "run-now") {
            return yield* fail("run-heartbeat", "Heartbeat thread mode is still loading.");
          }
          return yield* deferHeartbeat(definition, context, "heartbeat_mode_unavailable");
        }
        const block = yield* heartbeatBlockReason(
          target.entry.durable.statusType,
          target.entry.durable.statusActiveFlags,
          target.rolloutPath,
        );
        if (block) {
          if (reason === "run-now")
            return yield* fail("run-heartbeat", "Heartbeat thread is busy right now.");
          return yield* deferHeartbeat(definition, context, block);
        }
        const intervalMs = computeCodexScheduledAutomationIntervalMs(definition.rrule);
        const latest = [definition.lastRunAt, target.entry.durable.updatedAt].filter(
          (value): value is number => typeof value === "number" && Number.isFinite(value),
        );
        const cooldownAt =
          intervalMs !== null && latest.length > 0 ? Math.max(...latest) + intervalMs : null;
        if (reason === "scheduled" && cooldownAt !== null && cooldownAt > now) {
          if (context.leaseId !== undefined) {
            return yield* Effect.fail(
              new CodexScheduledAutomationRetryError(
                "Heartbeat automation is still cooling down.",
                Math.max(1, cooldownAt - now),
                "heartbeat_cooldown",
              ),
            );
          }
          yield* automation.definitions.reschedule(definition.id, definition.definitionRevision, {
            notBefore: cooldownAt,
          });
          return;
        }
        if (reason === "run-now") {
          if (!(yield* automation.definitions.dispatchNow(definition.id))) {
            return yield* fail("dispatch-heartbeat", "Automation not found.");
          }
        }
        const requestedCwd = target.entry.durable.cwd || "/";
        const explicitPermissions = context.heartbeat?.permissions ?? null;
        const permissionOverrides = explicitPermissions
          ? buildHeartbeatPermissionOverrides(explicitPermissions)
          : buildTurnPermissionOverrides({
              permissionState: yield* permissions.resolveAutomation([requestedCwd]),
              workspaceRoots: [requestedCwd],
            });
        const browserConfig = yield* desktopTools.threadConfig;
        const resume = projectCodexGatewayThreadResumeResponse(
          yield* fencedHostRequest("resume-heartbeat-thread", target.hostGeneration, () =>
            gateway.requestOnHost(
              target.entry.durable.executionHostId,
              "thread/resume",
              {
                threadId: targetThreadId,
                history: null,
                path: target.rolloutPath,
                model: target.entry.durable.executionProfile?.modelId ?? null,
                serviceTier: target.entry.durable.executionProfile?.serviceTier ?? null,
                cwd: requestedCwd,
                approvalPolicy: null,
                sandbox: null,
                config: {
                  ...(browserConfig ?? {}),
                  ...buildCodexThreadConfigOverrides(),
                  ...(target.entry.durable.executionProfile?.reasoningEffort
                    ? {
                        model_reasoning_effort:
                          target.entry.durable.executionProfile.reasoningEffort,
                      }
                    : {}),
                },
                personality: null,
                excludeTurns: true,
              },
              codexGatewayGenerationFence(target.hostGeneration),
            ),
          ),
        );
        if (resume.thread.id !== targetThreadId) {
          return yield* fail(
            "resume-heartbeat-thread",
            "Heartbeat resume returned an unexpected Thread.",
          );
        }
        const accepted = yield* directory.acceptResumeResult({
          response: resume,
          capability: target.hostGeneration,
          executionHostId: target.entry.durable.executionHostId,
          fallbackCwd: requestedCwd,
        });
        const cwd =
          resolveCodexCanonicalHydratedCwd({
            requestedCwd,
            responseCwd: resume.cwd,
            threadCwd: resume.thread.cwd,
            fallbackCwd: requestedCwd,
          }) ?? requestedCwd;
        const prompt = buildCodexScheduledAutomationHeartbeatPrompt(definition, now);
        const request = {
          threadId: targetThreadId,
          input: [createCodexTextUserInput(prompt)],
          cwd,
          ...permissionOverrides,
          model: accepted.durable.executionProfile?.modelId ?? null,
          effort: accepted.durable.executionProfile?.reasoningEffort ?? null,
          serviceTier: accepted.durable.executionProfile?.serviceTier ?? null,
          summary: "auto",
          personality: null,
          outputSchema: null,
          collaborationMode: mode,
        } as GatewayTurnStartParams;
        const actorPermission =
          accepted.durable.projectId && !explicitPermissions
            ? yield* permissions.resolve({
                projectId: accepted.durable.projectId,
                workspaceRoots: [cwd],
              })
            : null;
        const bootstrappedRequest = {
          ...request,
          additionalContext: {
            ...request.additionalContext,
            "nodex-cli": yield* buildNodexCliBootstrap(config, {
              hostId: accepted.durable.executionHostId,
              projectId: accepted.durable.projectId,
              verifiedBuiltinFullAccess: actorPermission?.verifiedBuiltinFullAccess ?? false,
              sandboxPolicy: request.sandboxPolicy,
              planMode: mode?.mode === "plan",
            }),
          },
        };
        const launch = yield* authority.begin(
          targetThreadId,
          actorPermission?.verifiedBuiltinFullAccess ?? false,
        );
        const startTurn =
          reason === "scheduled"
            ? heartbeatCompletion
                .startAndWait(bootstrappedRequest)
                .pipe(Effect.mapError((cause) => error("start-heartbeat-turn", cause)))
            : gateway
                .requestForThread(
                  targetThreadId,
                  "turn/start",
                  bootstrappedRequest,
                  codexGatewayGenerationFence(target.hostGeneration),
                )
                .pipe(Effect.mapError((cause) => error("start-heartbeat-turn", cause)));
        yield* Effect.gen(function* () {
          const result = yield* startTurn;
          yield* authority.bind(targetThreadId, launch, result.turn.id);
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.sync(() => {
                  authority.abort(launch);
                }),
          ),
        );
      });

      interface RunLocation {
        readonly cwd: string;
        readonly workspaceRoots: readonly string[];
        readonly managedWorktreePath: string | null;
        readonly projectlessOutputDirectory: string | null;
        readonly projectlessWorkspaceBrowserRoot: string | null;
      }

      const runLocation = Effect.fn("AutomationExecution.runLocation")(function* (
        definition: CodexScheduledAutomation,
        sourceCwd: string,
        now: number,
      ) {
        if (sourceCwd === "~") {
          const projectless = yield* Effect.tryPromise(() =>
            createCodexProjectlessWorkspace({
              createSplitDirectories: true,
              date: new Date(now),
              prompt: definition.prompt,
              homeDirectory: config.homeDirectory,
            }),
          );
          return {
            cwd: projectless.cwd,
            workspaceRoots: [],
            managedWorktreePath: null,
            projectlessOutputDirectory: projectless.outputDirectory,
            projectlessWorkspaceBrowserRoot: projectless.workspaceRoot,
          };
        }
        if (definition.executionEnvironment !== "worktree") {
          return {
            cwd: sourceCwd,
            workspaceRoots: [sourceCwd],
            managedWorktreePath: null,
            projectlessOutputDirectory: null,
            projectlessWorkspaceBrowserRoot: null,
          };
        }
        const selectedEnvironmentPath = definition.localEnvironmentConfigPath?.trim() || null;
        const branchName = yield* git.readPath(sourceCwd, ["branch", "--show-current"]);
        const host = yield* executionHosts.resolve(CODEX_APP_LOCAL_HOST_ID, "create");
        let allocatedRoot: string | null = null;
        const worker = yield* host
          .request(
            {
              operation: "create",
              input: {
                requestId: `automation:${definition.id}:${randomUUID()}`,
                hostId: CODEX_APP_LOCAL_HOST_ID,
                repositoryPath: sourceCwd,
                nodexHome: config.nodexHome,
                managedRoot: host.descriptor.managedRoot,
                projectId: definition.id,
                targetId: definition.id,
                threadTitle: definition.name,
                startingState: branchName ? { type: "branch", branchName } : null,
                localEnvironmentConfigPath: selectedEnvironmentPath,
                setUpSyncedBranch: true,
                propagateLocalWorkspaceFiles: true,
              },
            },
            {
              onEvent: (event) =>
                event.type === "path-allocated"
                  ? Effect.sync(() => {
                      allocatedRoot = event.worktreeGitRoot;
                    }).pipe(
                      Effect.andThen(
                        managedWorktrees.registerNewborn({
                          hostId: CODEX_APP_LOCAL_HOST_ID,
                          worktreeGitRoot: event.worktreeGitRoot,
                        }),
                      ),
                    )
                  : Effect.void,
            },
          )
          .pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) || !allocatedRoot
                ? Effect.void
                : managedWorktrees.releaseNewborn({
                    hostId: CODEX_APP_LOCAL_HOST_ID,
                    worktreeGitRoot: allocatedRoot,
                  }),
            ),
          );
        const worktreeGitRoot = path.resolve(worker.worktreeGitRoot);
        const worktreeWorkspaceRoot = path.resolve(worker.worktreeWorkspaceRoot);
        if (worker.setupError) {
          yield* managedWorktrees
            .remove({
              hostId: CODEX_APP_LOCAL_HOST_ID,
              worktreeGitRoot,
              reason: "failed-create",
            })
            .pipe(Effect.ignore);
          return yield* fail(
            "create-automation-worktree",
            `Failed to set up scheduled automation worktree using environment '${selectedEnvironmentPath}': ${worker.setupError}`,
          );
        }
        const shellEnvironmentPath = yield* git.readPath(worktreeWorkspaceRoot, [
          "rev-parse",
          "--git-path",
          "codex-shell-environment.json",
        ]);
        if (shellEnvironmentPath) {
          yield* Effect.tryPromise(() =>
            persistCodexWorktreeShellEnvironmentAtGitPath({
              cwd: worktreeWorkspaceRoot,
              gitPath: shellEnvironmentPath,
              shellEnvironment: worker.shellEnvironment,
            }),
          ).pipe(
            Effect.catch((cause) =>
              Effect.sync(() =>
                logger.warn("Failed to store scheduled automation worktree shell environment", {
                  cwd: worktreeWorkspaceRoot,
                  cause,
                }),
              ),
            ),
          );
        }
        return {
          cwd: worktreeWorkspaceRoot,
          workspaceRoots: rewriteExecutionWorkspaceRoots({
            sourcePrimary: sourceCwd,
            targetPrimary: worktreeWorkspaceRoot,
            workspaceRoots: [sourceCwd],
          }),
          managedWorktreePath: worktreeGitRoot,
          projectlessOutputDirectory: null,
          projectlessWorkspaceBrowserRoot: null,
        };
      });

      const turnWorkspaceRoots = Effect.fn("AutomationExecution.turnWorkspaceRoots")(function* (
        definitionId: string,
        sourceCwd: string,
        location: RunLocation,
      ) {
        if (location.projectlessOutputDirectory) return [];
        const roots = [
          location.cwd,
          path.join(runtimeStateHome, "automations", definitionId),
          ...location.workspaceRoots,
        ];
        const worktreeGitRoot = yield* git.readPath(location.cwd, ["rev-parse", "--show-toplevel"]);
        const sourceGitRoot = yield* git.readPath(sourceCwd, ["rev-parse", "--show-toplevel"]);
        if (worktreeGitRoot) roots.push(worktreeGitRoot);
        const commonCwd = worktreeGitRoot ?? sourceGitRoot ?? location.cwd;
        const commonDir = yield* git.readPath(commonCwd, ["rev-parse", "--git-common-dir"]);
        if (commonDir) {
          roots.push(path.isAbsolute(commonDir) ? commonDir : path.resolve(commonCwd, commonDir));
        } else if (sourceGitRoot) {
          roots.push(path.join(sourceGitRoot, ".git"));
        }
        return uniqueResolvedPaths(roots);
      });

      const startCronRun = Effect.fn("AutomationExecution.startCronRun")(function* (input: {
        readonly definition: CodexScheduledAutomation;
        readonly cwd: string;
        readonly prompt: string;
        readonly model: string | null;
        readonly reasoningEffort: string | null;
        readonly now: number;
      }) {
        const capability = yield* capabilities.forHost(gateway.localHostId);
        const pendingThreadId = `pending:${randomUUID()}`;
        if (
          yield* automation.runs.begin({
            threadId: pendingThreadId,
            automationId: input.definition.id,
            threadTitle: input.definition.name,
            sourceCwd: input.cwd,
          })
        ) {
          notify({
            automationId: input.definition.id,
            threadId: pendingThreadId,
            reason: "pending-insert",
          });
        }
        let threadId: string | null = null;
        let managedWorktreePath: string | null = null;
        const transaction = Effect.gen(function* () {
          const executionProfile: CodexExecutionProfile | null = input.model
            ? {
                modelId: input.model,
                reasoningEffort: input.reasoningEffort,
                serviceTier: input.definition.serviceTier,
              }
            : null;
          const location = yield* runLocation(input.definition, input.cwd, input.now);
          managedWorktreePath = location.managedWorktreePath;
          const threadRoots = location.projectlessOutputDirectory
            ? []
            : [...location.workspaceRoots];
          const writableRoots = yield* turnWorkspaceRoots(input.definition.id, input.cwd, location);
          const threadPermissionState = yield* permissions.resolveAutomation(threadRoots);
          const threadPermissionOverrides = buildThreadPermissionOverrides({
            permissionState: threadPermissionState,
          });
          const developerInstructions = [
            buildCodexDesktopDeveloperInstructions({
              baseInstructions: CODEX_AUTOMATION_DEVELOPER_INSTRUCTIONS,
              isNonGitWorkspace: true,
              threadToolsEnabled: true,
              workspaceDependenciesEnabled: false,
            }),
            location.projectlessOutputDirectory
              ? buildCodexProjectlessThreadInstructions({
                  cwd: location.cwd,
                  outputDirectory: location.projectlessOutputDirectory,
                  workspaceBrowserRoot: location.projectlessWorkspaceBrowserRoot,
                })
              : null,
          ]
            .filter((line): line is string => line !== null)
            .join("\n\n");
          const tools = yield* dynamicToolSpecs();
          const browserConfig = yield* desktopTools.threadConfig;
          const params = {
            cwd: location.cwd,
            model: input.model,
            config: {
              ...(browserConfig ?? {}),
              ...(executionProfile?.reasoningEffort
                ? { model_reasoning_effort: executionProfile.reasoningEffort }
                : {}),
              ...buildCodexThreadConfigOverrides(),
            },
            developerInstructions,
            personality: null,
            ephemeral: null,
            threadSource: "automation",
            historyMode: "paginated",
            dynamicTools: tools,
            experimentalRawEvents: THREAD_START_EXPERIMENTAL_RAW_EVENTS,
            mockExperimentalField: null,
            serviceTier: executionProfile?.serviceTier ?? null,
            runtimeWorkspaceRoots: threadRoots,
            ...threadPermissionOverrides,
          } as GatewayThreadStartParams;
          const response = (yield* gateway.requestLocal(
            "thread/start",
            params,
            codexGatewayGenerationFence(capability),
          )) as GatewayThreadStartResponse as unknown as ThreadStartResponse;
          yield* Effect.try({
            try: () => requireExactThreadStartProfile(response, executionProfile),
            catch: (cause) => error("verify-cron-execution-profile", cause),
          }).pipe(
            Effect.tapError(() =>
              gateway
                .requestLocal(
                  "thread/delete",
                  { threadId: response.thread.id },
                  codexGatewayGenerationFence(capability),
                )
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      "Could not delete a profile-substituted automation Thread",
                    ).pipe(
                      Effect.annotateLogs({ threadId: response.thread.id, cause: String(cause) }),
                    ),
                  ),
                ),
            ),
          );
          const effectiveCwd =
            resolveCodexCanonicalHydratedCwd({
              requestedCwd: location.cwd,
              responseCwd: response.cwd,
              threadCwd: response.thread.cwd,
              fallbackCwd: location.cwd,
            }) ?? location.cwd;
          const accepted = yield* directory.acceptStandaloneStart({
            response: { ...response, cwd: effectiveCwd },
            capability,
            projectId: null,
            executionProfile,
            runtimeWorkspaceRoots: writableRoots,
            fallbackCwd: effectiveCwd,
            managedWorktreePath: location.managedWorktreePath,
            projectlessOutputDirectory: location.projectlessOutputDirectory,
            projectlessWorkspaceBrowserRoot: location.projectlessWorkspaceBrowserRoot,
          });
          threadId = accepted.durable.threadId;
          yield* workspace.replaceThreadDynamicToolCatalogs(
            threadId,
            resolveDynamicToolCatalogBindings(tools),
          );
          if (managedWorktreePath) {
            yield* managedWorktrees
              .setOwner({
                hostId: CODEX_APP_LOCAL_HOST_ID,
                worktreeGitRoot: managedWorktreePath,
                ownerThreadId: threadId,
              })
              .pipe(
                Effect.catch((cause) =>
                  Effect.sync(() =>
                    logger.warn("Scheduled automation worktree has no owner metadata", {
                      automationId: input.definition.id,
                      threadId,
                      cause,
                    }),
                  ),
                ),
                Effect.ensuring(
                  managedWorktrees.releaseNewborn({
                    hostId: CODEX_APP_LOCAL_HOST_ID,
                    worktreeGitRoot: managedWorktreePath,
                  }),
                ),
              );
            yield* retention.request;
          }
          if (
            yield* automation.runs.replacePendingThread({
              pendingThreadId,
              threadId,
            })
          ) {
            notify({ automationId: input.definition.id, threadId, reason: "pending-replace" });
          } else if (
            yield* automation.runs.begin({
              threadId,
              automationId: input.definition.id,
              threadTitle: input.definition.name,
              sourceCwd: input.cwd,
            })
          ) {
            notify({ automationId: input.definition.id, threadId, reason: "pending-insert" });
          }
          yield* automation.runs.setThreadTitle(threadId, input.definition.name);
          yield* titles.set({ threadId, name: input.definition.name, normalization: "trim" }).pipe(
            Effect.catch((cause) =>
              Effect.sync(() =>
                logger.warn("Failed to set scheduled automation Thread title", {
                  automationId: input.definition.id,
                  threadId,
                  cause,
                }),
              ),
            ),
          );
          yield* turns.startAutomation(threadId, input.prompt, {
            ...(input.model ? { model: input.model } : {}),
            ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
            serviceTier: executionProfile?.serviceTier ?? null,
            summary: "auto",
          });
        });
        yield* threadStarts
          .materialize(capability.hostId, capability.generation, transaction, () => threadId)
          .pipe(
            Effect.onExit((exit) =>
              !Exit.isSuccess(exit) && threadId === null
                ? automation.runs
                    .archive({
                      threadId: pendingThreadId,
                      archivedReason: "auto",
                      archivedUserMessage: null,
                      archivedAssistantMessage: null,
                    })
                    .pipe(
                      Effect.tap((archived) =>
                        Effect.sync(() => {
                          if (archived) {
                            notify({
                              automationId: input.definition.id,
                              threadId: pendingThreadId,
                              reason: "archive",
                            });
                          }
                        }),
                      ),
                      Effect.andThen(
                        managedWorktreePath
                          ? managedWorktrees
                              .remove({
                                hostId: CODEX_APP_LOCAL_HOST_ID,
                                worktreeGitRoot: managedWorktreePath,
                                reason: "failed-create",
                              })
                              .pipe(Effect.ignore)
                          : Effect.void,
                      ),
                      Effect.asVoid,
                      Effect.ignore,
                    )
                : Effect.void,
            ),
          );
      });

      const startCron = Effect.fn("AutomationExecution.startCron")(function* (
        definition: CodexScheduledAutomation,
        context: AutomationRunContext,
      ) {
        const cwds = definition.cwds.map((cwd) => cwd.trim()).filter(Boolean);
        if (cwds.length === 0) return;
        if (context.reason === "run-now") {
          if (!(yield* automation.definitions.dispatchNow(definition.id))) {
            return yield* fail("dispatch-cron", "Automation not found.");
          }
        }
        const models = yield* composer.listModels.pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              logger.warn("Failed to load models for scheduled automation run", {
                automationId: definition.id,
                cause,
              });
              return [];
            }),
          ),
        );
        const settings = resolveCodexScheduledAutomationModelSettings({
          automation: definition,
          models: [...models],
        });
        const prompt = buildCodexScheduledAutomationRunPrompt(definition);
        const now = context.now ?? (yield* Clock.currentTimeMillis);
        let firstFailure: unknown = null;
        for (const cwd of cwds) {
          const result = yield* Effect.result(
            startCronRun({
              definition,
              cwd,
              prompt,
              model: settings.model,
              reasoningEffort: settings.reasoningEffort,
              now,
            }),
          );
          if (Result.isSuccess(result)) continue;
          firstFailure ??= result.failure;
          logger.warn("Scheduled automation run failed", {
            automationId: definition.id,
            cwd,
            cause: result.failure,
          });
        }
        if (firstFailure !== null) return yield* Effect.fail(firstFailure);
      });

      const execute = (definition: CodexScheduledAutomation, context: AutomationRunContext) =>
        protect(
          "execute",
          requireCodexAutomationBackend("execute", definition.backendBinding).pipe(
            Effect.andThen(
              definition.kind === "heartbeat"
                ? requireCodexHeartbeatTarget("execute", definition.targetThreadId).pipe(
                    Effect.andThen(gateway.awaitReady(gateway.localHostId)),
                    Effect.andThen(startHeartbeat(definition, context)),
                  )
                : gateway
                    .awaitReady(gateway.localHostId)
                    .pipe(Effect.andThen(startCron(definition, context))),
            ),
          ),
        );

      const resolveArchiveMessages = (
        threadId: string,
      ): Effect.Effect<AutomationArchiveMessages> => {
        const snapshot = conversations.read(threadId)?.snapshot ?? null;
        const local = snapshot
          ? resolveAutomationArchiveMessagesFromTranscript(
              snapshot.turns.flatMap((turn) => turn.items),
            )
          : { archivedUserMessage: null, archivedAssistantMessage: null };
        if (hasCompleteAutomationArchiveExchange(local)) return Effect.succeed(local);
        return readBoundedAutomationArchiveExcerpt(
          historyPages,
          capabilities,
          threadId,
          local,
        ).pipe(
          Effect.map((excerpt) => {
            if (excerpt.resolution === "truncated") {
              logger.warn("Automation archive excerpt reached its bounded read limit", {
                threadId,
                truncationReason: excerpt.truncationReason,
                inspectedTurnCount: excerpt.inspectedTurnCount,
                inspectedItemCount: excerpt.inspectedItemCount,
                approximateProjectedBytes: excerpt.approximateProjectedBytes,
              });
            }
            return excerpt.messages;
          }),
          Effect.catch((cause) =>
            Effect.sync(() => {
              logger.warn("Failed to read bounded Thread excerpt for Automation archive", {
                threadId,
                cause,
              });
              return local;
            }),
          ),
        );
      };

      return AutomationExecution.of({
        prepareDefinition,
        runNow: (input, rendererClientId = null) =>
          automation.definitions.get(input.id).pipe(
            Effect.flatMap((definition) =>
              Effect.gen(function* () {
                if (!definition) return yield* fail("run-now", "Automation not found.");
                const now = yield* Clock.currentTimeMillis;
                return yield* execute(definition, {
                  now,
                  reason: "run-now",
                  ...(definition.kind === "heartbeat"
                    ? {
                        heartbeat: {
                          automationsEnabled: true,
                          rendererState: rendererClientId
                            ? {
                                rendererClientId,
                                isEligible: true,
                                reason: null,
                                updatedAtMs: now,
                              }
                            : null,
                          collaborationMode: input.collaborationMode ?? null,
                          permissions: input.permissions ?? null,
                        },
                      }
                    : {}),
                });
              }),
            ),
            Effect.mapError((cause) => error("run-now", cause)),
          ),
        executeClaimed: execute,
        resolveArchiveMessages,
      });
    }),
  );
