import * as path from "node:path";
import type {
  ThreadResumeResponse,
  ThreadSettingsUpdateParams,
} from "@nodex/codex-app-server-protocol/v2";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createCodexCanonicalWorkspacePermissionContext } from "../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexCanonicalHydratedPermissionContext } from "../../shared/types";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { projectCodexGatewayThreadResumeResponse } from "../codex-runtime/CodexGatewayProtocolProjection";
import { buildCodexThreadConfigOverrides } from "../codex/codex-thread-capabilities";
import { rewriteExecutionWorkspaceRoots } from "../codex/codex-execution-workspace-roots";
import type { CodexThreadExecutionLocation } from "../codex/codex-thread-handoff-journal";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import type { ManagedWorktreeHandoffPreparation } from "./ManagedWorktreeHandoff";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { ConversationCommands } from "./ConversationCommands";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";

export class CodexThreadExecutionError extends Schema.TaggedError<CodexThreadExecutionError>()(
  "CodexThreadExecutionError",
  {
    operation: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Owns the live and durable execution location of one Codex Thread. */
export class CodexThreadExecution extends Context.Service<
  CodexThreadExecution,
  {
    readonly read: (
      threadId: string,
    ) => Effect.Effect<CodexThreadExecutionLocation, CodexThreadExecutionError>;
    readonly stop: (threadId: string) => Effect.Effect<void, CodexThreadExecutionError>;
    readonly switchRuntime: (
      threadId: string,
      location: CodexThreadExecutionLocation,
      preparation: ManagedWorktreeHandoffPreparation | null,
    ) => Effect.Effect<void, CodexThreadExecutionError>;
    /** Reconciles a same-host workspace move into the loaded runtime and canonical projection. */
    readonly relocate: (input: {
      readonly threadId: string;
      readonly loaded: boolean;
      readonly location: CodexThreadExecutionLocation;
    }) => Effect.Effect<void, CodexThreadExecutionError>;
    readonly commit: (
      threadId: string,
      location: CodexThreadExecutionLocation,
    ) => Effect.Effect<void, CodexThreadExecutionError>;
    readonly followUp: (
      threadId: string,
      prompt: string,
    ) => Effect.Effect<void, CodexThreadExecutionError>;
  }
>()("nodex/main/codex-application/CodexThreadExecution") {}

const resumePermissions = (context: CodexCanonicalHydratedPermissionContext) => ({
  approvalPolicy: context.approvalPolicy,
  approvalsReviewer: context.approvalsReviewer,
  ...(context.activePermissionProfile
    ? { permissions: context.activePermissionProfile.id }
    : {
        sandbox:
          context.sandboxPolicy.type === "dangerFullAccess"
            ? ("danger-full-access" as const)
            : context.sandboxPolicy.type === "readOnly"
              ? ("read-only" as const)
              : context.sandboxPolicy.type === "workspaceWrite"
                ? ("workspace-write" as const)
                : null,
      }),
  runtimeWorkspaceRoots: [...context.runtimeWorkspaceRoots],
});

const normalizeJson = (value: unknown): Schema.Json => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value !== "object") throw new Error("Thread configuration must contain JSON values");
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      entry === undefined ? [] : [[key, normalizeJson(entry)]],
    ),
  );
};

const assertResumeLocation = (
  threadId: string,
  location: CodexThreadExecutionLocation,
  response: ThreadResumeResponse,
): void => {
  if (response.thread.id !== threadId) {
    throw new Error(`Task handoff resumed unexpected task '${response.thread.id}'`);
  }
  if (path.resolve(response.cwd) !== path.resolve(location.cwd)) {
    throw new Error("Task handoff runtime did not accept the destination working directory");
  }
  const expectedRoots = location.workspaceRoots.map((root) => path.resolve(root));
  const actualRoots = response.runtimeWorkspaceRoots.map((root) => path.resolve(root));
  if (
    expectedRoots.length !== actualRoots.length ||
    expectedRoots.some((root, index) => root !== actualRoots[index])
  ) {
    throw new Error("Task handoff runtime did not accept the destination workspace roots");
  }
};

export const live: Layer.Layer<
  CodexThreadExecution,
  never,
  | CodexConversationProjection
  | CodexAppServerCapabilities
  | CodexGateway
  | CodexTurnCommands
  | ConversationCommands
  | ConversationEntityMap
  | CoreModules
  | DesktopToolRuntime
  | ExecutionHostRuntime
> = Layer.effect(
  CodexThreadExecution,
  Effect.gen(function* () {
    const projection = yield* CodexConversationProjection;
    const capabilities = yield* CodexAppServerCapabilities;
    const gateway = yield* CodexGateway;
    const turns = yield* CodexTurnCommands;
    const conversations = yield* ConversationCommands;
    const conversationRuntimes = yield* ConversationEntityMap;
    const core = yield* CoreModules;
    const tools = yield* DesktopToolRuntime;
    const executionHosts = yield* ExecutionHostRuntime;
    const error = (operation: string, threadId: string, cause: unknown) =>
      new CodexThreadExecutionError({ operation, threadId, cause });

    const read = (threadId: string) =>
      core.workspace.read({ kind: "thread", thread_id: threadId }).pipe(
        Effect.flatMap((snapshot) => {
          if (snapshot.value.kind !== "thread") {
            return Effect.fail(
              error(
                "read",
                threadId,
                new Error("Core returned a non-thread Workspace read variant"),
              ),
            );
          }
          const thread = snapshot.value.thread;
          if (thread.backend_binding.kind !== "codex") {
            return Effect.fail(
              error("read", threadId, new Error("Task handoff requires a native Codex Thread")),
            );
          }
          const cwd = thread.cwd?.trim() ?? "";
          const primary = thread.writable_roots[0]?.trim() ?? "";
          if (!cwd || !path.isAbsolute(cwd)) {
            return Effect.fail(
              error(
                "read",
                threadId,
                new Error("Task handoff requires an absolute working directory"),
              ),
            );
          }
          if (!primary || !path.isAbsolute(primary)) {
            return Effect.fail(
              error(
                "read",
                threadId,
                new Error("Task handoff requires a canonical primary workspace root"),
              ),
            );
          }
          return Effect.gen(function* () {
            const workspaceRoots = yield* Effect.try({
              try: () =>
                rewriteExecutionWorkspaceRoots({
                  sourcePrimary: primary,
                  targetPrimary: primary,
                  workspaceRoots: [primary, ...thread.writable_roots],
                }),
              catch: (cause) => error("read", threadId, cause),
            });
            const host = yield* executionHosts.get(thread.execution_host_id);
            if (!host) {
              return yield* error(
                "read",
                threadId,
                new Error(
                  `Execution host ${thread.execution_host_id} is unavailable for task handoff`,
                ),
              );
            }
            return {
              hostId: thread.execution_host_id,
              cwd,
              workspaceRoots,
              managedWorktreePath: thread.managed_worktree_path ?? null,
              projectId: thread.project_id ?? null,
              projectlessOutputDirectory: thread.projectless_output_directory ?? null,
              projectlessWorkspaceBrowserRoot: thread.projectless_workspace_browser_root ?? null,
            };
          });
        }),
        Effect.mapError((cause) =>
          cause instanceof CodexThreadExecutionError ? cause : error("read", threadId, cause),
        ),
      );

    const permissionContext = (threadId: string, workspaceRoots: readonly string[]) =>
      Effect.sync(() => {
        const existing = conversationRuntimes.current(threadId)?.readCanonicalState()?.sidecar
          .hydrationContext?.currentPermissions;
        if (!existing) return createCodexCanonicalWorkspacePermissionContext(workspaceRoots);
        return {
          ...existing,
          runtimeWorkspaceRoots: [...workspaceRoots],
          sandboxPolicy:
            existing.sandboxPolicy.type === "workspaceWrite"
              ? { ...existing.sandboxPolicy, writableRoots: [...workspaceRoots] }
              : existing.sandboxPolicy,
        } satisfies CodexCanonicalHydratedPermissionContext;
      });

    const switchRuntime = (
      threadId: string,
      location: CodexThreadExecutionLocation,
      preparation: ManagedWorktreeHandoffPreparation | null,
    ) =>
      Effect.gen(function* () {
        const capability = yield* capabilities.forHost(location.hostId);
        if (!capability.flags.paginatedHistory) {
          return yield* error(
            "switch-runtime",
            threadId,
            new Error("Task handoff requires bounded paginated history support"),
          );
        }
        const ensureCurrent = (snapshot: CodexAppServerCapabilitySnapshot) =>
          capabilities
            .isCurrent(snapshot)
            .pipe(
              Effect.flatMap((current) =>
                current
                  ? Effect.void
                  : Effect.fail(
                      error(
                        "switch-runtime",
                        threadId,
                        new Error("Task handoff host generation changed during runtime switch"),
                      ),
                    ),
              ),
            );
        const permissions = yield* permissionContext(threadId, location.workspaceRoots);
        let rolloutPath: string | null = null;
        if (preparation?.prepared.direction === "cross-host") {
          const prepared = preparation.prepared;
          rolloutPath =
            location.hostId === prepared.destinationHostId
              ? prepared.destinationRollout.path
              : location.hostId === prepared.sourceHostId
                ? prepared.sourceRollout.path
                : null;
          if (!rolloutPath) {
            return yield* error(
              "switch-runtime",
              threadId,
              new Error(`Cross-host handoff has no rollout for execution host ${location.hostId}`),
            );
          }
        } else {
          yield* ensureCurrent(capability);
          const metadata = yield* gateway.requestOnHost(
            location.hostId,
            "thread/read",
            {
              threadId,
              includeTurns: false,
            },
            codexGatewayGenerationFence(capability),
          );
          yield* ensureCurrent(capability);
          rolloutPath = metadata.thread.path ?? null;
          if (metadata.thread.status.type !== "notLoaded") {
            const settings: ThreadSettingsUpdateParams = {
              threadId,
              cwd: location.cwd,
              approvalPolicy: permissions.approvalPolicy,
              approvalsReviewer: permissions.approvalsReviewer,
              ...(permissions.activePermissionProfile
                ? { permissions: permissions.activePermissionProfile.id }
                : { sandboxPolicy: permissions.sandboxPolicy }),
            };
            yield* ensureCurrent(capability);
            yield* gateway.requestOnHost(
              location.hostId,
              "thread/settings/update",
              settings,
              codexGatewayGenerationFence(capability),
            );
            yield* ensureCurrent(capability);
          }
        }
        const toolConfig = yield* tools.threadConfig;
        const config = yield* Effect.try({
          try: () =>
            normalizeJson({
              ...(toolConfig ?? {}),
              ...buildCodexThreadConfigOverrides(),
            }) as Schema.JsonObject,
          catch: (cause) => error("switch-runtime", threadId, cause),
        });
        yield* ensureCurrent(capability);
        const response = projectCodexGatewayThreadResumeResponse(
          yield* gateway.requestOnHost(
            location.hostId,
            "thread/resume",
            {
              threadId,
              history: null,
              path: rolloutPath,
              cwd: location.cwd,
              config,
              excludeTurns: true,
              ...resumePermissions(permissions),
            },
            codexGatewayGenerationFence(capability),
          ),
        );
        yield* ensureCurrent(capability);
        yield* Effect.try({
          try: () => assertResumeLocation(threadId, location, response),
          catch: (cause) => error("switch-runtime", threadId, cause),
        });
        yield* projection.relocateExecution({
          threadId,
          cwd: location.cwd,
          managedWorktreePath: location.managedWorktreePath,
          projectId: location.projectId,
          projectlessOutputDirectory: location.projectlessOutputDirectory,
          projectlessWorkspaceBrowserRoot: location.projectlessWorkspaceBrowserRoot,
          permissions,
        });
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof CodexThreadExecutionError
            ? cause
            : error("switch-runtime", threadId, cause),
        ),
      );

    return CodexThreadExecution.of({
      read,
      stop: (threadId) =>
        projection.read(threadId).pipe(
          Effect.map(
            ({ canonical }) =>
              [...canonical.turns].reverse().find((turn) => turn.protocol.status === "inProgress")
                ?.protocol.id ?? null,
          ),
          Effect.flatMap((turnId) =>
            turnId ? conversations.interrupt(threadId, turnId).pipe(Effect.asVoid) : Effect.void,
          ),
          Effect.mapError((cause) => error("stop", threadId, cause)),
        ),
      switchRuntime,
      relocate: (input) =>
        Effect.gen(function* () {
          const permissions = yield* permissionContext(
            input.threadId,
            input.location.workspaceRoots,
          );
          if (input.loaded) {
            yield* gateway
              .requestOnHost(input.location.hostId, "thread/settings/update", {
                threadId: input.threadId,
                cwd: input.location.cwd,
                approvalPolicy: permissions.approvalPolicy,
                approvalsReviewer: permissions.approvalsReviewer,
                ...(permissions.activePermissionProfile
                  ? { permissions: permissions.activePermissionProfile.id }
                  : { sandboxPolicy: permissions.sandboxPolicy }),
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not reconcile a loaded task after workspace move").pipe(
                    Effect.annotateLogs({ threadId: input.threadId, cause: String(cause) }),
                  ),
                ),
              );
          }
          yield* projection.relocateExecution({
            threadId: input.threadId,
            cwd: input.location.cwd,
            managedWorktreePath: input.location.managedWorktreePath,
            projectId: input.location.projectId,
            projectlessOutputDirectory: input.location.projectlessOutputDirectory,
            projectlessWorkspaceBrowserRoot: input.location.projectlessWorkspaceBrowserRoot,
            permissions,
          });
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof CodexThreadExecutionError
              ? cause
              : error("relocate", input.threadId, cause),
          ),
        ),
      commit: (threadId, location) =>
        conversationRuntimes
          .runCommand(
            threadId,
            core.workspace
              .apply({
                operationId: createOperationId("thread-execution.handoff"),
                intent: {
                  kind: "set_thread_execution_location",
                  thread_id: threadId,
                  location: {
                    execution_host_id: location.hostId,
                    cwd: location.cwd,
                    managed_worktree_path: location.managedWorktreePath,
                    runtime_workspace_roots: [...location.workspaceRoots],
                    projectless_output_directory: location.projectlessOutputDirectory,
                    projectless_workspace_browser_root: location.projectlessWorkspaceBrowserRoot,
                  },
                },
              })
              .pipe(Effect.asVoid),
          )
          .pipe(Effect.mapError((cause) => error("commit", threadId, cause))),
      followUp: (threadId, prompt) =>
        turns.start(threadId, prompt).pipe(
          Effect.flatMap((turn) =>
            turn
              ? Effect.void
              : Effect.fail(
                  error(
                    "follow-up",
                    threadId,
                    new Error("The follow-up turn was not accepted after task handoff"),
                  ),
                ),
          ),
          Effect.mapError((cause) =>
            cause instanceof CodexThreadExecutionError
              ? cause
              : error("follow-up", threadId, cause),
          ),
        ),
    });
  }),
);
