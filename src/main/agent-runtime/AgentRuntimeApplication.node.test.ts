import { AgentRuntimeProcessError } from "../platform/node/AgentRuntimeProcess";
import { assert, it } from "@effect/vitest";
import { access, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { components } from "@nodex/core-protocol";
import type {
  AgentCommand,
  AgentRuntimeMethod,
  AgentRuntimeOperations,
  AgentSnapshot,
} from "@nodex/agent-runtime/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { CoreModules, live as coreModulesLive } from "../core-runtime/CoreModules";
import { CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { classifyCoreOperationFailure } from "../core-runtime/CoreRuntimeError";
import {
  withCoreScenario,
  type CoreScenarioContext,
} from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { createOperationId } from "../core-runtime/operation-identity";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreModuleResponseError } from "../core-client/core-client";
import { coreRuntimeError, type CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import type { ProjectWorkspaceApplyInput, ProjectWorkspaceRead } from "../core-client/types";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { ProjectWorkspace, ProjectWorkspaceError } from "../project-application/ProjectWorkspace";
import type { ProjectSession } from "../../shared/types";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
import type { NativeConversationImportInput } from "../../shared/native-session-catalog";
import { agentRuntimeSnapshotFixture } from "../../shared/testing/agent-runtime-snapshot";
import {
  make,
  AgentRuntimeApplicationError,
  type AgentRuntimeApplication,
  type AgentRuntimeLaunch,
  type AgentRuntimeApplicationConnection,
} from "./AgentRuntimeApplication";
import { make as makeProviderCatalog } from "./AgentRuntimeProviderCatalog";

type Binding = components["schemas"]["ProjectWorkspaceAgentRuntimeSessionBinding"];
const launch: AgentRuntimeLaunch = {
  launchId: "launch:one",
  acceptedAt: 1791993600000,
  sessionId: "session:one",
  projectId: "project",
  title: "Task",
  initialPageIds: ["page:linked"],
  modelSelection: { instanceId: "claude", model: "claude-sonnet" },
  interactionMode: "default",
  message: { messageId: "message:first", text: "Build it" },
};
const codexImport: NativeConversationImportInput & {
  readonly title: string;
  readonly model: string | null;
} = {
  backendKind: "codex",
  requestId: "019d0000-0000-7000-8000-000000000002",
  acceptedAt: 1791993600000,
  nativeSessionId: "019abcde-1234-7000-8000-123456789abc",
  expectedHome: "/native/codex",
  projectId: "project",
  cwd: "/replacement/imported",
  title: "Imported task",
  model: "model-b",
};

/** Tests consume the same admission outcome as renderer callers, with a prepared source fixture. */
const unwrapImported = (
  outcome: import("../../shared/native-session-catalog").NativeConversationImportOutcome,
) => {
  if (outcome.kind === "not_admitted")
    return Effect.fail(
      new AgentRuntimeApplicationError({
        operation: "import",
        message: outcome.message,
        admissionRejected: true,
      }),
    );
  const { kind: _kind, ...result } = outcome;
  return Effect.succeed(result);
};
const importConversation = (
  owner: AgentRuntimeApplication["Service"],
  input: NativeConversationImportInput & { readonly title: string; readonly model: string | null },
) =>
  owner
    .submitNativeImport(input, Effect.succeed({ title: input.title, model: input.model }))
    .pipe(Effect.flatMap(unwrapImported));
const recoverCompletedImport = (
  owner: AgentRuntimeApplication["Service"],
  input: NativeConversationImportInput,
) =>
  owner
    .submitNativeImport(
      input,
      Effect.fail(new Error("Completed recovery must not read the source")),
    )
    .pipe(Effect.flatMap(unwrapImported));

const snapshot = (
  threadId: string,
  rootThreadId = threadId,
  projectId = "project",
): AgentSnapshot =>
  agentRuntimeSnapshotFixture({
    snapshot: { snapshotSequence: 0, historyCursor: "cursor:older", hasMoreHistory: true },
    thread: {
      id: threadId,
      projectId,
      lineage:
        threadId === rootThreadId
          ? { rootThreadId, parentThreadId: null, relationshipToParent: null }
          : { rootThreadId, parentThreadId: rootThreadId, relationshipToParent: "subagent" },
    },
  });

const setExecutionHold = (fixture: ReturnType<typeof setup>, threadId: string, held: boolean) => {
  const current = fixture.snapshots.get(threadId)!;
  fixture.snapshots.set(threadId, {
    ...current,
    projection: {
      ...current.projection,
      thread: {
        ...current.projection.thread,
        executionHandoff: held ? { operationId: "handoff", recoveryRequired: true } : null,
      },
    },
  });
};

const setup = (
  options: Partial<import("./AgentRuntimeApplication").AgentRuntimeApplicationOptions> = {},
  additionalProviders: AgentRuntimeOperations["providers.read"]["output"] = [],
  importResources?: (
    input: AgentRuntimeOperations["attachments.import"]["input"],
  ) => Effect.Effect<AgentRuntimeOperations["attachments.import"]["output"], unknown>,
  coreWorkspace?: CoreModules["Service"]["workspace"],
) => {
  const bindings = new Map<string, Binding>();
  const titles = new Map<string, string>();
  const acceptedTexts = new Map<string, string>();
  const acceptedActors = new Map<string, "user" | "agent" | "system">();
  const publishedMessages = new Map<string, string[]>();
  const snapshots = new Map<string, AgentSnapshot>();
  const commands = new Map<string, AgentCommand>();
  const imports = new Map<string, AgentRuntimeOperations["thread.import-native"]["input"]>();
  const messageLaunches = new Map<
    string,
    NonNullable<AgentRuntimeOperations["thread.message-launch"]["output"]>
  >();
  const calls: Array<{ method: AgentRuntimeMethod; input: unknown }> = [];
  const applied: ProjectWorkspaceApplyInput[] = [];
  const receipt = new Map<string, string>();
  const actors: unknown[] = [];
  const order: string[] = [];
  const cleanups = new Map<
    string,
    {
      cleanup_id: string;
      session_id: string;
      project_id: string | null;
      runtime_id: string;
      runtime_thread_id: string;
      created_at: string;
    }
  >();
  const providers = [
    {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
      models: [
        {
          slug: "model-a",
          name: "Model A",
          isDefault: true,
          capabilities: {
            inputModalities: ["text", "image"],
            optionDescriptors: [
              {
                id: "reasoningEffort",
                type: "select",
                options: [{ id: "medium", isDefault: true }, { id: "high" }],
              },
              {
                id: "serviceTier",
                type: "select",
                options: [{ id: "default", isDefault: true }, { id: "fast" }],
              },
            ],
          },
        },
        {
          slug: "model-b",
          name: "Model B",
          capabilities: {
            inputModalities: ["text"],
            optionDescriptors: [
              { id: "reasoningEffort", type: "select", options: [{ id: "low", isDefault: true }] },
              {
                id: "serviceTier",
                type: "select",
                options: [{ id: "default", isDefault: true }, { id: "fast" }],
              },
            ],
          },
        },
      ],
    },
    ...additionalProviders,
  ] as unknown as AgentRuntimeOperations["providers.read"]["output"];
  const state = {
    archived: false,
    lifecycle: "active",
    mode: "auto",
    runtimeId: "engine",
    failMessage: false,
    admitMessageRuns: false,
    holdMessages: false,
    failTitleWrite: false,
    failThreadCreate: false,
    refuseSideChatSave: false,
    failSideChatSave: false,
    loseSideChatSaveReply: false,
    failCodexImportBeforeCommit: false,
    nativeSession: null as ProjectSession | null,
    nativeBackendSession: null as Awaited<
      Effect.Success<ReturnType<ProjectWorkspace["Service"]["readThreadBackendSession"]>>
    >,
    failCodexImportAcknowledgment: false,
    codexModelsAvailable: true,
    nativeImportSourceHome: codexImport.expectedHome,
    acpSourceFingerprint: "source-one",
    acpImported: false,
    refusedThreadReceipt: false,
    failCore: false,
    projectWorkspaceRoot: "/workspace" as string | null,
    failCoreAcknowledgment: false,
    failBindingProof: false,
    missingSessionLookupError: null as CoreRuntimeError | null,
    archiveAfterThreadCreate: false,
    replaceBindingProof: false,
    gateDepth: 0,
    denyAgent: false,
    failDeleteAcknowledgment: false,
    failCleanupAcknowledgment: false,
    failEngineDelete: false,
    failEngineArchive: false,
    generatedTitle: null as string | null,
    supersededTitle: false,
    supersededArchive: false,
    rollbackImmediate: true,
    rollbackFails: false,
    messageReplay: null as AgentRuntimeOperations["thread.message-replay"]["output"],
    nativeReceipt: null as AgentRuntimeOperations["native-message.receipt"]["output"],
  };
  const read = (input: ProjectWorkspaceRead) =>
    (input.kind === "agent_session" || input.kind === "agent_authority") && state.denyAgent
      ? Effect.fail(new Error("Session is outside the admitted Project"))
      : input.kind === "agent_runtime_session_binding_by_execution" && state.failBindingProof
        ? Effect.fail(new Error("Core binding proof is unavailable"))
        : input.kind === "agent_runtime_session_binding" &&
            !bindings.has(input.session_id) &&
            state.missingSessionLookupError
          ? Effect.fail(state.missingSessionLookupError)
          : Effect.sync(() => {
              if (input.kind === "agent_runtime_execution_cleanup_window")
                return {
                  value: {
                    kind: "agent_runtime_execution_cleanup_window",
                    cleanups: {
                      items: [...cleanups.values()].filter(
                        (cleanup) => cleanup.runtime_id === input.runtime_id,
                      ),
                      next_cursor: null,
                      has_more: false,
                    },
                  },
                };
              if (input.kind === "agent_session") {
                order.push("core.agent-session");
                return {
                  value: {
                    kind: "agent_session",
                    session: { archived: state.archived },
                    thread: null,
                  },
                };
              }
              if (input.kind === "agent_authority")
                return {
                  value: {
                    kind: "agent_authority",
                    resolution: {
                      authority: input.provenance.authority,
                      persisted: true,
                    },
                  },
                };
              if (input.kind === "project")
                return {
                  value: {
                    kind: "project",
                    project: {
                      id: input.project_id,
                      name: "Project",
                      primary_workspace_root: state.projectWorkspaceRoot,
                      lifecycle: state.lifecycle,
                      sources: [{ root: "/workspace", order: 0 }],
                    },
                  },
                };
              if (input.kind === "session")
                return {
                  value: {
                    kind: "session",
                    session: {
                      archived: state.archived,
                      display_title: titles.get(input.session_id) ?? "Task",
                    },
                  },
                };
              if (input.kind === "agent_runtime_session_binding")
                return {
                  value: {
                    kind: "agent_runtime_session_binding",
                    binding: bindings.get(input.session_id) ?? null,
                  },
                };
              if (input.kind === "agent_runtime_session_binding_window")
                return {
                  value: {
                    kind: "agent_runtime_session_binding_window",
                    bindings: {
                      items: [...bindings.values()].filter(
                        (binding) =>
                          binding.runtime_id === input.runtime_id &&
                          (input.temporary_only
                            ? binding.side_chat_source_session_id !== undefined
                            : (binding.project_id ?? null) === (input.project_id ?? null)),
                      ),
                      next_cursor: null,
                      authority: { projection_revision: 1 },
                    },
                  },
                };
              if (input.kind === "agent_runtime_session_binding_by_execution") {
                return {
                  value: {
                    kind: "agent_runtime_session_binding",
                    binding: state.replaceBindingProof
                      ? {
                          ...[...bindings.values()][0]!,
                          session_id: "another-session",
                        }
                      : ([...bindings.values()].find(
                          (binding) =>
                            binding.runtime_id === input.runtime_id &&
                            binding.runtime_thread_id === input.runtime_thread_id,
                        ) ?? null),
                  },
                };
              }
              throw new Error("Unexpected Core read");
            });
  const apply = (input: ProjectWorkspaceApplyInput) =>
    Effect.gen(function* () {
      actors.push(yield* CoreApplicationAgent);
      if (state.failCore) return yield* Effect.fail(new Error("Core refused Page access"));
      if (
        state.failTitleWrite &&
        input.intent.kind === "mutate_session" &&
        input.intent.intent.kind === "set_fallback_title"
      )
        return yield* Effect.fail(new Error("Core title storage unavailable"));
      if (
        input.intent.kind === "acknowledge_agent_runtime_execution_cleanup" &&
        state.failCleanupAcknowledgment
      )
        return yield* Effect.fail(new Error("Core cleanup acknowledgment unavailable"));
      const encoded = JSON.stringify(input.intent);
      const previous = receipt.get(input.operationId);
      if (previous !== undefined && previous !== encoded)
        return yield* Effect.fail(new Error("Immutable request changed"));
      if (previous !== undefined) return {};
      applied.push(input);
      receipt.set(input.operationId, encoded);
      const intent = input.intent;
      if (intent.kind === "acknowledge_agent_runtime_execution_cleanup") {
        cleanups.delete(intent.cleanup_id);
        return {};
      }
      if (intent.kind === "move_session") {
        const binding = bindings.get(intent.session_id);
        if (binding) bindings.set(intent.session_id, { ...binding, project_id: intent.project_id });
        return {};
      }
      if (intent.kind === "mutate_session" && intent.intent.kind === "set_fallback_title") {
        const current = titles.get(intent.session_id) ?? "Task";
        if (intent.intent.replaces == null || current === intent.intent.replaces)
          titles.set(intent.session_id, intent.intent.title);
        return {};
      }
      if (
        intent.kind !== "create_agent_runtime_session" &&
        intent.kind !== "adopt_native_session_execution"
      )
        throw new Error("Unexpected Core intent");
      bindings.set(intent.session_id, {
        session_id: intent.session_id,
        project_id: intent.project_id,
        runtime_id: intent.runtime_id,
        runtime_thread_id: intent.runtime_thread_id,
        launch_request_id: intent.launch_request_id,
        bound_at: "2026-10-14T00:00:00Z",
        ...(intent.kind === "create_agent_runtime_session" && intent.side_chat_source_session_id
          ? { side_chat_source_session_id: intent.side_chat_source_session_id }
          : {}),
      });
      if (intent.kind === "create_agent_runtime_session")
        titles.set(intent.session_id, intent.title);
      order.push("core.bind");
      if (state.failCoreAcknowledgment)
        return yield* Effect.fail(new Error("Core binding committed before disconnect"));
      return {};
    });
  const request = <M extends AgentRuntimeMethod>(
    method: M,
    input: AgentRuntimeOperations[M]["input"],
  ) =>
    Effect.gen(function* () {
      assert.equal(
        state.gateDepth,
        0,
        "A callback-capable runtime request must not retain the Project permit",
      );
      calls.push({ method, input });
      order.push(method);
      if (method === "acp.sessions.prepareImport")
        return {
          threadId: `nodex:thread:acp-${state.acpSourceFingerprint}`,
          sourceFingerprint: state.acpSourceFingerprint,
          cwd: "/workspace",
          title: "ACP conversation",
          canLoad: true,
          canResume: false,
          imported: state.acpImported,
        } as AgentRuntimeOperations[M]["output"];
      if (method === "acp.sessions.import") {
        const request = input as AgentRuntimeOperations["acp.sessions.import"]["input"];
        state.acpImported = true;
        return { threadId: request.threadId } as AgentRuntimeOperations[M]["output"];
      }
      if (method === "providers.read")
        return (
          state.codexModelsAvailable
            ? providers
            : providers.map((provider) => ({ ...provider, models: [] }))
        ) as AgentRuntimeOperations[M]["output"];
      if (method === "native-imports.find") {
        const query = input as AgentRuntimeOperations["native-imports.find"]["input"];
        return {
          imports: [...imports.values()]
            .filter(
              (entry) =>
                entry.backendKind === query.backendKind &&
                entry.sourceHome === query.sourceHome &&
                query.nativeThreadIds.includes(entry.sourceNativeThreadId),
            )
            .map((entry) => ({
              sourceNativeThreadId: entry.sourceNativeThreadId,
              threadId: entry.threadId,
            })),
        } as AgentRuntimeOperations[M]["output"];
      }
      if (method === "thread.import-native") {
        const request = input as AgentRuntimeOperations["thread.import-native"]["input"];
        if (state.failCodexImportBeforeCommit) {
          state.failCodexImportBeforeCommit = false;
          return yield* Effect.fail(new Error("Runtime stopped before importing history"));
        }
        if (!imports.has(request.commandId)) {
          imports.set(request.commandId, request);
          const imported = snapshot(request.threadId, request.threadId, request.projectId);
          snapshots.set(request.threadId, {
            ...imported,
            projection: {
              ...imported.projection,
              thread: {
                ...imported.projection.thread,
                modelSelection: request.modelSelection,
                worktreePath: request.cwd,
                interactionMode: request.interactionMode ?? "default",
                historyOrigin: "native_import",
                executionHandoff: null,
              },
            },
          });
        }
        if (state.failCodexImportAcknowledgment) {
          state.failCodexImportAcknowledgment = false;
          return yield* Effect.fail(new Error("Runtime reply lost after importing history"));
        }
        return { threadId: request.threadId } as AgentRuntimeOperations[M]["output"];
      }
      if (method === "native.prediction.clear") return null as AgentRuntimeOperations[M]["output"];
      if (method === "native-message.receipt" || method === "native-message.reserve")
        return state.nativeReceipt as AgentRuntimeOperations[M]["output"];
      if (method === "thread.message-stage") {
        const { resources, ...request } =
          input as AgentRuntimeOperations["thread.message-stage"]["input"];
        const imported = importResources
          ? yield* importResources({
              threadId: request.threadId,
              messageId: request.messageId,
              attachments: resources,
            })
          : null;
        const staged = messageLaunches.get(request.messageId) ?? {
          ...request,
          message: {
            ...request.message,
            attachments: [
              ...request.message.attachments,
              ...(imported?.attachments ??
                resources.map((resource, index) => ({
                  type: resource.mimeType.startsWith("image/")
                    ? ("image" as const)
                    : ("file" as const),
                  id: `staged_${index}`,
                  name: resource.name,
                  mimeType: resource.mimeType,
                  sizeBytes: resource.sizeBytes,
                }))),
            ],
          },
        };
        messageLaunches.set(request.messageId, staged);
        return staged as AgentRuntimeOperations[M]["output"];
      }
      if (method === "thread.message-launch")
        return (messageLaunches.get((input as { messageId: string }).messageId) ??
          null) as AgentRuntimeOperations[M]["output"];
      if (method === "thread.message-replay") {
        if (state.messageReplay) return state.messageReplay as AgentRuntimeOperations[M]["output"];
        const request = input as AgentRuntimeOperations["thread.message-replay"]["input"];
        return (
          messageLaunches.has(request.messageId) && commands.has(request.commandId)
            ? {
                messageId: request.messageId,
                runId: "run:launched",
                status: "running",
                delivery: "started",
              }
            : null
        ) as AgentRuntimeOperations[M]["output"];
      }
      if (method === "thread.message-admit")
        return { admitted: true } as AgentRuntimeOperations[M]["output"];
      if (method === "command.receipt") {
        const request = input as AgentRuntimeOperations["command.receipt"]["input"];
        if (imports.has(request.commandId))
          return {
            status: "accepted",
            sequence: 1,
            error: null,
          } as AgentRuntimeOperations[M]["output"];
        const admitted = commands.get(request.commandId);
        if (admitted?.type === "thread.create" && state.refusedThreadReceipt)
          return {
            status: "rejected",
            sequence: commands.size,
            error: "Model unavailable",
          } as AgentRuntimeOperations[M]["output"];
        return (
          admitted ? { status: "accepted", sequence: commands.size, error: null } : null
        ) as AgentRuntimeOperations[M]["output"];
      }
      if (method === "text.generate-structured")
        return (
          state.generatedTitle === null
            ? yield* Effect.fail(new Error("No title model"))
            : { title: state.generatedTitle, description: "Login fix" }
        ) as AgentRuntimeOperations[M]["output"];
      if (method === "command.dispatch") {
        const command = (input as AgentRuntimeOperations["command.dispatch"]["input"]).command;
        if (command.type === "thread.delete" && state.failEngineDelete)
          return yield* Effect.fail(new Error("Engine disconnected before deletion"));
        if (command.type === "thread.archive" && state.failEngineArchive)
          return yield* Effect.fail(new Error("Engine stopped before archiving"));
        if (command.type === "thread.create" && state.failThreadCreate) {
          state.failThreadCreate = false;
          return yield* Effect.fail(new Error("Process stopped after the Session was bound"));
        }
        if (command.type === "message.dispatch" && state.failMessage) {
          state.failMessage = false;
          return yield* Effect.fail(new Error("Connection closed after Thread creation"));
        }
        if (command.type === "thread.fork" && command.saveSideChat && state.failSideChatSave) {
          state.failSideChatSave = false;
          return yield* Effect.fail(new Error("Save transport unavailable"));
        }
        if (commands.has(command.commandId))
          return { sequence: commands.size } as AgentRuntimeOperations[M]["output"];
        commands.set(command.commandId, command);
        if (command.type === "thread.create") {
          order.push("engine.thread.create");
          const created = snapshot(command.threadId, command.threadId, command.projectId);
          snapshots.set(command.threadId, {
            ...created,
            projection: {
              ...created.projection,
              thread: {
                ...created.projection.thread,
                modelSelection: command.modelSelection,
                runtimeMode: command.runtimeMode,
                interactionMode: command.interactionMode,
                branch: command.branch,
                worktreePath: command.worktreePath,
              },
            },
          });
          if (state.archiveAfterThreadCreate) state.lifecycle = "archived";
        }
        if (command.type === "message.dispatch") {
          order.push("engine.message.dispatch");
          if (command.dispatchMode.type === "defer_start" || state.admitMessageRuns) {
            acceptedTexts.set(JSON.stringify([command.threadId, command.messageId]), command.text);
            acceptedActors.set(
              JSON.stringify([command.threadId, command.messageId]),
              command.createdBy,
            );
            const current = snapshots.get(command.threadId)!;
            const blocked =
              state.holdMessages ||
              current.projection.runs.some((run) =>
                ["preparing", "starting", "running", "waiting"].includes(run.status),
              );
            if (!blocked)
              publishedMessages.set(command.threadId, [
                ...(publishedMessages.get(command.threadId) ?? []),
                command.messageId,
              ]);
            snapshots.set(command.threadId, {
              ...current,
              projection: {
                ...current.projection,
                runs: [
                  ...current.projection.runs,
                  {
                    id: `run:${command.messageId}`,
                    userMessageId: command.messageId,
                    status:
                      command.dispatchMode.type === "defer_start"
                        ? "preparing"
                        : blocked
                          ? "queued"
                          : "starting",
                    ordinal: current.projection.runs.length + 1,
                  } as never,
                ],
              },
            });
          }
        }
        if (command.type === "queue.resume" && state.admitMessageRuns) {
          const current = snapshots.get(command.threadId)!;
          const blocked = current.projection.runs.some((run) =>
            ["preparing", "starting", "running", "waiting"].includes(run.status),
          );
          const queued =
            !blocked &&
            current.projection.runs.find(
              (run) =>
                run.status === "queued" &&
                (command.runId === undefined || run.id === command.runId),
            );
          if (queued) {
            publishedMessages.set(command.threadId, [
              ...(publishedMessages.get(command.threadId) ?? []),
              queued.userMessageId,
            ]);
            snapshots.set(command.threadId, {
              ...current,
              projection: {
                ...current.projection,
                runs: current.projection.runs.map((run) =>
                  run.id === queued.id ? { ...run, status: "starting" } : run,
                ),
              },
            });
          }
        }
        if (
          command.type === "prepared-run.release" ||
          command.type === "prepared-run.fail" ||
          command.type === "prepared-run.retry"
        ) {
          const current = snapshots.get(command.threadId)!;
          const status =
            command.type === "prepared-run.release"
              ? "starting"
              : command.type === "prepared-run.fail"
                ? "failed"
                : "preparing";
          snapshots.set(command.threadId, {
            ...current,
            projection: {
              ...current.projection,
              runs: current.projection.runs.map((run) =>
                run.id === command.runId ? ({ ...run, status } as never) : run,
              ),
            },
          });
        }
        if (
          command.type === "thread.archive" ||
          command.type === "thread.unarchive" ||
          command.type === "thread.delete" ||
          command.type === "thread.metadata.update"
        ) {
          const current = snapshots.get(command.threadId);
          if (current)
            snapshots.set(command.threadId, {
              ...current,
              projection: {
                ...current.projection,
                thread: {
                  ...current.projection.thread,
                  ...(command.type === "thread.archive"
                    ? { archivedAt: "2026-10-14T00:00:00Z" }
                    : {}),
                  ...(command.type === "thread.unarchive" ? { archivedAt: null } : {}),
                  ...(command.type === "thread.delete"
                    ? { deletedAt: "2026-10-14T00:00:00Z" }
                    : {}),
                  ...(command.type === "thread.metadata.update"
                    ? {
                        ...(command.title === undefined ? {} : { title: command.title }),
                        ...(command.projectId === undefined
                          ? {}
                          : { projectId: command.projectId }),
                        ...(command.worktreePath === undefined
                          ? {}
                          : { worktreePath: command.worktreePath }),
                        ...(command.branch === undefined ? {} : { branch: command.branch }),
                      }
                    : {}),
                },
              },
            });
          if (command.type === "thread.metadata.update" && command.projectId !== undefined)
            for (const [id, child] of snapshots) {
              if (
                id === command.threadId ||
                child.projection.thread.lineage.rootThreadId !== command.threadId
              )
                continue;
              snapshots.set(id, {
                ...child,
                projection: {
                  ...child.projection,
                  thread: { ...child.projection.thread, projectId: command.projectId },
                },
              });
            }
        }
        if (command.type === "thread.fork") {
          const source = snapshots.get(command.sourceThreadId)!;
          const independent = command.rootPolicy === "independent_root";
          snapshots.set(command.targetThreadId, {
            ...source,
            projection: {
              ...source.projection,
              thread: {
                ...source.projection.thread,
                id: command.targetThreadId,
                title: command.title ?? source.projection.thread.title,
                sideChat: command.sideChat
                  ? { sourceThreadId: command.sourceThreadId, sourceRunId: null, nativeFork: false }
                  : undefined,
                capturedContext: command.sideChat || command.saveSideChat ? true : undefined,
                lineage: {
                  rootThreadId: independent
                    ? command.targetThreadId
                    : source.projection.thread.lineage.rootThreadId,
                  parentThreadId: independent ? null : command.sourceThreadId,
                  relationshipToParent: independent ? null : "fork",
                },
                forkedFrom: {
                  type: "run",
                  threadId: command.sourceThreadId,
                  runId: command.sourcePoint.type === "run" ? command.sourcePoint.runId : "latest",
                },
              },
              runs: [],
            },
          });
          if (command.saveSideChat && state.loseSideChatSaveReply) {
            state.loseSideChatSaveReply = false;
            return yield* Effect.fail(new Error("Save reply lost after commit"));
          }
        }
        return { sequence: commands.size } as AgentRuntimeOperations[M]["output"];
      }
      if (method === "thread.read") {
        const value = snapshots.get((input as { threadId: string }).threadId);
        if (!value) return null as AgentRuntimeOperations[M]["output"];
        const active = value.projection.runs.findLast((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        );
        return {
          ...value.projection.thread,
          activeRunId: active?.id ?? null,
          status: active?.status ?? "idle",
        } as AgentRuntimeOperations[M]["output"];
      }
      if (method === "thread.fork-source") {
        const request = input as AgentRuntimeOperations["thread.fork-source"]["input"];
        const runs = snapshots.get(request.threadId)?.projection.runs ?? [];
        return (runs.findLast(
          (run) =>
            (request.runId === undefined || run.id === request.runId) &&
            ["completed", "waiting", "failed", "interrupted", "cancelled"].includes(run.status),
        )?.id ?? null) as AgentRuntimeOperations[M]["output"];
      }
      if (method === "thread.side-chat-save-source") {
        if (state.refuseSideChatSave)
          return yield* Effect.fail(new Error("Side chat has pending work"));
        const { threadId } =
          input as AgentRuntimeOperations["thread.side-chat-save-source"]["input"];
        return (snapshots.get(threadId)?.projection.runs.at(-1)?.id ??
          null) as AgentRuntimeOperations[M]["output"];
      }
      if (method === "thread.rollback") {
        const request = input as AgentRuntimeOperations["thread.rollback"]["input"];
        const current = snapshots.get(request.threadId)!;
        const run = current.projection.runs.find((run) => run.id === request.runId)!;
        const commandId = `rollback:${request.requestId}`;
        snapshots.set(request.threadId, {
          ...current,
          projection: {
            ...current.projection,
            thread: {
              ...current.projection.thread,
              ...(state.rollbackFails
                ? { rollbackFailure: { requestId: commandId, message: "Native rollback refused" } }
                : {}),
            },
            runs: current.projection.runs.map((value) =>
              value.id === run.id && state.rollbackImmediate && !state.rollbackFails
                ? { ...value, status: "rolled_back" as const }
                : value,
            ),
          },
        });
        return {
          commandId,
          userMessageId: run.userMessageId,
          sequence: 1,
        } as AgentRuntimeOperations[M]["output"];
      }
      if (method === "thread.authority") {
        const request = input as { threadId: string; runId: string };
        const run = snapshots
          .get(request.threadId)
          ?.projection.runs.find((candidate) => candidate.id === request.runId);
        return (run ? { status: run.status } : null) as AgentRuntimeOperations[M]["output"];
      }
      if (method === "execution.activity")
        return {
          snapshotSequence: 1,
          items: [...snapshots.values()].flatMap((value) => {
            const active = value.projection.runs.find((run) =>
              ["preparing", "starting", "running", "waiting"].includes(run.status),
            );
            return active
              ? [
                  {
                    rootThreadId: value.projection.thread.id,
                    status: "running",
                    activeRunId: active.id,
                    pendingRequestCount: 0,
                    activeTaskCount: 0,
                    resumesAutomatically: false,
                    providerInstanceId: "codex",
                    model: "model-a",
                    updatedAt: "2026-10-14T00:00:00Z",
                  },
                ]
              : [];
          }),
          nextCursor: null,
        } as unknown as AgentRuntimeOperations[M]["output"];
      if (method === "run.outcome") {
        const request = input as AgentRuntimeOperations["run.outcome"]["input"];
        const run = snapshots
          .get(request.threadId)
          ?.projection.runs.find((run) => run.userMessageId === request.messageId);
        return (
          run
            ? { runId: run.id, status: run.status, completedAt: null, finalAssistantItemId: null }
            : null
        ) as AgentRuntimeOperations[M]["output"];
      }
      if (method === "thread.snapshot" || method === "thread.control") {
        const value = snapshots.get((input as { threadId: string }).threadId);
        if (!value) return yield* Effect.fail(new Error("Thread missing"));
        return value as AgentRuntimeOperations[M]["output"];
      }
      if (method === "thread.run-message" && state.admitMessageRuns) {
        const request = input as AgentRuntimeOperations["thread.run-message"]["input"];
        const run = snapshots
          .get(request.threadId)
          ?.projection.runs.find((value) => value.id === request.runId);
        const text =
          run && acceptedTexts.get(JSON.stringify([request.threadId, run.userMessageId]));
        return (
          text === undefined ? null : { role: "user", text }
        ) as AgentRuntimeOperations[M]["output"];
      }
      if (method === "thread.opening-request") {
        const { threadId } = input as AgentRuntimeOperations["thread.opening-request"]["input"];
        const messageId = publishedMessages.get(threadId)?.[0];
        const key = JSON.stringify([threadId, messageId]);
        const text = acceptedTexts.get(key);
        const run = snapshots
          .get(threadId)
          ?.projection.runs.find((run) => run.userMessageId === messageId);
        return (
          text === undefined
            ? null
            : {
                id: messageId,
                threadId,
                runId: run?.id,
                role: "user",
                text,
                createdBy: acceptedActors.get(key) ?? "user",
              }
        ) as AgentRuntimeOperations[M]["output"];
      }
      if (method === "thread.queued-preview") {
        const request = input as AgentRuntimeOperations["thread.queued-preview"]["input"];
        const projection = snapshots.get(request.threadId)?.projection;
        const run = projection?.runs.find(
          (run) => run.id === request.runId && run.status === "queued",
        );
        const message = projection?.messages.find((message) => message.id === run?.userMessageId);
        return (
          run && message
            ? {
                threadId: request.threadId,
                runId: run.id,
                messageId: message.id,
                text: message.text,
                images: message.attachments.filter((attachment) => attachment.type === "image"),
              }
            : null
        ) as AgentRuntimeOperations[M]["output"];
      }
      if (method === "project.close")
        return { closedBindings: 2 } as AgentRuntimeOperations[M]["output"];
      if (method === "project.roots") {
        const { projectId } = input as AgentRuntimeOperations["project.roots"]["input"];
        return {
          threadIds: [...snapshots.values()]
            .map((value) => value.projection.thread)
            .filter(
              (thread) =>
                thread.projectId === projectId && thread.id === thread.lineage.rootThreadId,
            )
            .map((thread) => thread.id),
          nextCursor: null,
        } as AgentRuntimeOperations[M]["output"];
      }
      if (method === "project.activity")
        return {
          snapshotSequence: 3,
          run: null,
          runtimeRequest: null,
          nativeBackground: null,
        } as AgentRuntimeOperations[M]["output"];
      if (method === "thread.compact") {
        const request = input as AgentRuntimeOperations["thread.compact"]["input"];
        return {
          commandId: `compact:${request.requestId}`,
          messageId: `message:${request.requestId}`,
          runId: `run:${request.requestId}`,
          sequence: 1,
        } as AgentRuntimeOperations[M]["output"];
      }
      if (method === "thread.history")
        return {
          snapshotSequence: 9,
          items: [],
          nextCursor: "next",
          hasMoreHistory: true,
        } as AgentRuntimeOperations[M]["output"];
      if (method === "attachments.import") {
        const request = input as AgentRuntimeOperations["attachments.import"]["input"];
        if (importResources)
          return (yield* importResources(request)) as AgentRuntimeOperations[M]["output"];
        return {
          attachments: request.attachments.map((attachment, index) => ({
            type: attachment.mimeType.startsWith("image/") ? "image" : "file",
            id: `imported_${index}`,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          })),
        } as AgentRuntimeOperations[M]["output"];
      }
      if (method === "thread.send") {
        const request = input as AgentRuntimeOperations["thread.send"]["input"];
        if (state.admitMessageRuns) {
          const current = snapshots.get(request.threadId)!;
          const existing = current.projection.runs.find(
            (run) => run.userMessageId === request.messageId,
          );
          if (!existing) {
            commands.set(request.commandId, {
              type: "message.dispatch",
              commandId: request.commandId,
              threadId: request.threadId,
              messageId: request.messageId,
              text: request.text,
              attachments: request.attachments,
              dispatchMode: {
                type: request.mode === "queue" ? "queue_after_active" : "start_immediately",
              },
              createdBy: request.createdBy,
              creationSource: request.createdBy === "agent" ? "mcp" : "web",
            });
            acceptedTexts.set(JSON.stringify([request.threadId, request.messageId]), request.text);
            acceptedActors.set(
              JSON.stringify([request.threadId, request.messageId]),
              request.createdBy,
            );
            if (request.mode !== "queue")
              publishedMessages.set(request.threadId, [
                ...(publishedMessages.get(request.threadId) ?? []),
                request.messageId,
              ]);
            snapshots.set(request.threadId, {
              ...current,
              projection: {
                ...current.projection,
                runs: [
                  ...current.projection.runs,
                  {
                    id: `run:${request.messageId}`,
                    userMessageId: request.messageId,
                    status: request.mode === "queue" ? "queued" : "starting",
                    ordinal: current.projection.runs.length + 1,
                  } as never,
                ],
              },
            });
          }
          return {
            messageId: request.messageId,
            runId: existing?.id ?? `run:${request.messageId}`,
            status: request.mode === "queue" ? "queued" : "starting",
            delivery: request.mode === "queue" ? "queued" : "started",
          } as AgentRuntimeOperations[M]["output"];
        }
        return {
          messageId: request.messageId,
          runId: "run:canonical-delivery",
          status: "queued",
          delivery: "queued",
        } as AgentRuntimeOperations[M]["output"];
      }
      if (method === "attachments.persist")
        return {
          attachments: (
            input as AgentRuntimeOperations["attachments.persist"]["input"]
          ).attachments.map((attachment, index) => ({
            type: "image",
            id: `asset_${index}`,
            mimeType: attachment.mimeType,
            name: attachment.name,
            sizeBytes: attachment.sizeBytes,
          })),
        } as AgentRuntimeOperations[M]["output"];
      if (method === "thread.item" || method === "thread.item.full")
        return null as AgentRuntimeOperations[M]["output"];
      if (method === "thread.attachment")
        return { path: "/managed/attachment.png" } as AgentRuntimeOperations[M]["output"];
      return { id: "project" } as AgentRuntimeOperations[M]["output"];
    });
  const connection = (): AgentRuntimeApplicationConnection => ({
    identity: {
      runtimeId: state.runtimeId,
      runtimeGeneration: "process",
      schemaVersion: 1,
      databasePath: "/runtime/db",
      mcpEndpoint: "http://127.0.0.1",
      lastSequence: 0,
    },
    request,
  });
  const sessionValue = (sessionId: string): ProjectSession => {
    const binding = bindings.get(sessionId);
    return {
      id: sessionId,
      projectId: binding?.project_id ?? "project",
      archived: state.archived,
      noThreadFallbackTitle: titles.get(sessionId) ?? "Task",
      executionRef: binding
        ? { runtimeId: binding.runtime_id, threadId: binding.runtime_thread_id }
        : null,
    } as ProjectSession;
  };
  const mutateSession = <A>(method: string, mutate: () => A) =>
    Effect.gen(function* () {
      order.push(`core.${method}`);
      if (state.failCore || state.denyAgent)
        return yield* Effect.fail(new Error("Core rejected Session mutation"));
      return { value: yield* Effect.try(mutate), apply: {} as never };
    }).pipe(Effect.mapError((cause) => new ProjectWorkspaceError({ operation: method, cause })));
  const owner = make({
    ...options,
    nativeImportSourceHome:
      options.nativeImportSourceHome ??
      ((connection) =>
        Effect.sync(() => {
          assert.equal(connection.identity.runtimeId, state.runtimeId);
          order.push("codex.import-source-home");
          return state.nativeImportSourceHome;
        })),
    connect: options.connect ?? Effect.sync(connection),
    currentConnection: options.currentConnection ?? Effect.sync(connection),
    projectless: options.projectless ?? {
      engineProjectId: "profile:projectless",
      workspaceRoot: "/tasks",
      ensureWorkspaceRoot: Effect.void,
    },
  }).pipe(
    Effect.provideService(CoreModules, { workspace: coreWorkspace ?? { read, apply } } as never),
    Effect.provideService(ProjectWorkspace, {
      getProjectSession: (id: string) =>
        Effect.succeed(
          state.nativeSession?.id === id && !bindings.has(id)
            ? state.nativeSession
            : sessionValue(id),
        ),
      readThreadBackendSession: (id: string) =>
        Effect.succeed(
          state.nativeBackendSession?.threadId === id ? state.nativeBackendSession : null,
        ),
      renameProjectSession: (command) =>
        mutateSession("rename", () => {
          const title = state.supersededTitle ? "Newer title" : command.payload.input.title.trim();
          titles.set(command.payload.sessionId, title);
          return sessionValue(command.payload.sessionId);
        }),
      archiveProjectSession: (command) =>
        mutateSession("archive", () => {
          state.archived = !state.supersededArchive;
          return sessionValue(command.payload.sessionId);
        }),
      unarchiveProjectSession: (command) =>
        mutateSession("unarchive", () => {
          state.archived = state.supersededArchive;
          return sessionValue(command.payload.sessionId);
        }),
      setProjectSessionPinned: (command) =>
        mutateSession("pin", () => sessionValue(command.payload.sessionId)),
      deleteProjectSession: (command) =>
        mutateSession("delete", () => {
          const binding = bindings.get(command.payload.sessionId);
          if (binding) {
            cleanups.set(command.payload.sessionId, {
              cleanup_id: command.payload.sessionId,
              session_id: command.payload.sessionId,
              project_id: binding.project_id ?? null,
              runtime_id: binding.runtime_id,
              runtime_thread_id: binding.runtime_thread_id,
              created_at: "2026-10-14T00:00:00Z",
            });
            bindings.delete(command.payload.sessionId);
          }
          if (state.failDeleteAcknowledgment)
            throw new Error("Core reply lost after committed deletion");
          return true;
        }),
    } satisfies Partial<ProjectWorkspace["Service"]> as unknown as ProjectWorkspace["Service"]),
    Effect.provideService(ProjectRuntimeLifecycleRuntime, {
      runExclusive: (_projectId, operation) =>
        Effect.sync(() => {
          state.gateDepth += 1;
        }).pipe(
          Effect.andThen(operation),
          Effect.ensuring(
            Effect.sync(() => {
              state.gateDepth -= 1;
            }),
          ),
        ),
    }),
    Effect.provide(NodeServices.layer),
  );
  return {
    owner,
    bindings,
    titles,
    snapshots,
    commands,
    imports,
    calls,
    applied,
    actors,
    order,
    state,
    cleanups,
  };
};

it.effect("resolves busy execution roots to their existing product Sessions without new work", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    const created = yield* owner.launch(launch);
    const commandCount = fixture.commands.size;
    assert.deepEqual(
      yield* owner.sessionsForThreads([created.threadId, "missing", created.threadId]),
      [{ sessionId: launch.sessionId, threadId: created.threadId }],
    );
    assert.equal(fixture.commands.size, commandCount);
  }),
);

it.effect("binds an independent imported chat before reading its history into the Runtime", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    const result = yield* importConversation(owner, codexImport);
    assert.equal(result.sessionId, codexImport.requestId);
    assert.equal(result.projectId, codexImport.projectId);
    assert.notEqual(result.threadId, codexImport.nativeSessionId);
    assert.equal(fixture.bindings.get(result.sessionId)?.runtime_thread_id, result.threadId);
    assert.isBelow(
      fixture.order.indexOf("codex.import-source-home"),
      fixture.order.indexOf("providers.read"),
    );
    assert.isBelow(
      fixture.order.indexOf("codex.import-source-home"),
      fixture.order.indexOf("core.bind"),
    );
    assert.isBelow(
      fixture.order.indexOf("core.bind"),
      fixture.order.indexOf("thread.import-native"),
    );
    const imported = [...fixture.imports.values()][0]!;
    assert.deepEqual(imported, {
      commandId: imported.commandId,
      threadId: result.threadId,
      projectId: "project",
      title: codexImport.title,
      backendKind: "codex",
      sourceHome: codexImport.expectedHome,
      sourceNativeThreadId: codexImport.nativeSessionId,
      modelSelection: { instanceId: "codex", model: "model-b" },
      cwd: codexImport.cwd,
    });
    assert.equal(fixture.applied.length, 1);
    assert.deepEqual(fixture.applied[0]!.intent, {
      kind: "create_agent_runtime_session",
      session_id: result.sessionId,
      project_id: codexImport.projectId,
      title: codexImport.title,
      initial_page_ids: [],
      runtime_id: "engine",
      runtime_thread_id: result.threadId,
      launch_request_id: `native-import:${codexImport.requestId}`,
    });
    assert.deepEqual([...fixture.commands.values()], []);
    assert.isFalse(fixture.calls.some((call) => call.method === "thread.snapshot"));
  }),
);

it.effect.each(["native-session", " x ", "x", "n".repeat(1024)])(
  "connects an ACP native session after Core admission and returns the existing product Session on repeated import",
  (nativeSessionId) =>
    Effect.gen(function* () {
      const instanceId = agentRuntimeProviderId({
        kind: "acp",
        agentDefinitionId: "qoder",
        instanceConfigId: "personal",
      })!;
      const fixture = setup({}, [
        {
          instanceId,
          driver: "acpRegistry",
          enabled: true,
          models: [{ slug: "native-model", isDefault: true }],
        },
      ] as unknown as AgentRuntimeOperations["providers.read"]["output"]);
      const owner = yield* fixture.owner;
      const input = {
        instanceId,
        sessionId: nativeSessionId,
        requestId: "import-acp-session",
        acceptedAt: 10,
        projectId: "project",
        cwd: "/workspace",
      };
      const result = yield* owner.importAcp(input);
      for (const method of ["acp.sessions.prepareImport", "acp.sessions.import"]) {
        assert.deepInclude(fixture.calls.find((call) => call.method === method)?.input, {
          sessionId: nativeSessionId,
        });
      }
      assert.deepEqual(result, {
        sessionId: input.requestId,
        threadId: "nodex:thread:acp-source-one",
        projectId: "project",
      });
      assert.isBelow(
        fixture.order.indexOf("core.bind"),
        fixture.order.indexOf("acp.sessions.import"),
      );
      assert.equal(fixture.applied.length, 1);
      assert.deepEqual([...fixture.commands.values()], []);
      assert.deepEqual(
        yield* owner.importAcp({ ...input, requestId: "another-import-request" }),
        result,
      );
      assert.equal(fixture.applied.length, 1);
      assert.equal(
        fixture.calls.filter(({ method }) => method === "acp.sessions.import").length,
        1,
      );
    }),
);
it.effect.each(["", "n".repeat(1025)])(
  "refuses invalid native ACP identities before admission",
  (sessionId) =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const result = yield* owner
        .importAcp({
          instanceId: "agent",
          sessionId,
          requestId: "import-acp-session",
          acceptedAt: 10,
          projectId: "project",
          cwd: "/workspace",
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.deepEqual(fixture.calls, []);
      assert.equal(fixture.applied.length, 0);
    }),
);
it.effect("refuses an ACP import request reused after its native source identity changes", () =>
  Effect.gen(function* () {
    const instanceId = agentRuntimeProviderId({
      kind: "acp",
      agentDefinitionId: "qoder",
      instanceConfigId: "personal",
    })!;
    const fixture = setup({}, [
      {
        instanceId,
        driver: "acpRegistry",
        enabled: true,
        models: [{ slug: "native-model", isDefault: true }],
      },
    ] as unknown as AgentRuntimeOperations["providers.read"]["output"]);
    const owner = yield* fixture.owner;
    const input = {
      instanceId,
      sessionId: "native-session",
      requestId: "import-acp-session",
      acceptedAt: 10,
      projectId: "project",
      cwd: "/workspace",
    };
    yield* owner.importAcp(input);
    fixture.state.acpSourceFingerprint = "another-home";
    fixture.state.acpImported = false;
    assert.equal((yield* Effect.result(owner.importAcp(input)))._tag, "Failure");
    assert.equal(fixture.applied.length, 1);
    assert.equal(fixture.calls.filter(({ method }) => method === "acp.sessions.import").length, 1);
  }),
);

it.effect(
  "imports Claude with its own execution Agent and recovers a completed receipt after its source profile disappears",
  () =>
    Effect.gen(function* () {
      const instanceConfigId = "personal";
      const instanceId = agentRuntimeProviderId({ kind: "claude", instanceConfigId })!;
      const fixture = setup({}, [
        {
          instanceId,
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          status: "ready",
          models: [{ slug: "claude-sonnet", name: "Sonnet", isDefault: true }],
        },
      ] as unknown as AgentRuntimeOperations["providers.read"]["output"]);
      fixture.state.nativeImportSourceHome = "/native/claude";
      const input = {
        ...codexImport,
        backendKind: "claude" as const,
        instanceConfigId,
        expectedHome: "/native/claude",
        model: null,
      };
      const owner = yield* fixture.owner;
      const result = yield* importConversation(owner, input);
      const imported = [...fixture.imports.values()][0]!;
      assert.equal(imported.backendKind, "claude");
      assert.equal(imported.sourceHome, "/native/claude");
      assert.deepEqual(imported.modelSelection, { instanceId, model: "claude-sonnet" });
      assert.notEqual(result.threadId, input.nativeSessionId);
      const copies = yield* owner.findNativeImports({
        backendKind: "claude",
        sourceHome: input.expectedHome,
        nativeThreadIds: [input.nativeSessionId],
      });
      assert.deepEqual(copies, [
        {
          nativeSessionId: input.nativeSessionId,
          importedSessionId: result.sessionId,
          importedThreadId: result.threadId,
        },
      ]);
      assert.deepEqual(
        yield* owner.findNativeImports({
          backendKind: "codex",
          sourceHome: input.expectedHome,
          nativeThreadIds: [input.nativeSessionId],
        }),
        [],
      );
      const calls = fixture.calls.length;
      const homeReads = fixture.order.filter((item) => item === "codex.import-source-home").length;
      fixture.state.nativeImportSourceHome = "/removed-profile";
      fixture.state.codexModelsAvailable = false;
      assert.deepEqual(yield* recoverCompletedImport(owner, input), result);
      assert.equal(
        fixture.order.filter((item) => item === "codex.import-source-home").length,
        homeReads,
      );
      assert.isFalse(
        fixture.calls
          .slice(calls)
          .some(
            (call) => call.method === "providers.read" || call.method === "thread.import-native",
          ),
      );
      assert.equal(fixture.imports.size, 1);
    }),
);

it.effect("an empty Profile can browse native sources without starting an execution process", () =>
  Effect.gen(function* () {
    let connections = 0;
    const fixture = setup({
      runtimeExists: Effect.succeed(false),
      currentConnection: Effect.succeed(null),
      connect: Effect.sync(() => {
        connections++;
        throw new Error("Cold runtime must stay cold");
      }),
    });
    const owner = yield* fixture.owner;
    assert.deepEqual(
      yield* owner.findNativeImports({
        backendKind: "claude",
        sourceHome: "/native/claude",
        nativeThreadIds: [codexImport.nativeSessionId],
      }),
      [],
    );
    assert.equal(connections, 0);
  }),
);

it.effect(
  "imports projectless history into the selected directory and an available Codex model",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const result = yield* importConversation(owner, {
        ...codexImport,
        projectId: null,
        model: "retired-model",
      });
      const imported = [...fixture.imports.values()][0]!;
      assert.equal(result.projectId, null);
      assert.equal(fixture.bindings.get(result.sessionId)?.project_id, null);
      assert.equal(imported.projectId, "profile:projectless");
      assert.equal(imported.cwd, codexImport.cwd);
      assert.deepEqual(imported.modelSelection, { instanceId: "codex", model: "model-a" });
      assert.deepEqual([...fixture.commands.values()], []);
    }),
);

it.effect("Core refusal or missing Codex models admits no Runtime import", () =>
  Effect.gen(function* () {
    const refused = setup();
    refused.state.failCore = true;
    const refusedOwner = yield* refused.owner;
    yield* importConversation(refusedOwner, codexImport).pipe(Effect.flip);
    assert.equal(refused.bindings.size, 0);
    assert.equal(refused.imports.size, 0);
    assert.isFalse(refused.calls.some((call) => call.method === "thread.import-native"));
    assert.isFalse(refused.calls.some((call) => call.method === "project.upsert"));

    const unavailable = setup();
    unavailable.state.codexModelsAvailable = false;
    const unavailableOwner = yield* unavailable.owner;
    const failure = yield* importConversation(unavailableOwner, codexImport).pipe(Effect.flip);
    assert.equal(
      failure.message,
      "This Agent has no available model. Check Agent settings, then try again.",
    );
    assert.equal(unavailable.bindings.size, 0);
    assert.equal(unavailable.applied.length, 0);
    assert.equal(unavailable.imports.size, 0);
    assert.isFalse(unavailable.calls.some((call) => call.method === "thread.import-native"));
  }),
);

it.effect("imports and continues in an explicit directory when its Project has no workspace", () =>
  Effect.gen(function* () {
    const fixture = setup();
    fixture.state.projectWorkspaceRoot = null;
    const owner = yield* fixture.owner;
    const imported = yield* importConversation(owner, codexImport);
    yield* owner.message({
      sessionId: imported.sessionId,
      message: { messageId: "continue-import", text: "Continue from this history" },
    });
    assert.equal(
      fixture.snapshots.get(imported.threadId)!.projection.thread.worktreePath,
      codexImport.cwd,
    );
    assert.isTrue(
      [...fixture.commands.values()].some((command) => command.type === "message.dispatch"),
    );
    const fresh = setup();
    fresh.state.projectWorkspaceRoot = null;
    const freshOwner = yield* fresh.owner;
    const refused = yield* freshOwner.launch(launch).pipe(Effect.flip);
    assert.equal(refused.message, "This Project has no execution workspace");
    assert.equal(fresh.bindings.size, 0);
  }),
);

it.effect(
  "recovers an uncertain import binding only when its exact durable identity is proven",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      fixture.state.failCoreAcknowledgment = true;
      fixture.state.failBindingProof = true;
      const owner = yield* fixture.owner;
      yield* importConversation(owner, codexImport).pipe(Effect.flip);
      assert.equal(fixture.bindings.size, 1);
      assert.isFalse(fixture.calls.some((call) => call.method === "thread.import-native"));
      assert.isFalse(fixture.calls.some((call) => call.method === "project.upsert"));

      fixture.state.failBindingProof = false;
      fixture.state.failCoreAcknowledgment = false;
      const recovered = yield* importConversation(owner, codexImport);
      assert.equal(
        recovered.threadId,
        fixture.bindings.get(codexImport.requestId)?.runtime_thread_id,
      );
      assert.equal(fixture.applied.length, 1);
      assert.equal(fixture.imports.size, 1);
      assert.deepEqual([...fixture.commands.values()], []);
    }),
);

it.effect("rejects another Session's proof of an uncertain import binding", () =>
  Effect.gen(function* () {
    const fixture = setup();
    fixture.state.failCoreAcknowledgment = true;
    fixture.state.replaceBindingProof = true;
    const owner = yield* fixture.owner;
    yield* importConversation(owner, codexImport).pipe(Effect.flip);
    assert.isFalse(fixture.calls.some((call) => call.method === "thread.import-native"));
    assert.deepEqual([...fixture.commands.values()], []);
  }),
);

it.effect("retries an uncertain Runtime import with the same command and one destination", () =>
  Effect.gen(function* () {
    const fixture = setup();
    fixture.state.failCodexImportAcknowledgment = true;
    const owner = yield* fixture.owner;
    yield* importConversation(owner, codexImport).pipe(Effect.flip);
    const first = [...fixture.imports.values()][0]!;
    const result = yield* importConversation(owner, codexImport);
    assert.equal(result.threadId, first.threadId);
    assert.equal(fixture.imports.size, 1);
    assert.equal(fixture.bindings.size, 1);
    assert.equal(fixture.applied.length, 1);
    assert.deepEqual(
      fixture.calls
        .filter((call) => call.method === "thread.import-native")
        .map((call) => call.input),
      [first],
    );
    assert.deepEqual([...fixture.commands.values()], []);
  }),
);

it.effect.each([
  { nativeSessionId: "01a0ae8c-a700-7571-a2bd-e305e9c63892" },
  { expectedHome: "/native/another-codex" },
  { projectId: "another-project" },
  { cwd: "/another/imported-directory" },
  { backendKind: "claude" as const, instanceConfigId: "personal" },
  { instanceConfigId: "different-profile" },
])(
  "refuses to reuse an import request with different source or destination parameters %#",
  (patch) =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      yield* importConversation(owner, codexImport);
      const failure = yield* importConversation(owner, { ...codexImport, ...patch }).pipe(
        Effect.flip,
      );
      assert.equal(failure.message, "This import request already belongs to another conversation");
      assert.equal(fixture.bindings.size, 1);
      assert.equal(fixture.applied.length, 1);
      assert.equal(fixture.imports.size, 1);
      assert.equal(
        fixture.calls.filter((call) => call.method === "thread.import-native").length,
        1,
      );
    }),
);

it.effect("an interrupted import cannot be opened as an empty chat and remains retryable", () =>
  Effect.gen(function* () {
    const fixture = setup();
    fixture.state.failCodexImportBeforeCommit = true;
    const owner = yield* fixture.owner;
    yield* importConversation(owner, codexImport).pipe(Effect.flip);
    const failure = yield* owner.inspect({ sessionId: codexImport.requestId }).pipe(Effect.flip);
    assert.equal(failure.message, "This import was interrupted. Retry it from Conversations.");
    assert.equal(fixture.imports.size, 0);
    assert.deepEqual([...fixture.commands.values()], []);
    const result = yield* importConversation(owner, codexImport);
    assert.equal(result.threadId, fixture.bindings.get(codexImport.requestId)?.runtime_thread_id);
    assert.equal(fixture.imports.size, 1);
    assert.equal(fixture.applied.length, 1);
    assert.deepEqual([...fixture.commands.values()], []);
  }),
);

it.effect(
  "refuses a restored reader from another history home before admitting any import side effects",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      fixture.state.nativeImportSourceHome = "/profile/agent-runtime/native-history/captured-codex";
      const owner = yield* fixture.owner;
      const failure = yield* importConversation(owner, codexImport).pipe(Effect.flip);
      assert.match(failure.message, /history|home|restored/iu);
      assert.deepEqual(fixture.order, ["codex.import-source-home"]);
      assert.equal(fixture.applied.length, 0);
      assert.equal(fixture.bindings.size, 0);
      assert.equal(fixture.imports.size, 0);
      assert.equal(fixture.commands.size, 0);
      assert.deepEqual(fixture.calls, []);
    }),
);

it.effect("recovers a completed import without its source account or a current model catalog", () =>
  Effect.gen(function* () {
    const fixture = setup();
    fixture.state.failCodexImportAcknowledgment = true;
    const owner = yield* fixture.owner;
    yield* importConversation(owner, codexImport).pipe(Effect.flip);
    fixture.state.codexModelsAvailable = false;
    fixture.state.nativeImportSourceHome = "/different-or-removed-source";
    const sourceChecks = fixture.order.filter((step) => step === "codex.import-source-home").length;
    const callCount = fixture.calls.length;
    const result = yield* recoverCompletedImport(owner, codexImport);
    assert.deepEqual(result, {
      sessionId: codexImport.requestId,
      threadId: fixture.bindings.get(codexImport.requestId)!.runtime_thread_id,
      projectId: codexImport.projectId,
    });
    assert.equal(
      fixture.order.filter((step) => step === "codex.import-source-home").length,
      sourceChecks,
    );
    assert.isFalse(
      fixture.calls
        .slice(callCount)
        .some((call) => call.method === "providers.read" || call.method === "thread.import-native"),
    );
    assert.equal(fixture.applied.length, 1);
    setExecutionHold(fixture, result!.threadId, true);
    assert.equal(
      (yield* recoverCompletedImport(owner, codexImport).pipe(Effect.result))._tag,
      "Failure",
    );
    const refused = yield* recoverCompletedImport(owner, { ...codexImport, cwd: "/changed" }).pipe(
      Effect.flip,
    );
    assert.equal(refused.message, "This import request already belongs to another conversation");
  }),
);

it.effect(
  "allows deleting a failed history import while retaining other handoff lifecycle guards",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const opened = yield* importConversation(owner, codexImport);
      const current = fixture.snapshots.get(opened.threadId)!;
      fixture.snapshots.set(opened.threadId, {
        ...current,
        projection: {
          ...current.projection,
          thread: {
            ...current.projection.thread,
            activeProviderThreadId: null,
            executionHandoff: { operationId: "native-import:pending", recoveryRequired: true },
          },
        },
      });
      const command = { operationId: "delete-import", payload: { sessionId: opened.sessionId } };
      assert.equal((yield* owner.archiveSession(command).pipe(Effect.result))._tag, "Failure");
      yield* owner.deleteSession(command);
      assert.equal(fixture.bindings.size, 0);
      assert.isNotNull(fixture.snapshots.get(opened.threadId)!.projection.thread.deletedAt);
      assert.equal(fixture.cleanups.size, 0);
    }),
);

/** Background preparation dispatches on its own fiber; yield until the command lands. */
const awaitCommand = (fixture: ReturnType<typeof setup>, type: AgentCommand["type"]) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const found = [...fixture.commands.values()].find((command) => command.type === type);
      if (found) return found;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`${type} was never dispatched`));
  });

it.effect("clears transient predictions only on an already-running connection", () =>
  Effect.gen(function* () {
    const connect = Effect.die(new Error("Prediction cleanup must not start execution"));
    const cold = setup({
      runtimeExists: Effect.succeed(true),
      currentConnection: Effect.succeed(null),
      connect,
    });
    const coldOwner = yield* cold.owner;
    yield* coldOwner.clearPredictions();
    yield* coldOwner.clearPredictions("thread:root");
    assert.deepEqual(cold.calls, []);
    const running = setup({ connect });
    const runningOwner = yield* running.owner;
    yield* runningOwner.clearPredictions("thread:root");
    yield* runningOwner.clearPredictions();
    assert.deepEqual(running.calls, [
      { method: "native.prediction.clear", input: { threadId: "thread:root" } },
      { method: "native.prediction.clear", input: {} },
    ]);
  }),
);

it.effect("creates and binds an absent product Session before dispatch and reuses its launch", () =>
  Effect.gen(function* () {
    const fixture = setup();
    fixture.state.missingSessionLookupError = coreRuntimeError({
      operation: "workspace.read",
      reason: "operation",
      retryable: false,
      cause: new CoreModuleResponseError({
        code: "not_found",
        message: "Session is unavailable in this Library",
        retryable: false,
        recovery: { kind: "none" },
      }),
    });
    const owner = yield* fixture.owner;
    const opened = yield* owner.launch(launch);
    assert.deepEqual(yield* owner.launch(launch), opened);
    assert.equal(fixture.bindings.get(launch.sessionId)?.runtime_thread_id, opened.threadId);
    assert.equal(fixture.applied.length, 1);
    assert.isBelow(
      fixture.order.indexOf("core.bind"),
      fixture.order.indexOf("engine.message.dispatch"),
    );
    assert.equal(
      [...fixture.commands.values()].filter((command) => command.type === "message.dispatch")
        .length,
      1,
    );
  }),
);

it.effect("a bound Session whose launch stopped before its Thread existed opens normally", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    fixture.state.failThreadCreate = true;
    assert.equal((yield* owner.launch(launch).pipe(Effect.result))._tag, "Failure");
    const bound = fixture.bindings.get(launch.sessionId)!;
    assert.isFalse(fixture.snapshots.has(bound.runtime_thread_id));
    const opened = yield* owner.read({ sessionId: launch.sessionId });
    assert.equal(opened.threadId, bound.runtime_thread_id);
    const created = [...fixture.commands.values()].find(
      (command) => command.type === "thread.create",
    );
    assert.deepEqual(created?.type === "thread.create" ? created.modelSelection : null, {
      instanceId: "codex",
      model: "model-a",
    });
    // A later send uses the same Thread; no second Session or Thread appears.
    yield* owner.message({
      sessionId: launch.sessionId,
      message: { messageId: "message:resend", text: "Build it" },
    });
    assert.equal(fixture.bindings.size, 1);
    assert.equal(
      [...fixture.commands.values()].filter((command) => command.type === "thread.create").length,
      1,
    );
  }),
);

it.effect("other binding lookup failures prevent new Session metadata and dispatch", () =>
  Effect.gen(function* () {
    const fixture = setup();
    fixture.state.missingSessionLookupError = coreRuntimeError({
      operation: "workspace.read",
      reason: "operation",
      retryable: false,
      cause: new CoreModuleResponseError({
        code: "conflict",
        message: "Execution identity changed",
        retryable: false,
        recovery: { kind: "none" },
      }),
    });
    const owner = yield* fixture.owner;
    const result = yield* owner.launch(launch).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure")
      assert.equal(result.failure.cause, fixture.state.missingSessionLookupError);
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.bindings.size, 0);
    assert.equal(fixture.applied.length, 0);
  }),
);

it.effect(
  "replaces queued presentation only after its edit receipt and exact unstarted Run proof",
  () =>
    Effect.gen(function* () {
      const replacements: unknown[] = [];
      const replaceQueuedRuntimeMessage: import("../codex-application/CodexTurnPresentation").CodexTurnPresentation["Service"]["replaceQueuedRuntimeMessage"] =
        (...input) =>
          Effect.sync(() => {
            replacements.push(input);
            fixture.order.push("presentation.replace");
            return null;
          });
      const fixture = setup({
        presentation: {
          admitRuntimeMessage: () => Effect.succeed(null),
          replaceQueuedRuntimeMessage,
        } as never,
      });
      const owner = yield* fixture.owner;
      const result = yield* owner.launch(launch);
      const original = fixture.snapshots.get(result.threadId)!;
      fixture.snapshots.set(result.threadId, {
        ...original,
        projection: {
          ...original.projection,
          runs: [
            {
              id: "queued",
              userMessageId: "queued-message",
              status: "queued",
              ordinal: 2,
            } as never,
          ],
        },
      });
      const ticket = { ticketId: "018f0097-a39b-7000-8000-000000000000" };
      const edit = {
        sessionId: result.sessionId,
        threadId: result.threadId,
        action: "edit" as const,
        requestId: "edit-one",
        runId: "queued",
        presentationTicket: ticket,
        message: { messageId: "queued-message", text: "Changed" },
      };
      fixture.order.length = 0;
      yield* owner.queue(edit);
      assert.deepEqual(replacements, [[ticket, result.threadId, "queued-message", "edit-one"]]);
      assert.isBelow(
        fixture.order.indexOf("command.dispatch"),
        fixture.order.indexOf("run.outcome"),
      );
      assert.isBelow(
        fixture.order.indexOf("run.outcome"),
        fixture.order.indexOf("presentation.replace"),
      );
      fixture.snapshots.set(result.threadId, {
        ...original,
        projection: {
          ...original.projection,
          runs: [
            {
              id: "queued",
              userMessageId: "queued-message",
              status: "starting",
              ordinal: 2,
            } as never,
          ],
        },
      });
      yield* owner.queue({ ...edit, requestId: "edit-late" });
      assert.lengthOf(replacements, 1);
    }),
);

it.effect(
  "admits captured presentation on the bound engine Thread before dispatching a Session message",
  () =>
    Effect.gen(function* () {
      const admitted: Array<unknown> = [];
      const admitRuntimeMessage: import("../codex-application/CodexTurnPresentation").CodexTurnPresentation["Service"]["admitRuntimeMessage"] =
        (ticket, target, threadId, messageId) =>
          Effect.sync(() => {
            fixture.order.push("presentation.admit");
            admitted.push({ ticket, target, threadId, messageId });
            return null;
          });
      const fixture = setup({
        presentation: {
          admitRuntimeMessage,
        } as never,
      });
      const owner = yield* fixture.owner;
      const ticket = { ticketId: "018f0097-a39b-7000-8000-000000000000" };
      const result = yield* owner.launch({ ...launch, presentationTicket: ticket });
      assert.deepEqual(admitted[0], {
        ticket,
        target: { kind: "session", sessionId: launch.sessionId, launchId: launch.launchId },
        threadId: result.threadId,
        messageId: launch.message.messageId,
      });
      assert.isBelow(
        fixture.order.indexOf("presentation.admit"),
        fixture.order.lastIndexOf("engine.message.dispatch"),
      );
      fixture.order.length = 0;
      yield* owner.message({
        sessionId: result.sessionId,
        threadId: result.threadId,
        presentationTicket: ticket,
        message: { messageId: "message:next", text: "Next" },
      });
      assert.deepEqual(admitted[1], {
        ticket,
        target: { kind: "thread", threadId: result.threadId },
        threadId: result.threadId,
        messageId: "message:next",
      });
      assert.isBelow(
        fixture.order.indexOf("presentation.admit"),
        fixture.order.indexOf("engine.message.dispatch"),
      );
    }),
);

it.effect(
  "binds the product Session before execution metadata and starts one execution on retry",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      fixture.state.failMessage = true;
      assert.isTrue((yield* owner.launch(launch).pipe(Effect.result))._tag === "Failure");
      const bound = fixture.bindings.get(launch.sessionId)!;
      assert.isBelow(
        fixture.order.indexOf("core.bind"),
        fixture.order.indexOf("engine.thread.create"),
      );
      assert.equal(fixture.commands.size, 1);
      const result = yield* owner.launch(launch);
      assert.equal(result.sessionId, launch.sessionId);
      assert.equal(result.threadId, bound.runtime_thread_id);
      assert.equal(fixture.applied.length, 1);
      assert.equal(fixture.commands.size, 2);
      assert.isBelow(
        fixture.order.indexOf("core.bind"),
        fixture.order.indexOf("engine.message.dispatch"),
      );
      assert.deepEqual(fixture.applied[0]!.intent, {
        kind: "create_agent_runtime_session",
        session_id: launch.sessionId,
        project_id: launch.projectId,
        title: launch.title,
        initial_page_ids: launch.initialPageIds ?? [],
        runtime_id: "engine",
        runtime_thread_id: result.threadId,
        launch_request_id: launch.launchId,
      });
      const changed = yield* owner
        .launch({ ...launch, message: { ...launch.message, text: "Different launch" } })
        .pipe(Effect.result);
      assert.equal(changed._tag, "Success");
      assert.equal(fixture.commands.size, 2);
    }),
);

it.effect("message admission survives archive and never materializes an unbound Session", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    assert.equal(
      yield* owner.messageAdmission({
        sessionId: launch.sessionId,
        messageId: launch.message.messageId,
      }),
      null,
    );
    assert.equal(fixture.commands.size, 0);
    const opened = yield* owner.launch(launch);
    fixture.state.archived = true;
    const receipt = yield* owner.messageAdmission({
      sessionId: launch.sessionId,
      messageId: launch.message.messageId,
    });
    assert.equal(receipt?.status, "accepted");
    assert.equal(receipt?.threadId, opened.threadId);
    assert.equal(
      yield* owner.messageAdmission({ sessionId: launch.sessionId, messageId: "not-sent" }),
      null,
    );
    const wrongOwner = yield* owner
      .messageAdmission({
        sessionId: launch.sessionId,
        messageId: launch.message.messageId,
        expectedExecutionRef: { runtimeId: "other", threadId: opened.threadId },
      })
      .pipe(Effect.result);
    assert.equal(wrongOwner._tag, "Failure");
    fixture.bindings.set(launch.sessionId, {
      ...fixture.bindings.get(launch.sessionId)!,
      runtime_thread_id: "thread:replacement",
    });
    const frozen = yield* owner.messageAdmission({
      sessionId: launch.sessionId,
      messageId: launch.message.messageId,
      expectedExecutionRef: { runtimeId: "engine", threadId: opened.threadId },
    });
    assert.equal(frozen?.status, "accepted");
    assert.equal(frozen?.threadId, opened.threadId);
  }),
);

it.effect("a competing launch refuses admission while the original receipt stays readable", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    const opened = yield* owner.launch(launch);
    const before = fixture.commands.size;
    const error = yield* owner
      .launch({ ...launch, launchId: "competing-launch" })
      .pipe(Effect.flip);
    assert.isTrue(error.admissionRejected);
    assert.equal(fixture.commands.size, before);

    fixture.bindings.set(launch.sessionId, {
      ...fixture.bindings.get(launch.sessionId)!,
      launch_request_id: "replacement-launch",
      runtime_thread_id: "replacement-root",
    });
    const receipt = yield* owner.messageAdmission({
      sessionId: launch.sessionId,
      launchId: launch.launchId,
      messageId: launch.message.messageId,
    });
    assert.equal(receipt?.status, "accepted");
    assert.equal(receipt?.threadId, opened.threadId);
  }),
);

it.effect("Thread acceptance is not message acceptance, but a refused launch is final", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    fixture.state.failMessage = true;
    const result = yield* owner.launch(launch).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    const input = {
      sessionId: launch.sessionId,
      messageId: launch.message.messageId,
      launchId: launch.launchId,
    };
    assert.equal(yield* owner.messageAdmission(input), null);
    fixture.state.refusedThreadReceipt = true;
    const refused = yield* owner.messageAdmission(input);
    assert.equal(refused?.status, "rejected");
    assert.equal(refused?.error, "Model unavailable");
  }),
);

it.effect("control reads retain Session ownership without hydrating transcript history", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    const opened = yield* owner.launch(launch);
    const target = { sessionId: opened.sessionId, threadId: opened.threadId };
    const value = yield* owner.control(target);
    assert.equal(value.sessionId, opened.sessionId);
    assert.equal(value.threadId, opened.threadId);
    assert.isTrue(fixture.calls.some((call) => call.method === "thread.control"));
    assert.isFalse(fixture.calls.some((call) => call.method === "thread.snapshot"));
    assert.isFalse(fixture.calls.some((call) => call.method === "thread.history"));
    yield* owner.control({ ...target, runId: "queued:exact" });
    assert.deepEqual(fixture.calls.at(-1)!.input, {
      threadId: opened.threadId,
      runId: "queued:exact",
    });
    fixture.snapshots.set("foreign", snapshot("foreign"));
    const before = fixture.calls.filter((call) => call.method === "thread.control").length;
    assert.equal(
      (yield* owner.control({ ...target, threadId: "foreign" }).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.equal(fixture.calls.filter((call) => call.method === "thread.control").length, before);
  }),
);

it.effect(
  "compaction resolves the exact Session descendant and revalidates current write authority",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const opened = yield* owner.launch(launch);
      fixture.snapshots.set("child", snapshot("child", opened.threadId));
      const compact = { sessionId: opened.sessionId, threadId: "child", requestId: "compact:one" };
      assert.equal((yield* owner.compact(compact)).runId, "run:compact:one");
      assert.deepEqual(fixture.calls.find((call) => call.method === "thread.compact")?.input, {
        threadId: "child",
        requestId: "compact:one",
      });
      fixture.snapshots.set("foreign", snapshot("foreign"));
      assert.equal(
        (yield* owner.compact({ ...compact, threadId: "foreign" }).pipe(Effect.result))._tag,
        "Failure",
      );
      fixture.state.denyAgent = true;
      assert.equal(
        (yield* owner
          .compact(compact)
          .pipe(Effect.provideService(CoreApplicationAgent, agent), Effect.result))._tag,
        "Failure",
      );
      assert.equal(fixture.calls.filter((call) => call.method === "thread.compact").length, 1);
      assert.isFalse(fixture.calls.some((call) => call.method === "thread.snapshot"));
    }),
);

it.effect(
  "queue mutations stay within an authorized Session descendant and never hydrate history",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const opened = yield* owner.launch(launch);
      fixture.snapshots.set("child", snapshot("child", opened.threadId));
      const target = { sessionId: opened.sessionId, threadId: "child" };
      yield* owner.queue({
        ...target,
        requestId: "reorder",
        action: "reorder",
        orderedRunIds: ["queued:a", "queued:b"],
      });
      const commands = [...fixture.commands.values()].filter(
        (command) => command.type === "queued-run.reorder",
      );
      assert.deepEqual(
        commands.map((command) =>
          command.type === "queued-run.reorder"
            ? [command.threadId, command.runId, command.beforeRunId]
            : [],
        ),
        [
          ["child", "queued:b", null],
          ["child", "queued:a", "queued:b"],
        ],
      );
      yield* owner.queueMessage({
        ...target,
        message: { messageId: "queued:message", text: "Queued" },
      });
      const queued = [...fixture.commands.values()].find(
        (command) => command.type === "message.dispatch" && command.messageId === "queued:message",
      );
      assert.equal(queued?.type, "message.dispatch");
      if (queued?.type === "message.dispatch") {
        assert.deepEqual(queued.dispatchMode, { type: "queue_after_active" });
        assert.isUndefined(queued.deliveryIntent);
      }
      fixture.state.denyAgent = true;
      const before = fixture.commands.size;
      assert.equal(
        (yield* owner
          .queue({ ...target, requestId: "cancel", action: "cancel", runId: "queued:a" })
          .pipe(Effect.provideService(CoreApplicationAgent, agent), Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* owner
          .queue({
            ...target,
            requestId: "invalid-order",
            action: "reorder",
            orderedRunIds: ["queued:a", "queued:a"],
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(fixture.commands.size, before);
      assert.isFalse(
        fixture.calls.some(
          (call) => call.method === "thread.snapshot" || call.method === "thread.history",
        ),
      );
      assert.isFalse(
        fixture.calls.some(
          (call) => call.method === "thread.control" || call.method === "providers.read",
        ),
      );
    }),
);

it.effect(
  "rollback observes the exact admitted message before it permits an edited submission",
  () =>
    Effect.gen(function* () {
      const fixture = setup({
        subscribeExecutionChanges: Effect.succeed(Stream.succeed(undefined)),
      });
      const owner = yield* fixture.owner;
      const opened = yield* owner.launch(launch);
      const current = fixture.snapshots.get(opened.threadId)!;
      fixture.snapshots.set(opened.threadId, {
        ...current,
        projection: {
          ...current.projection,
          runs: [
            {
              id: "run:edit",
              threadId: opened.threadId,
              userMessageId: "original-message",
              ordinal: 1,
              status: "completed",
            } as never,
          ],
        },
      });
      const target = { sessionId: opened.sessionId, requestId: "edit", runId: "run:edit" };
      assert.deepEqual(yield* owner.rollback(target), { rolledBack: true });
      assert.deepEqual(fixture.calls.find((call) => call.method === "run.outcome")?.input, {
        threadId: opened.threadId,
        messageId: "original-message",
      });
      assert.isFalse(fixture.calls.some((call) => call.method === "thread.snapshot"));
      fixture.state.rollbackFails = true;
      assert.equal(
        (yield* owner.rollback({ ...target, requestId: "failed" }).pipe(Effect.result))._tag,
        "Failure",
      );
      fixture.state.denyAgent = true;
      const before = fixture.calls.filter((call) => call.method === "thread.rollback").length;
      assert.equal(
        (yield* owner
          .rollback(target)
          .pipe(Effect.provideService(CoreApplicationAgent, agent), Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        fixture.calls.filter((call) => call.method === "thread.rollback").length,
        before,
      );
    }),
);

it.effect("a person's first prompt is titled once, replacing only the provisional title", () =>
  Effect.gen(function* () {
    const fixture = setup();
    fixture.state.generatedTitle = "Fix login failure";
    const owner = yield* fixture.owner;
    yield* owner.launch({ ...launch, modelSelection: { instanceId: "codex", model: "model-b" } });
    const titled = yield* Effect.gen(function* () {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const write = fixture.applied.find(
          (value) =>
            value.intent.kind === "mutate_session" &&
            value.intent.intent.kind === "set_fallback_title",
        );
        if (write) return write;
        yield* Effect.yieldNow;
      }
      return null;
    });
    assert.deepEqual(titled?.intent, {
      kind: "mutate_session",
      session_id: "session:one",
      intent: { kind: "set_fallback_title", title: "Fix login failure", replaces: "Task" },
    });
    const generation = fixture.calls.find((call) => call.method === "text.generate-structured");
    assert.deepEqual((generation?.input as { modelSelection: unknown }).modelSelection, {
      instanceId: "codex",
      model: "model-b",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  }),
);

it.effect(
  "Core alone owns titles while archive reaches the engine gate and is repaired after a failure",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const opened = yield* owner.launch(launch);
      const titleBefore = fixture.snapshots.get(opened.threadId)!.projection.thread.title;
      const dispatched = fixture.commands.size;
      yield* owner.renameSession({
        operationId: "rename",
        payload: { sessionId: opened.sessionId, input: { title: "Renamed" } },
      });
      assert.include(fixture.order, "core.rename");
      assert.equal(fixture.commands.size, dispatched);
      assert.equal(fixture.snapshots.get(opened.threadId)!.projection.thread.title, titleBefore);
      const archive = { operationId: "archive", payload: { sessionId: opened.sessionId } };
      yield* owner.archiveSession(archive);
      assert.isNotNull(fixture.snapshots.get(opened.threadId)!.projection.thread.archivedAt);
      yield* owner.unarchiveSession({ ...archive, operationId: "unarchive" });
      assert.isNull(fixture.snapshots.get(opened.threadId)!.projection.thread.archivedAt);
      fixture.state.supersededArchive = true;
      const settled = fixture.commands.size;
      yield* owner.archiveSession({ ...archive, operationId: "old-archive" });
      assert.equal(fixture.commands.size, settled);
      fixture.state.supersededArchive = false;
      fixture.state.failEngineArchive = true;
      const failed = yield* owner
        .archiveSession({ ...archive, operationId: "archive-again" })
        .pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      if (failed._tag === "Failure")
        assert.equal(failed.failure.committedOperationId, "archive-again");
      assert.isTrue(fixture.state.archived);
      assert.isNull(fixture.snapshots.get(opened.threadId)!.projection.thread.archivedAt);
      fixture.state.failEngineArchive = false;
      // A background continuation keeps the root live; the next engine start closes the gap.
      const live = fixture.snapshots.get(opened.threadId)!;
      fixture.snapshots.set(opened.threadId, {
        ...live,
        projection: {
          ...live.projection,
          runs: [{ id: "background", threadId: opened.threadId, status: "waiting" }] as never,
        },
      });
      yield* owner.reconcileLiveExecutions();
      assert.isNotNull(fixture.snapshots.get(opened.threadId)!.projection.thread.archivedAt);
      assert.isFalse(
        fixture.calls.some(
          ({ method }) => method === "thread.snapshot" || method === "thread.history",
        ),
      );
    }),
);

it.effect(
  "Core refusal prevents execution changes and draft deletion keeps an unused runtime cold",
  () =>
    Effect.gen(function* () {
      const fixture = setup({ runtimeExists: Effect.succeed(false) });
      const owner = yield* fixture.owner;
      const target = { operationId: "delete", payload: { sessionId: "draft" } };
      fixture.state.failCore = true;
      assert.equal((yield* owner.deleteSession(target).pipe(Effect.result))._tag, "Failure");
      fixture.state.failCore = false;
      yield* owner.deleteSession(target);
      assert.deepEqual(fixture.calls, []);
      assert.equal(fixture.cleanups.size, 0);
    }),
);

it.effect("listing models while execution is stopped never starts it; refresh always does", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const declared = { identity: "declared", running: false };
    const providerCatalog = yield* makeProviderCatalog({
      home: yield* fs.makeTempDirectoryScoped({ prefix: "nodex-catalog-" }),
      identity: Effect.sync(() => declared.identity),
      running: Effect.sync(() => declared.running),
    });
    const fixture = setup({ providerCatalog });
    const owner = yield* fixture.owner;
    const reads = () => fixture.calls.filter((call) => call.method === "providers.read").length;
    // Nothing was kept yet, so the first listing reads live and keeps the result.
    const live = yield* owner.catalog();
    assert.equal(reads(), 1);
    assert.deepEqual(yield* owner.catalog(), live);
    assert.equal(reads(), 1);
    yield* owner.catalog({ refresh: true });
    assert.equal(reads(), 2);
    declared.running = true;
    yield* owner.catalog();
    assert.equal(reads(), 3);
    declared.running = false;
    // Changed provider settings are listed live once, then kept again.
    declared.identity = "changed";
    yield* owner.catalog();
    yield* owner.catalog();
    assert.equal(reads(), 4);
    // A read of named Agents answers from what was kept, narrowed to them.
    const kept = live[0]!.instanceId;
    assert.deepEqual(
      (yield* owner.catalog({ instanceIds: [kept] })).map((provider) => provider.instanceId),
      [kept],
    );
    assert.equal(reads(), 4);
    // Live, it reaches the process and never stands in for the whole catalog.
    declared.running = true;
    yield* owner.catalog({ instanceIds: [kept] });
    assert.equal(reads(), 5);
    declared.running = false;
    assert.deepEqual(yield* owner.catalog(), live);
    assert.equal(reads(), 5);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("usage observers read the known catalog without ever starting execution", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const declared = { identity: "declared", running: false };
    const providerCatalog = yield* makeProviderCatalog({
      home: yield* fs.makeTempDirectoryScoped({ prefix: "nodex-catalog-" }),
      identity: Effect.sync(() => declared.identity),
      running: Effect.sync(() => declared.running),
    });
    const fixture = setup({
      providerCatalog,
      whileRunning: (effect) => (declared.running ? effect : Effect.succeed(null)),
    });
    const owner = yield* fixture.owner;
    const reads = () => fixture.calls.filter((call) => call.method === "providers.read").length;
    // Stopped with nothing kept: nothing is known, and nothing is started to find out.
    assert.isNull(yield* owner.knownCatalog());
    assert.equal(reads(), 0);
    // Running: the live answer is served and kept for later stopped reads.
    declared.running = true;
    const live = yield* owner.knownCatalog();
    assert.equal(reads(), 1);
    declared.running = false;
    assert.deepEqual(yield* owner.knownCatalog(), live);
    assert.equal(reads(), 1);
    // A changed provider declaration makes the kept copy unknown again.
    declared.identity = "changed";
    assert.isNull(yield* owner.knownCatalog());
    assert.equal(reads(), 1);
    // A check of named Agents reaches only a running process and never replaces the kept copy.
    const first = live?.[0];
    if (!first) throw new Error("Expected a live catalog");
    const named = { instanceIds: [first.instanceId], refresh: true };
    assert.isNull(yield* owner.catalogWhileRunning(named));
    assert.equal(reads(), 1);
    declared.running = true;
    yield* owner.catalogWhileRunning(named);
    assert.deepEqual(fixture.calls.at(-1), { method: "providers.read", input: named });
    declared.identity = "declared";
    declared.running = false;
    assert.deepEqual(yield* owner.knownCatalog(), live);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "accepted Session deletion retains durable cleanup on disconnect and restart settles it once",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const opened = yield* owner.launch(launch);
      fixture.state.failEngineDelete = true;
      const failed = yield* owner
        .deleteSession({ operationId: "delete", payload: { sessionId: opened.sessionId } })
        .pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      if (failed._tag === "Failure") assert.equal(failed.failure.committedOperationId, "delete");
      assert.equal(fixture.bindings.size, 0);
      assert.equal(fixture.cleanups.size, 1);
      fixture.state.failEngineDelete = false;
      fixture.state.failCleanupAcknowledgment = true;
      assert.equal((yield* owner.cleanupDeletedSessions.pipe(Effect.result))._tag, "Failure");
      assert.isNotNull(fixture.snapshots.get(opened.threadId)!.projection.thread.deletedAt);
      assert.equal(fixture.cleanups.size, 1);
      const deleted = [...fixture.commands.values()].filter(
        (command) => command.type === "thread.delete",
      );
      fixture.state.failCleanupAcknowledgment = false;
      assert.deepEqual(yield* owner.cleanupDeletedSessions, { completed: 1 });
      assert.deepEqual(yield* owner.cleanupDeletedSessions, { completed: 0 });
      assert.equal(fixture.cleanups.size, 0);
      assert.equal(
        [...fixture.commands.values()].filter((command) => command.type === "thread.delete").length,
        deleted.length,
      );
    }),
);

it.effect(
  "an unknown Core deletion reply never dispatches before durable cleanup is recovered",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const opened = yield* owner.launch(launch);
      fixture.state.failDeleteAcknowledgment = true;
      const before = fixture.commands.size;
      const failed = yield* owner
        .deleteSession({ operationId: "delete", payload: { sessionId: opened.sessionId } })
        .pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      if (failed._tag === "Failure") assert.isUndefined(failed.failure.committedOperationId);
      assert.equal(fixture.commands.size, before);
      assert.equal(fixture.cleanups.size, 1);
      fixture.state.failDeleteAcknowledgment = false;
      assert.deepEqual(yield* owner.cleanupDeletedSessions, { completed: 1 });
    }),
);

it.effect("Core Page refusal and Project lifecycle changes prevent execution admission", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    fixture.state.failCore = true;
    assert.equal((yield* owner.launch(launch).pipe(Effect.result))._tag, "Failure");
    assert.equal(fixture.bindings.size, 0);
    // A Session Core refuses never gains execution metadata or a workspace.
    assert.deepEqual([...fixture.commands.values()], []);
    fixture.state.failCore = false;
    yield* owner.launch(launch);
    const before = fixture.commands.size;
    fixture.state.lifecycle = "archived";
    assert.equal(
      (yield* owner
        .message({ sessionId: launch.sessionId, message: { messageId: "next", text: "Continue" } })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    assert.equal(fixture.commands.size, before);
    // Read-only history and Stop remain available when the Project stops admitting work.
    yield* owner.history({ sessionId: launch.sessionId, cursor: "opaque" });
  }),
);

it.effect(
  "an uncertain Core commit is reconciled only from the exact immutable execution binding",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      fixture.state.failCoreAcknowledgment = true;
      const result = yield* owner.launch(launch);
      assert.equal(result.threadId, fixture.bindings.get(launch.sessionId)!.runtime_thread_id);
      assert.equal(fixture.commands.size, 2);
      assert.equal(fixture.applied.length, 1);
      assert.isBelow(
        fixture.order.indexOf("core.bind"),
        fixture.order.indexOf("engine.message.dispatch"),
      );
    }),
);

it.effect("another Session's execution binding cannot acknowledge a failed launch", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    fixture.state.failCoreAcknowledgment = true;
    fixture.state.replaceBindingProof = true;
    assert.equal((yield* owner.launch(launch).pipe(Effect.result))._tag, "Failure");
    assert.deepEqual([...fixture.commands.values()], []);
  }),
);

it.effect(
  "an unproven Core binding admits no workspace or execution until the same request succeeds",
  () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const fixture = setup({
        prepareWorkspace: () =>
          Effect.succeed({
            location: {
              cwd: "/worktrees/uncertain",
              workspaceRoots: ["/worktrees/uncertain"],
              managedWorktreePath: "/worktrees/uncertain",
              projectlessOutputDirectory: null,
              projectlessWorkspaceBrowserRoot: null,
            },
            retain: Effect.sync(() => {
              events.push("retain");
            }),
            attach: (threadId) =>
              Effect.sync(() => {
                events.push(`attach:${threadId}`);
              }),
          }),
      });
      const owner = yield* fixture.owner;
      fixture.state.failCoreAcknowledgment = true;
      fixture.state.failBindingProof = true;
      const input = { ...launch, runInTarget: "newWorktree" as const };
      assert.equal((yield* owner.launch(input).pipe(Effect.result))._tag, "Failure");
      assert.deepEqual(events, []);
      assert.deepEqual([...fixture.commands.values()], []);
      fixture.state.failBindingProof = false;
      fixture.state.failCoreAcknowledgment = false;
      const result = yield* owner.launch(input);
      assert.equal(result.threadId, fixture.bindings.get(launch.sessionId)!.runtime_thread_id);
      assert.equal(fixture.applied.length, 1);
      yield* awaitCommand(fixture, "prepared-run.release");
      assert.deepEqual(events, [`attach:${result.threadId}`]);
      assert.isFalse(fixture.calls.some((call) => call.method === "thread.snapshot"));
    }),
);

it.effect("a Project archived while its launch is in flight admits no Run", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    fixture.state.archiveAfterThreadCreate = true;
    assert.equal((yield* owner.launch(launch).pipe(Effect.result))._tag, "Failure");
    // The bound Session keeps its deterministic Thread; nothing executes in an archived Project.
    assert.equal(fixture.bindings.size, 1);
    assert.deepEqual(
      [...fixture.commands.values()].map((command) => command.type),
      ["thread.create"],
    );
  }),
);

it.effect(
  "rejects another runtime and unrelated execution roots while allowing mutable Project routing",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const result = yield* owner.launch(launch);
      fixture.snapshots.set("child", snapshot("child", result.threadId));
      assert.equal(
        (yield* owner.read({ sessionId: launch.sessionId, threadId: "child" })).threadId,
        "child",
      );
      fixture.snapshots.set("foreign", snapshot("foreign", result.threadId, "other-project"));
      fixture.snapshots.set("unrelated", snapshot("unrelated", "another-root"));
      assert.equal(
        (yield* owner.read({ sessionId: launch.sessionId, threadId: "foreign" })).threadId,
        "foreign",
      );
      for (const threadId of ["unrelated"])
        assert.equal(
          (yield* owner.read({ sessionId: launch.sessionId, threadId }).pipe(Effect.result))._tag,
          "Failure",
        );
      fixture.state.runtimeId = "replacement-engine";
      const before = fixture.calls.length;
      assert.equal(
        (yield* owner.read({ sessionId: launch.sessionId }).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(fixture.calls.length, before);
    }),
);

it.effect(
  "sends message delivery intent to the serialized engine and preserves cursor boundaries",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const result = yield* owner.launch(launch);
      yield* owner.message({
        sessionId: launch.sessionId,
        intent: "steer",
        message: { messageId: "next", text: "Adjust it", attachments: [] },
      });
      const command = [...fixture.commands.values()].at(-1)!;
      assert.equal(command.type, "message.dispatch");
      if (command.type !== "message.dispatch") throw new Error("Expected message");
      assert.equal(command.threadId, result.threadId);
      assert.equal(command.deliveryIntent, "steer");
      assert.deepEqual(command.dispatchMode, { type: "start_immediately" });
      const page = yield* owner.history({
        sessionId: launch.sessionId,
        cursor: "opaque-oldest",
        throughEntryId: "entry-boundary",
        conversationOnly: true,
      });
      assert.equal(page.nextCursor, "next");
      assert.deepEqual(fixture.calls.at(-1), {
        method: "thread.history",
        input: {
          threadId: result.threadId,
          cursor: "opaque-oldest",
          throughEntryId: "entry-boundary",
          conversationOnly: true,
        },
      });
    }),
);

it.effect("refuses a queued message when its frozen root was rebound before admission", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    const opened = yield* owner.launch(launch);
    const binding = fixture.bindings.get(launch.sessionId)!;
    fixture.bindings.set(launch.sessionId, {
      ...binding,
      runtime_thread_id: "replacement-root",
    });
    fixture.snapshots.set("replacement-root", snapshot("replacement-root"));
    const before = fixture.commands.size;
    const result = yield* owner
      .queueMessage({
        sessionId: launch.sessionId,
        threadId: opened.threadId,
        message: { messageId: "frozen-follow-up", text: "Keep the original target" },
      })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(fixture.commands.size, before);
  }),
);

it.effect("a message continues the chat on another Agent only while the chat can hand over", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    const opened = yield* owner.launch(launch);
    const withProjection = (projection: Partial<AgentSnapshot["projection"]>) => {
      const current = fixture.snapshots.get(opened.threadId)!;
      fixture.snapshots.set(opened.threadId, {
        ...current,
        projection: {
          ...current.projection,
          thread: { ...current.projection.thread, activeProviderThreadId: "provider-thread" },
          providerSessions: [],
          ...projection,
        },
      });
    };
    const send = (messageId: string) =>
      owner
        .message({
          sessionId: launch.sessionId,
          threadId: opened.threadId,
          message: {
            messageId,
            text: "Continue on Codex",
            modelSelection: { instanceId: "codex", model: "gpt" },
          },
        })
        .pipe(Effect.result);
    const dispatched = (messageId: string) =>
      [...fixture.commands.values()].find(
        (command) => command.type === "message.dispatch" && command.messageId === messageId,
      );
    withProjection({
      runs: [{ id: "run", ordinal: 1, status: "starting", providerThreadId: null } as never],
      providerThreads: [],
    });
    const starting = yield* send("while-starting");
    assert.equal(starting._tag, "Failure");
    assert.isUndefined(dispatched("while-starting"));
    withProjection({
      runs: [
        {
          id: "run",
          ordinal: 1,
          status: "completed",
          providerThreadId: "provider-thread",
        } as never,
      ],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: opened.threadId,
          providerInstanceId: "claude",
          providerSessionId: null,
          nativeThreadRef: { driver: "claudeAgent", nativeId: "native", strength: "strong" },
        } as never,
      ],
    });
    const finished = yield* send("after-finish");
    assert.equal(finished._tag, "Success");
    assert.deepEqual(
      (dispatched("after-finish") as Extract<AgentCommand, { type: "message.dispatch" }>)
        .modelSelection,
      { instanceId: "codex", model: "gpt" },
    );
  }),
);

it.effect(
  "a fork merges its newest finished Run into the chat it came from, once both allow it",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const source = yield* owner.launch(launch);
      const sourceSnapshot = fixture.snapshots.get(source.threadId)!;
      fixture.snapshots.set(source.threadId, {
        ...sourceSnapshot,
        projection: {
          ...sourceSnapshot.projection,
          runs: [{ id: "run:source", ordinal: 1, status: "completed" } as never],
        },
      });
      const fork = yield* owner.fork({
        source: { sessionId: source.sessionId },
        sessionId: "session:fork",
        requestId: "fork:request",
        acceptedAt: launch.acceptedAt,
        environment: "same-directory",
        sourceRunId: "run:source",
      });
      const setRuns = (threadId: string, runs: readonly { id: string; status: string }[]) => {
        const current = fixture.snapshots.get(threadId)!;
        fixture.snapshots.set(threadId, {
          ...current,
          projection: {
            ...current.projection,
            runs: runs.map((run, index) => ({ ...run, ordinal: index + 1 }) as never),
          },
        });
      };
      const merge = (requestId: string) =>
        owner.mergeBack({ sessionId: fork.sessionId, requestId }).pipe(Effect.result);
      const merges = () =>
        [...fixture.commands.values()].filter((command) => command.type === "thread.merge_back");
      // Nothing finished in the fork yet, then the source is busy with its own reply.
      assert.equal((yield* merge("merge:empty"))._tag, "Failure");
      setRuns(fork.threadId, [
        { id: "fork:done", status: "completed" },
        { id: "fork:working", status: "running" },
      ]);
      assert.equal((yield* merge("merge:partial"))._tag, "Failure");
      setRuns(fork.threadId, [{ id: "fork:done", status: "completed" }]);
      setRuns(source.threadId, [{ id: "source:running", status: "running" }]);
      assert.equal((yield* merge("merge:busy"))._tag, "Failure");
      assert.lengthOf(merges(), 0);
      setRuns(source.threadId, [{ id: "source:done", status: "completed" }]);
      const merged = yield* owner.mergeBack({ sessionId: fork.sessionId, requestId: "merge:one" });
      assert.deepEqual(merged, {
        sessionId: source.sessionId,
        projectId: "project",
        threadId: source.threadId,
      });
      const [command] = merges();
      assert.deepInclude(command, {
        sourceThreadId: fork.threadId,
        targetThreadId: source.threadId,
        sourcePoint: { type: "run", runId: "fork:done" },
      });
      // A chat that is not a fork has nothing to merge.
      assert.equal(
        (yield* owner
          .mergeBack({ sessionId: source.sessionId, requestId: "merge:source" })
          .pipe(Effect.result))._tag,
        "Failure",
      );
    }),
);

it.effect("Stop targets the selected Run and never substitutes a newer foreground Run", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    const result = yield* owner.launch(launch);
    const current = fixture.snapshots.get(result.threadId)!;
    fixture.snapshots.set(result.threadId, {
      ...current,
      projection: {
        ...current.projection,
        runs: [
          { id: "old", threadId: result.threadId, status: "completed" },
          { id: "new", threadId: result.threadId, status: "running" },
        ] as never,
      },
    });
    assert.deepEqual(yield* owner.stop({ sessionId: launch.sessionId, runId: "old" }), {
      stopped: false,
    });
    assert.deepEqual(yield* owner.stop({ sessionId: launch.sessionId, runId: "foreign" }), {
      stopped: false,
    });
    yield* owner.stop({ sessionId: launch.sessionId, runId: "new" });
    yield* owner.stop({ sessionId: launch.sessionId, runId: "new" });
    const stops = [...fixture.commands.values()].filter(
      (command) => command.type === "run.interrupt",
    );
    assert.equal(stops.length, 1);
    assert.deepEqual(stops[0], {
      type: "run.interrupt",
      commandId: stops[0]!.commandId,
      threadId: result.threadId,
      runId: "new",
      holdQueue: true,
    });
  }),
);

for (const kind of ["user_input", "mcp-elicitation"] as const) {
  it.effect(`${kind} replies require an exact pending request owned by the selected Run`, () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const result = yield* owner.launch(launch);
      const current = fixture.snapshots.get(result.threadId)!;
      fixture.snapshots.set(result.threadId, {
        ...current,
        projection: {
          ...current.projection,
          runs: [{ id: "run", threadId: result.threadId, status: "waiting" }] as never,
          nodes: [{ id: "node", threadId: result.threadId, runId: "run" }] as never,
          runtimeRequests: [
            {
              id: "request",
              kind,
              nodeId: "node",
              status: "pending",
              responseCapability: { type: "live", providerSessionId: "native-session" },
            },
          ] as never,
        },
      });
      assert.equal(
        (yield* owner
          .respond({
            sessionId: launch.sessionId,
            runId: "other",
            requestId: "request",
            answers: { question: ["Yes"] },
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* owner.respond({
        sessionId: launch.sessionId,
        runId: "run",
        requestId: "request",
        answers: { question: ["Yes"] },
        ...(kind === "mcp-elicitation" ? { decision: "accept" as const } : {}),
      });
      const command = [...fixture.commands.values()].at(-1)!;
      assert.equal(command.type, "runtime-request.respond");
      if (command.type !== "runtime-request.respond") throw new Error("Expected response");
      assert.deepEqual(command.answers, { question: ["Yes"] });
      assert.equal(command.requestId, "request");
      assert.equal(command.decision, kind === "mcp-elicitation" ? "accept" : undefined);
    }),
  );
}

it.effect(
  "gives each optional-answer batch a stable distinct receipt even after request completion",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const result = yield* owner.launch(launch);
      const current = fixture.snapshots.get(result.threadId)!;
      fixture.snapshots.set(result.threadId, {
        ...current,
        projection: {
          ...current.projection,
          nodes: [{ id: "question-node", threadId: result.threadId, runId: "source-run" }] as never,
          runtimeRequests: [
            {
              id: "optional-question",
              kind: "user_input",
              nodeId: "question-node",
              status: "resolved",
              responseCapability: { type: "message", replyFormat: "codex_question_reply" },
            },
          ] as never,
        },
      });
      const input = {
        sessionId: result.sessionId,
        runId: "source-run",
        requestId: "optional-question",
        submissionId: "batch-first",
        answers: { first: "Project" },
      };
      yield* owner.respond(input);
      yield* owner.respond(input);
      yield* owner.respond({
        ...input,
        submissionId: "batch-second",
        answers: { second: "Release" },
      });
      const responses = [...fixture.commands.values()].filter(
        (command) => command.type === "runtime-request.respond",
      );
      assert.strictEqual(responses.length, 2);
      assert.notStrictEqual(responses[0]?.commandId, responses[1]?.commandId);
      const addressed = fixture.calls.filter((call) => call.method === "thread.control").at(-1);
      assert.deepInclude(addressed?.input, { requestId: "optional-question", runId: "source-run" });
    }),
);

it.effect(
  "lazily prepares a fresh projectless root and retries without duplicating its bound execution",
  () =>
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(join(tmpdir(), "nodex-projectless-root-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      );
      const workspaceRoot = join(home, "tasks");
      const fixture = setup({
        projectless: {
          engineProjectId: "profile:projectless",
          workspaceRoot,
          ensureWorkspaceRoot: Effect.tryPromise(() =>
            mkdir(workspaceRoot, { recursive: true }),
          ).pipe(
            Effect.tap(() => Effect.sync(() => fixture.order.push("workspace.root.ready"))),
            Effect.asVoid,
          ),
        },
      });
      const owner = yield* fixture.owner;
      assert.equal(
        (yield* Effect.tryPromise(() => access(workspaceRoot)).pipe(Effect.result))._tag,
        "Failure",
      );
      const input = { ...launch, projectId: null, initialPageIds: [] };
      const result = yield* owner.launch(input);
      assert.equal(
        yield* Effect.tryPromise(() => realpath(workspaceRoot)),
        join(yield* Effect.tryPromise(() => realpath(home)), "tasks"),
      );
      const initial = yield* Effect.tryPromise(() => stat(workspaceRoot));
      assert.deepEqual(yield* owner.launch(input), result);
      assert.equal((yield* Effect.tryPromise(() => stat(workspaceRoot))).ino, initial.ino);
      assert.equal(result.projectId, null);
      assert.equal(fixture.bindings.get(launch.sessionId)!.project_id, null);
      assert.isFalse(fixture.calls.some((call) => call.method === "thread.snapshot"));
      assert.equal(
        (yield* owner.read({ sessionId: result.sessionId })).snapshot.projection.thread.projectId,
        "profile:projectless",
      );
      assert.deepEqual(fixture.calls.find((call) => call.method === "project.upsert")!.input, {
        id: "profile:projectless",
        title: "Tasks",
        workspaceRoot,
      });
      assert.isBelow(
        fixture.order.indexOf("workspace.root.ready"),
        fixture.order.indexOf("project.upsert"),
      );
      assert.isBelow(
        fixture.order.indexOf("core.bind"),
        fixture.order.indexOf("engine.message.dispatch"),
      );
      assert.equal(fixture.order.filter((operation) => operation === "core.bind").length, 1);
      assert.equal(
        [...fixture.commands.values()].filter((command) => command.type === "thread.create").length,
        1,
      );
      assert.equal(
        [...fixture.commands.values()].filter((command) => command.type === "message.dispatch")
          .length,
        1,
      );
    }).pipe(Effect.scoped),
);

const agent = {
  profile_id: "profile",
  authority: {
    actor_project_id: "project",
    thread_id: "actor",
    turn_id: "turn",
    root_thread_id: "actor",
    library_id: "library",
    store_epoch: "epoch",
  },
} as const satisfies components["schemas"]["AgentTurnProvenance"];

it.effect("Agent-authored launch retains its provenance for Core Session and Page admission", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    yield* owner.launch(launch).pipe(Effect.provideService(CoreApplicationAgent, agent));
    assert.deepEqual(fixture.actors, [agent]);
    assert.equal(fixture.state.gateDepth, 0);
  }),
);

it.effect(
  "a worktree launch keeps its prompt durable while one workspace is prepared and released",
  () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const prepared: import("../agent-backend/NativeSessionWorkspace").NativeSessionWorkspaceInput[] =
        [];
      const fixture = setup({
        prepareWorkspace: (input) =>
          Effect.gen(function* () {
            prepared.push(input);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                events.push("release");
              }),
            );
            return {
              location: {
                cwd: "/worktrees/task/packages/app",
                workspaceRoots: ["/worktrees/task/packages/app"],
                managedWorktreePath: "/worktrees/task",
                projectlessOutputDirectory: null,
                projectlessWorkspaceBrowserRoot: null,
              },
              retain: Effect.sync(() => {
                events.push("retain");
              }),
              attach: (threadId) =>
                Effect.sync(() => {
                  events.push(`attach:${threadId}`);
                }),
            };
          }),
      });
      const owner = yield* fixture.owner;
      const input = {
        ...launch,
        runInTarget: "newWorktree" as const,
        runInEnvironmentPath: "environment.toml",
        worktreeStartingState: { type: "branch" as const, branchName: "feature" },
      };
      const result = yield* owner.launch(input);
      yield* awaitCommand(fixture, "prepared-run.release");
      const types = [...fixture.commands.values()].map((command) => command.type);
      // The prompt is durable before any filesystem work; the Run starts after relocation.
      assert.deepEqual(types, [
        "thread.create",
        "message.dispatch",
        "prepared-run.progress",
        "thread.metadata.update",
        "prepared-run.release",
      ]);
      const dispatched = [...fixture.commands.values()][1] as Extract<
        AgentCommand,
        { type: "message.dispatch" }
      >;
      assert.deepEqual(dispatched.dispatchMode, {
        type: "defer_start",
        workspaceStrategy: { type: "worktree", baseRef: "feature" },
      });
      assert.deepEqual(events, [`attach:${result.threadId}`, "release"]);
      assert.equal(prepared[0]!.sourceCwd, "/workspace");
      assert.equal(prepared[0]!.localEnvironmentConfigPath, "environment.toml");
      assert.equal(
        fixture.snapshots.get(result.threadId)!.projection.thread.worktreePath,
        "/worktrees/task/packages/app",
      );
      assert.isFalse(
        fixture.calls.some((call) => call.method === "thread.snapshot"),
        "Launch must not hydrate transcript bodies",
      );
      yield* owner.launch(input);
      assert.equal(prepared.length, 1, "Receipt replay never prepares a second workspace");
    }),
);

it.effect("a failed worktree preparation can be retried or started in the source checkout", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const fixture = setup({
      prepareWorkspace: () =>
        Effect.suspend(() =>
          (attempts += 1) === 1
            ? Effect.fail(
                new Error(`Branch feature is checked out elsewhere\n${"detail ".repeat(1_000)}\n`),
              )
            : Effect.succeed({
                location: {
                  cwd: "/worktrees/retried",
                  workspaceRoots: ["/worktrees/retried"],
                  managedWorktreePath: "/worktrees/retried",
                  projectlessOutputDirectory: null,
                  projectlessWorkspaceBrowserRoot: null,
                },
                retain: Effect.void,
                attach: () => Effect.void,
              }),
        ) as never,
    });
    const owner = yield* fixture.owner;
    const result = yield* owner.launch({ ...launch, runInTarget: "newWorktree" });
    const failed = (yield* awaitCommand(fixture, "prepared-run.fail")) as Extract<
      AgentCommand,
      { type: "prepared-run.fail" }
    >;
    assert.include(failed.failure.message, "checked out elsewhere");
    // A tool can report more than the engine stores; the failure is still recorded.
    assert.equal(failed.failure.message, failed.failure.message.trim());
    assert.isAtMost(failed.failure.message.length, 4_096);
    const runId = failed.runId;
    yield* owner.retryPreparation({
      sessionId: result.sessionId,
      requestId: "retry-one",
      runId,
      workLocally: false,
    });
    yield* awaitCommand(fixture, "prepared-run.release");
    assert.equal(
      fixture.snapshots.get(result.threadId)!.projection.thread.worktreePath,
      "/worktrees/retried",
    );
    assert.equal(attempts, 2);
  }),
);

it.effect("a preparation interrupted by a restart fails readably instead of waiting forever", () =>
  Effect.gen(function* () {
    const fixture = setup({
      prepareWorkspace: () => Effect.never as never,
    });
    const owner = yield* fixture.owner;
    const result = yield* owner.launch({ ...launch, runInTarget: "newWorktree" });
    // A fresh Main process has no live preparation for the waiting Run.
    const restarted = yield* fixture.owner;
    yield* restarted.reconcileLiveExecutions();
    const failed = [...fixture.commands.values()].find(
      (command) => command.type === "prepared-run.fail",
    ) as Extract<AgentCommand, { type: "prepared-run.fail" }> | undefined;
    assert.include(failed?.failure.message ?? "", "interrupted");
    assert.equal(failed?.threadId, result.threadId);
  }),
);

it.effect(
  "rejects image launches before binding or materialization using the final configured model",
  () =>
    Effect.gen(function* () {
      for (const message of [
        { modelSelection: { instanceId: "codex", model: "model-b" } },
        { modelSelection: { instanceId: "codex", model: "unknown" } },
        { agentConfigs: [{ model: "model-b" }] },
      ]) {
        let materialized = 0;
        const fixture = setup({
          prepareImages: () =>
            Effect.sync(() => {
              materialized += 1;
              return [{ mediaType: "image/png", data: "aW1hZ2U=" }];
            }),
        });
        const owner = yield* fixture.owner;
        const result = yield* owner
          .launch({
            ...launch,
            modelSelection: { instanceId: "codex", model: "model-a" },
            message: {
              messageId: "refused-image",
              text: "Read it",
              images: [{ source: "nodex-asset:private" }],
              ...message,
            },
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.match(result.failure.message, /image/i);
        assert.equal(materialized, 0);
        assert.equal(fixture.applied.length, 0);
        assert.equal(fixture.bindings.size, 0);
        assert.equal(fixture.commands.size, 0);
      }
    }),
);

it.effect("admits images when Agent config selects vision from a text-only default", () =>
  Effect.gen(function* () {
    let materialized = 0;
    const fixture = setup({
      prepareImages: () =>
        Effect.sync(() => {
          materialized += 1;
          return [{ mediaType: "image/png", data: "aW1hZ2U=" }];
        }),
    });
    const owner = yield* fixture.owner;
    yield* owner.launch({
      ...launch,
      modelSelection: { instanceId: "codex", model: "model-b" },
      message: {
        messageId: "configured-vision",
        text: "Read it",
        agentConfigs: [{ model: "model-a" }],
        images: [{ source: "nodex-asset:diagram" }],
      },
    });
    const dispatched = [...fixture.commands.values()].find(
      (command) => command.type === "message.dispatch",
    );
    assert.equal(dispatched?.type, "message.dispatch");
    if (dispatched?.type !== "message.dispatch") throw new Error("Expected admitted message");
    assert.equal(dispatched.modelSelection?.model, "model-a");
    assert.equal(dispatched.attachments[0]?.type, "image");
    assert.equal(materialized, 1);
    assert.equal(fixture.bindings.size, 1);
  }),
);

it.effect(
  "rejects follow-up image sources and persisted image references for the requested model",
  () =>
    Effect.gen(function* () {
      let materialized = 0;
      const fixture = setup({
        prepareImages: () =>
          Effect.sync(() => {
            materialized += 1;
            return [{ mediaType: "image/png", data: "aW1hZ2U=" }];
          }),
      });
      const owner = yield* fixture.owner;
      const created = yield* owner.launch({
        ...launch,
        modelSelection: { instanceId: "codex", model: "model-a" },
      });
      const initialCommands = fixture.commands.size;
      for (const attachment of [
        { images: [{ source: "nodex-asset:private" }] },
        {
          attachments: [
            { type: "image", id: "owned", name: "Image", mimeType: "image/png", sizeBytes: 10 },
          ],
        },
      ]) {
        const result = yield* owner
          .message({
            sessionId: created.sessionId,
            message: {
              messageId: "refused-follow-up",
              text: "Read it",
              modelSelection: { instanceId: "codex", model: "model-b" },
              ...attachment,
            },
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
      }
      assert.equal(materialized, 0);
      assert.equal(fixture.commands.size, initialCommands);
      assert.isFalse(fixture.calls.some((call) => call.method === "attachments.persist"));
    }),
);

it.effect(
  "validates an image queue edit against its exact Run model, independently of the Thread default",
  () =>
    Effect.gen(function* () {
      let materialized = 0;
      const fixture = setup({
        prepareImages: () =>
          Effect.sync(() => {
            materialized += 1;
            return [{ mediaType: "image/png", data: "aW1hZ2U=" }];
          }),
      });
      const owner = yield* fixture.owner;
      const created = yield* owner.launch({
        ...launch,
        modelSelection: { instanceId: "codex", model: "model-a" },
      });
      const original = fixture.snapshots.get(created.threadId)!;
      const run = {
        id: "queued-image",
        userMessageId: "queued-message",
        status: "queued",
        ordinal: 2,
        modelSelection: { instanceId: "codex", model: "model-b" },
        interactionMode: "default",
      };
      fixture.snapshots.set(created.threadId, {
        ...original,
        projection: { ...original.projection, runs: [run as never] },
      });
      const edit = {
        sessionId: created.sessionId,
        requestId: "image-edit",
        action: "edit" as const,
        runId: run.id,
        message: {
          messageId: run.userMessageId,
          text: "Read it",
          images: [{ source: "nodex-asset:private" }],
        },
      };
      assert.equal((yield* owner.queue(edit).pipe(Effect.result))._tag, "Failure");
      assert.equal(materialized, 0);
      assert.isTrue(
        fixture.calls.some(
          (call) =>
            call.method === "thread.control" && (call.input as { runId?: string }).runId === run.id,
        ),
      );
      fixture.snapshots.set(created.threadId, {
        ...original,
        projection: {
          ...original.projection,
          thread: { ...original.projection.thread, modelSelection: run.modelSelection },
          runs: [{ ...run, modelSelection: { instanceId: "codex", model: "model-a" } } as never],
        },
      });
      yield* owner.queue({ ...edit, requestId: "image-edit-supported" });
      assert.equal(materialized, 1);
    }),
);

it.effect("refuses a queued model change that would retain incompatible images", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    const created = yield* owner.launch({
      ...launch,
      modelSelection: { instanceId: "codex", model: "model-a" },
    });
    const original = fixture.snapshots.get(created.threadId)!;
    const run = {
      id: "queued-retained",
      userMessageId: "queued-message",
      status: "queued",
      ordinal: 2,
      modelSelection: { instanceId: "codex", model: "model-a" },
      interactionMode: "default",
    };
    fixture.snapshots.set(created.threadId, {
      ...original,
      projection: {
        ...original.projection,
        runs: [run as never],
        messages: [
          {
            id: run.userMessageId,
            text: "Read it",
            attachments: [
              { type: "image", id: "owned", name: "Image", mimeType: "image/png", sizeBytes: 10 },
            ],
          } as never,
        ],
      },
    });
    const before = fixture.commands.size;
    const result = yield* owner
      .queue({
        sessionId: created.sessionId,
        requestId: "retained-edit",
        action: "edit",
        runId: run.id,
        message: {
          messageId: run.userMessageId,
          text: "Use text model",
          modelSelection: { instanceId: "codex", model: "model-b" },
        },
      })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(fixture.commands.size, before);
  }),
);

it.effect(
  "owned images are persisted after Thread admission and scoped detail keeps its bound target",
  () =>
    Effect.gen(function* () {
      const prepared: unknown[] = [];
      const fixture = setup({
        prepareImages: (images) =>
          Effect.sync(() => {
            prepared.push(images);
            return [{ mediaType: "image/png", data: "aW1hZ2U=" }];
          }),
      });
      const owner = yield* fixture.owner;
      const result = yield* owner.launch({
        ...launch,
        modelSelection: { instanceId: "codex", model: "model-a" },
        message: {
          messageId: "image-message",
          text: "",
          images: [{ source: "nodex-asset:attached", caption: "Diagram" }],
        },
      });
      const persistIndex = fixture.calls.findIndex((call) => call.method === "attachments.persist");
      assert.isAbove(
        persistIndex,
        fixture.calls.findIndex((call) => call.method === "command.dispatch"),
      );
      const dispatched = [...fixture.commands.values()].find(
        (command) => command.type === "message.dispatch",
      ) as Extract<AgentCommand, { type: "message.dispatch" }>;
      assert.deepEqual(dispatched.attachments, [
        { type: "image", id: "asset_0", name: "Diagram", mimeType: "image/png", sizeBytes: 5 },
      ]);
      const before = prepared.length;
      fixture.snapshots.set("foreign", snapshot("foreign", "unrelated"));
      assert.equal(
        (yield* owner
          .message({
            sessionId: result.sessionId,
            threadId: "foreign",
            message: {
              messageId: "foreign-image",
              text: "",
              images: [{ source: "/private/image" }],
            },
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(prepared.length, before);
      yield* owner.item({
        sessionId: result.sessionId,
        itemId: "inherited",
        sourceThreadId: "ancestor",
      });
      assert.deepEqual(fixture.calls.at(-1)!.input, {
        threadId: result.threadId,
        itemId: "inherited",
        sourceThreadId: "ancestor",
      });
      yield* owner.item({
        sessionId: result.sessionId,
        itemId: "inherited",
        sourceThreadId: "ancestor",
        full: true,
      });
      assert.deepEqual(fixture.calls.at(-1), {
        method: "thread.item.full",
        input: {
          threadId: result.threadId,
          itemId: "inherited",
          sourceThreadId: "ancestor",
        },
      });
      yield* owner.itemContent({
        sessionId: result.sessionId,
        itemId: "inherited",
        sourceThreadId: "ancestor",
        format: "json",
        textOffset: 4000,
        maxChars: 2000,
      });
      assert.deepEqual(fixture.calls.at(-1), {
        method: "thread.item.content",
        input: {
          threadId: result.threadId,
          itemId: "inherited",
          sourceThreadId: "ancestor",
          format: "json",
          textOffset: 4000,
          maxChars: 2000,
        },
      });
      yield* owner.timeline({
        sessionId: result.sessionId,
        view: "activity",
        order: "newest_first",
        beforeItem: { sourceThreadId: "ancestor", sourceItemId: "inherited" },
        limit: 7,
      });
      assert.deepEqual(fixture.calls.at(-1), {
        method: "thread.timeline",
        input: {
          threadId: result.threadId,
          view: "activity",
          order: "newest_first",
          beforeItem: { sourceThreadId: "ancestor", sourceItemId: "inherited" },
          limit: 7,
        },
      });
      const beforeForeignRead = fixture.calls.length;
      assert.equal(
        (yield* owner
          .itemContent({
            sessionId: result.sessionId,
            threadId: "foreign",
            itemId: "inherited",
            format: "text",
            maxChars: 2000,
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        fixture.calls
          .slice(beforeForeignRead)
          .some((call) => call.method === "thread.item.content"),
        false,
      );
      const image = yield* owner.attachment({
        sessionId: result.sessionId,
        itemId: "inherited",
        sourceThreadId: "ancestor",
        attachmentId: "image",
      });
      assert.deepEqual(image, { path: "/managed/attachment.png" });
      assert.deepEqual(fixture.calls.at(-1), {
        method: "thread.attachment",
        input: {
          threadId: result.threadId,
          itemId: "inherited",
          sourceThreadId: "ancestor",
          attachmentId: "image",
        },
      });
    }),
);

it.effect("Session forks bind a distinct root while inspection and overview remain body-free", () =>
  Effect.gen(function* () {
    const prepared: import("../agent-backend/NativeSessionWorkspace").NativeSessionWorkspaceInput[] =
      [];
    const fixture = setup({
      prepareWorkspace: (input) =>
        Effect.sync(() => {
          prepared.push(input);
          return {
            location: {
              cwd: "/worktrees/fork/packages/app",
              workspaceRoots: ["/worktrees/fork/packages/app"],
              managedWorktreePath: "/worktrees/fork",
              projectlessOutputDirectory: null,
              projectlessWorkspaceBrowserRoot: null,
            },
            retain: Effect.void,
            attach: () => Effect.void,
          };
        }),
    });
    const owner = yield* fixture.owner;
    const source = yield* owner.launch(launch);
    const sourceSnapshot = fixture.snapshots.get(source.threadId)!;
    fixture.snapshots.set(source.threadId, {
      ...sourceSnapshot,
      projection: {
        ...sourceSnapshot.projection,
        runs: [{ id: "run:source", ordinal: 1, status: "completed" } as never],
      },
    });
    const before = fixture.calls.filter((call) => call.method === "thread.snapshot").length;
    yield* owner.inspect({ sessionId: source.sessionId });
    fixture.state.missingSessionLookupError = coreRuntimeError({
      operation: "workspace.read",
      reason: "operation",
      retryable: false,
      cause: new CoreModuleResponseError({
        code: "not_found",
        message: "Session is unavailable in this Library",
        retryable: false,
        recovery: { kind: "none" },
      }),
    });
    const result = yield* owner.fork({
      source: { sessionId: source.sessionId },
      sessionId: "session:fork",
      requestId: "fork:request",
      acceptedAt: launch.acceptedAt,
      environment: "same-directory",
      sourceRunId: "run:source",
    });
    const command = [...fixture.commands.values()].find(
      (command) => command.type === "thread.fork",
    )!;
    assert.equal(command.type, "thread.fork");
    if (command.type !== "thread.fork") return;
    assert.equal(command.rootPolicy, "independent_root");
    assert.deepEqual(command.sourcePoint, { type: "run", runId: "run:source" });
    assert.equal(fixture.bindings.get(result.sessionId)?.runtime_thread_id, result.threadId);
    assert.equal(
      (yield* owner.inspect({ sessionId: result.sessionId })).rootThreadId,
      result.threadId,
    );
    assert.equal(fixture.calls.filter((call) => call.method === "thread.snapshot").length, before);
    const retry = yield* owner.fork({
      source: { sessionId: source.sessionId },
      sessionId: "session:fork",
      requestId: "fork:request",
      acceptedAt: launch.acceptedAt,
      environment: "same-directory",
      sourceRunId: "run:source",
    });
    assert.equal(retry.threadId, result.threadId);
    assert.equal(
      [...fixture.commands.values()].filter((command) => command.type === "thread.fork").length,
      1,
    );
    const preparedBeforeFork = prepared.length;
    const worktree = yield* owner.fork({
      source: { sessionId: source.sessionId },
      sessionId: "session:worktree-fork",
      requestId: "fork:worktree-request",
      acceptedAt: launch.acceptedAt,
      environment: "worktree",
      sourceRunId: "run:source",
      runInEnvironmentPath: "environment.toml",
    });
    assert.equal(prepared.length, preparedBeforeFork + 1);
    assert.equal(prepared.at(-1)!.localEnvironmentConfigPath, "environment.toml");
    assert.equal(prepared.at(-1)!.sourceCwd, "/worktrees/fork/packages/app");
    assert.equal(
      (yield* owner.inspect({ sessionId: worktree.sessionId })).thread.worktreePath,
      "/worktrees/fork/packages/app",
    );
    assert.equal(fixture.calls.filter((call) => call.method === "thread.snapshot").length, before);
  }),
);

it.effect.each([undefined, "run:missing", "run:active"])(
  "rejects an unavailable fork source %s before creating a Session",
  (sourceRunId) =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const source = yield* owner.launch(launch);
      const current = fixture.snapshots.get(source.threadId)!;
      fixture.snapshots.set(source.threadId, {
        ...current,
        projection: {
          ...current.projection,
          runs:
            sourceRunId === undefined
              ? []
              : [{ id: "run:active", ordinal: 1, status: "running" } as never],
        },
      });
      const mutations = fixture.applied.length;
      const commands = fixture.commands.size;
      const result = yield* owner
        .fork({
          source: { sessionId: source.sessionId },
          sessionId: "session:invalid-fork",
          requestId: "fork:invalid",
          acceptedAt: launch.acceptedAt,
          environment: "same-directory",
          ...(sourceRunId === undefined ? {} : { sourceRunId }),
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(fixture.applied.length, mutations);
      assert.equal(fixture.commands.size, commands);
      assert.isFalse(fixture.bindings.has("session:invalid-fork"));
    }),
);

it.effect("head forks freeze the Runtime-selected non-Git source before binding the Session", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    const source = yield* owner.launch(launch);
    const current = fixture.snapshots.get(source.threadId)!;
    fixture.snapshots.set(source.threadId, {
      ...current,
      projection: {
        ...current.projection,
        runs: [
          { id: "run:old", ordinal: 1, status: "completed", checkpointId: "checkpoint:old" },
          { id: "run:head", ordinal: 2, status: "interrupted", checkpointId: null },
          { id: "run:queued", ordinal: 3, status: "queued", checkpointId: null },
        ] as never,
      },
    });
    const before = fixture.calls.length;
    const orderBefore = fixture.order.length;
    const fork = yield* owner.fork({
      source: { sessionId: source.sessionId },
      sessionId: "session:head-fork",
      requestId: "fork:head",
      acceptedAt: launch.acceptedAt,
      environment: "same-directory",
    });
    assert.deepInclude(
      [...fixture.commands.values()].find((command) => command.type === "thread.fork"),
      { sourcePoint: { type: "run", runId: "run:head" } },
    );
    assert.equal(fixture.bindings.get(fork.sessionId)?.runtime_thread_id, fork.threadId);
    const order = fixture.order.slice(orderBefore);
    assert.isBelow(order.indexOf("thread.fork-source"), order.indexOf("core.bind"));
    assert.deepEqual(
      fixture.calls.slice(before).filter((call) => call.method === "thread.fork-source"),
      [{ method: "thread.fork-source", input: { threadId: source.threadId } }],
    );
    assert.isFalse(
      fixture.calls
        .slice(before)
        .some((call) =>
          ["thread.snapshot", "thread.history", "thread.control"].includes(call.method),
        ),
    );
  }),
);

it.effect.each(["conflict", "transport-loss"] as const)(
  "a destination binding %s prevents fork metadata and Core mutations",
  (reason) =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const source = yield* owner.launch(launch);
      const failure = coreRuntimeError({
        operation: "workspace.read",
        reason: reason === "conflict" ? "operation" : "transport-loss",
        retryable: reason === "transport-loss",
        cause:
          reason === "conflict"
            ? new CoreModuleResponseError({
                code: "conflict",
                message: "Execution identity changed",
                retryable: false,
                recovery: { kind: "none" },
              })
            : new Error("Core connection closed before lookup completed"),
      });
      fixture.state.missingSessionLookupError = failure;
      const commands = fixture.commands.size;
      const mutations = fixture.applied.length;
      const result = yield* owner
        .fork({
          source: { sessionId: source.sessionId },
          sessionId: "session:unconfirmed-fork",
          requestId: "fork:unconfirmed-request",
          acceptedAt: launch.acceptedAt,
          environment: "same-directory",
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.cause, failure);
      assert.equal(fixture.commands.size, commands);
      assert.equal(fixture.applied.length, mutations);
      assert.equal(fixture.bindings.has("session:unconfirmed-fork"), false);
    }),
);

it.effect(
  "Project activity and archived history reads never acquire execution admission gates",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const created = yield* owner.launch(launch);
      fixture.state.lifecycle = "archived";
      const before = fixture.calls.length;
      yield* owner.inspect({ sessionId: created.sessionId });
      assert.equal(fixture.state.gateDepth, 0);
      assert.deepEqual(yield* owner.projectActivity("project"), {
        snapshotSequence: 3,
        run: null,
        runtimeRequest: null,
        nativeBackground: null,
      });
      assert.isFalse(fixture.calls.slice(before).some((call) => call.method === "thread.snapshot"));
      assert.equal(
        (yield* owner.projectActivity("different-project").pipe(
          Effect.provideService(CoreApplicationAgent, {
            authority: { actor_project_id: "project" },
          } as never),
          Effect.result,
        ))._tag,
        "Success",
      );
    }),
);

it.effect("writer admission holds the complete launch saga and leaves inspections outside it", () =>
  Effect.gen(function* () {
    let writers = 0;
    const fixture = setup({
      withWriter: (effect) =>
        Effect.gen(function* () {
          writers++;
          return yield* effect;
        }),
    });
    const owner = yield* fixture.owner;
    const started = yield* owner.launch(launch);
    assert.equal(writers, 1);
    yield* owner.inspect({ sessionId: started.sessionId });
    yield* owner.read({ sessionId: started.sessionId });
    assert.equal(writers, 1);
    yield* owner.message({
      sessionId: started.sessionId,
      message: { messageId: "writer-message", text: "Next" },
    });
    assert.equal(writers, 2);
  }),
);

it.effect("Session lifecycle waits for the handoff lane while stop remains available", () =>
  Effect.gen(function* () {
    for (const kind of ["archive", "delete", "move"] as const) {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const started = yield* owner.launch(launch);
      const active = fixture.snapshots.get(started.threadId)!;
      fixture.snapshots.set(started.threadId, {
        ...active,
        projection: { ...active.projection, runs: [{ id: "active", status: "running" } as never] },
      });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const handoff = yield* owner
        .withExecutionLocationWriter(
          started.sessionId,
          Effect.gen(function* () {
            setExecutionHold(fixture, started.threadId, true);
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            setExecutionHold(fixture, started.threadId, false);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const operation =
        kind === "archive"
          ? owner
              .archiveSession({ operationId: kind, payload: { sessionId: started.sessionId } })
              .pipe(Effect.asVoid)
          : kind === "delete"
            ? owner
                .deleteSession({ operationId: kind, payload: { sessionId: started.sessionId } })
                .pipe(Effect.asVoid)
            : owner
                .moveSession({
                  operationId: kind,
                  sessionId: started.sessionId,
                  projectId: "other",
                })
                .pipe(Effect.asVoid);
      const attempt = yield* operation.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isTrue(fixture.bindings.has(started.sessionId));
      assert.isFalse(fixture.state.archived);
      assert.strictEqual(fixture.bindings.get(started.sessionId)?.project_id, "project");
      assert.notInclude(fixture.order, `core.${kind}`);
      assert.isFalse(fixture.applied.some((value) => value.intent.kind === "move_session"));
      assert.deepEqual(yield* owner.stop({ sessionId: started.sessionId, runId: "active" }), {
        stopped: true,
      });
      assert.isTrue(
        fixture.calls.some(
          (call) =>
            call.method === "command.dispatch" &&
            (call.input as AgentRuntimeOperations["command.dispatch"]["input"]).command.type ===
              "run.interrupt",
        ),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(handoff);
      yield* Fiber.join(attempt);
      if (kind === "archive") assert.isTrue(fixture.state.archived);
      if (kind === "delete") assert.isFalse(fixture.bindings.has(started.sessionId));
      if (kind === "move")
        assert.strictEqual(fixture.bindings.get(started.sessionId)?.project_id, "other");
    }
  }),
);

it.effect(
  "durable handoff recovery rejects destructive Session lifecycle before Core mutation",
  () =>
    Effect.gen(function* () {
      for (const kind of ["archive", "delete", "move"] as const) {
        const fixture = setup();
        const owner = yield* fixture.owner;
        const started = yield* owner.launch(launch);
        setExecutionHold(fixture, started.threadId, true);
        const operation =
          kind === "archive"
            ? owner
                .archiveSession({ operationId: kind, payload: { sessionId: started.sessionId } })
                .pipe(Effect.asVoid)
            : kind === "delete"
              ? owner
                  .deleteSession({ operationId: kind, payload: { sessionId: started.sessionId } })
                  .pipe(Effect.asVoid)
              : owner
                  .moveSession({
                    operationId: kind,
                    sessionId: started.sessionId,
                    projectId: "other",
                  })
                  .pipe(Effect.asVoid);
        assert.strictEqual((yield* operation.pipe(Effect.result))._tag, "Failure");
        assert.isTrue(fixture.bindings.has(started.sessionId));
        assert.isFalse(fixture.state.archived);
        assert.strictEqual(fixture.bindings.get(started.sessionId)?.project_id, "project");
        assert.notInclude(fixture.order, `core.${kind}`);
        assert.isFalse(fixture.applied.some((value) => value.intent.kind === "move_session"));
        setExecutionHold(fixture, started.threadId, false);
        yield* operation;
        if (kind === "archive") assert.isTrue(fixture.state.archived);
        if (kind === "delete") assert.isFalse(fixture.bindings.has(started.sessionId));
        if (kind === "move")
          assert.strictEqual(fixture.bindings.get(started.sessionId)?.project_id, "other");
      }
    }),
);

it.effect(
  "closing archived Project execution rechecks current authority and never loads transcript history",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      fixture.state.lifecycle = "archived";
      assert.deepEqual(yield* owner.closeProjectExecution("project"), { closedBindings: 2 });
      assert.isFalse(
        fixture.calls.some(
          (call) => call.method === "thread.snapshot" || call.method === "thread.control",
        ),
      );
      fixture.state.denyAgent = true;
      assert.equal(
        (yield* owner
          .closeProjectExecution("project")
          .pipe(Effect.provideService(CoreApplicationAgent, agent), Effect.result))._tag,
        "Failure",
      );
      fixture.state.denyAgent = false;
      yield* owner
        .closeProjectExecution("foreign")
        .pipe(Effect.provideService(CoreApplicationAgent, agent));
      assert.equal(fixture.calls.at(-1)?.method, "project.close");
    }),
);

it.effect(
  "reconciles Core-only placement changes before child execution and both Project activity reads",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const started = yield* owner.launch(launch);
      fixture.snapshots.set("child", snapshot("child", started.threadId));
      fixture.bindings.set(started.sessionId, {
        ...fixture.bindings.get(started.sessionId)!,
        project_id: "other",
      });
      fixture.calls.length = 0;
      yield* owner.message({
        sessionId: started.sessionId,
        threadId: "child",
        message: { messageId: "moved-message", text: "Continue" },
      });
      assert.equal(fixture.snapshots.get(started.threadId)?.projection.thread.projectId, "other");
      assert.equal(fixture.snapshots.get("child")?.projection.thread.projectId, "other");
      assert.isFalse(fixture.calls.some((call) => call.method === "thread.snapshot"));
      fixture.bindings.set(started.sessionId, {
        ...fixture.bindings.get(started.sessionId)!,
        project_id: "third",
      });
      yield* owner.projectActivity("other");
      assert.equal(fixture.snapshots.get(started.threadId)?.projection.thread.projectId, "third");
      yield* owner.projectActivity("third");
      assert.isFalse(
        fixture.calls.some(
          (call) =>
            call.method === "thread.snapshot" ||
            call.method === "thread.control" ||
            call.method === "thread.history",
        ),
      );
    }),
);

it.effect(
  "moves a bound Session without changing execution identity and keeps empty Profile lifecycle checks cold",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const started = yield* owner.launch(launch);
      yield* owner.moveSession({
        operationId: "move:one",
        sessionId: started.sessionId,
        projectId: "other",
      });
      assert.equal(fixture.bindings.get(started.sessionId)?.runtime_thread_id, started.threadId);
      assert.equal(fixture.snapshots.get(started.threadId)?.projection.thread.projectId, "other");
      const cold = setup({ runtimeExists: Effect.succeed(false) });
      const coldOwner = yield* cold.owner;
      assert.deepEqual(yield* coldOwner.projectActivity("project"), {
        snapshotSequence: 0,
        run: null,
        runtimeRequest: null,
        nativeBackground: null,
      });
      assert.deepEqual(yield* coldOwner.closeProjectExecution("project"), { closedBindings: 0 });
      assert.deepEqual(cold.calls, []);
    }),
);

it.effect(
  "retries an admitted launch after a Core Session move using current placement and one durable message",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const started = yield* owner.launch(launch);
      fixture.bindings.set(started.sessionId, {
        ...fixture.bindings.get(started.sessionId)!,
        project_id: "moved",
      });
      const appliedCount = fixture.applied.length;
      const commandCount = fixture.commands.size;
      const resumed = yield* owner.launch({
        ...launch,
        sourceRoot: "/old-source-no-longer-configured",
      });
      assert.equal(resumed.sessionId, started.sessionId);
      assert.equal(resumed.threadId, started.threadId);
      assert.equal(resumed.projectId, "moved");
      assert.equal(fixture.applied.length, appliedCount);
      assert.equal(fixture.commands.size, commandCount + 1);
      assert.equal(fixture.snapshots.get(started.threadId)?.projection.thread.projectId, "moved");
      assert.isFalse(
        fixture.calls.some(
          (call) => call.method === "thread.snapshot" || call.method === "thread.history",
        ),
      );
    }),
);

it.effect(
  "captures NFM intelligence and planning before binding and workspace creation and retries once",
  () =>
    Effect.gen(function* () {
      let workspaceCalls = 0;
      const fixture = setup({
        prepareWorkspace: () =>
          Effect.sync(() => {
            workspaceCalls++;
            assert.equal(
              fixture.calls.filter((call) => call.method === "providers.read").length,
              1,
            );
            // The product Session is admitted before any workspace work starts.
            assert.equal(fixture.applied.length, 1);
            return {
              location: { cwd: "/workspace", branch: null, worktreePath: null },
              retain: Effect.void,
              attach: () => Effect.void,
            } as never;
          }),
      });
      const owner = yield* fixture.owner;
      const input = {
        ...launch,
        modelSelection: { instanceId: "codex", model: "model-a" },
        message: {
          ...launch.message,
          agentConfigs: [
            { mode: "default", reasoning: "high" },
            { mode: "plan", provider: "openai", model: "model-b", reasoning: "low", speed: "fast" },
          ],
        },
      } satisfies AgentRuntimeLaunch;
      const result = yield* owner.launch(input);
      yield* owner.launch(input);
      assert.equal(workspaceCalls, 1);
      const created = [...fixture.commands.values()].find(
        (command) => command.type === "thread.create",
      )!;
      assert.equal(created.type, "thread.create");
      if (created.type !== "thread.create") return;
      assert.equal(created.interactionMode, "plan");
      assert.deepEqual(created.modelSelection, {
        instanceId: "codex",
        model: "model-b",
        options: [
          { id: "reasoningEffort", value: "low" },
          { id: "serviceTier", value: "fast" },
        ],
      });
      const submitted = [...fixture.commands.values()].filter(
        (command) => command.type === "message.dispatch",
      );
      assert.equal(submitted.length, 1);
      assert.equal(submitted[0]?.messageId, input.message.messageId);
      assert.deepEqual(submitted[0]?.modelSelection, created.modelSelection);
      assert.equal(submitted[0]?.interactionMode, "plan");
      assert.equal(result.sessionId, input.sessionId);
      assert.isFalse(
        fixture.calls.some(
          (call) => call.method === "thread.snapshot" || call.method === "thread.history",
        ),
      );
    }),
);

it.effect(
  "rejects invalid or non-Codex Agent config before creating workspace or execution metadata",
  () =>
    Effect.gen(function* () {
      for (const [selection, config] of [
        [{ instanceId: "claude", model: "claude-sonnet" }, { mode: "plan" }],
        [{ instanceId: "codex", model: "model-a" }, { provider: "anthropic" }],
        [{ instanceId: "codex", model: "model-a" }, { model: "missing" }],
        [{ instanceId: "codex", model: "model-a" }, { reasoning: "unknown" }],
        [{ instanceId: "codex", model: "model-a" }, { speed: "unknown" }],
        [{ instanceId: "codex", model: "model-a" }, { unknownAttributes: ["harness"] }],
      ] satisfies Array<
        [
          AgentRuntimeLaunch["modelSelection"],
          import("../../shared/types").CodexPromptAgentConfigInput,
        ]
      >) {
        let workspaces = 0;
        const fixture = setup({
          prepareWorkspace: () =>
            Effect.sync(() => {
              workspaces++;
              throw new Error("Unexpected workspace");
            }),
        });
        const owner = yield* fixture.owner;
        const rejected = yield* owner
          .launch({
            ...launch,
            modelSelection: selection,
            message: { ...launch.message, agentConfigs: [config] },
          })
          .pipe(Effect.result);
        assert.equal(rejected._tag, "Failure");
        assert.equal(workspaces, 0);
        assert.equal(fixture.commands.size, 0);
        assert.equal(fixture.bindings.size, 0);
      }
    }),
);

it.effect(
  "parses raw Markdown lines, respects structured input and queues overrides without steering",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const created = yield* owner.launch({
        ...launch,
        modelSelection: { instanceId: "codex", model: "model-a" },
      });
      yield* owner.message({
        sessionId: created.sessionId,
        intent: "steer",
        message: {
          messageId: "message:markdown",
          text: ':agent-config{mode="plan" reasoning="high" speed="standard"}\nNext task',
        },
      });
      const command = [...fixture.commands.values()].find(
        (value) => value.type === "message.dispatch" && value.messageId === "message:markdown",
      )!;
      if (command.type !== "message.dispatch") throw new Error("Expected message command");
      assert.equal(command.text, "Next task");
      assert.equal(command.interactionMode, "plan");
      assert.deepEqual(command.modelSelection?.options, [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "default" },
      ]);
      assert.equal(command.dispatchMode.type, "queue_after_active");
      assert.isUndefined(command.deliveryIntent);
      yield* owner.message({
        sessionId: created.sessionId,
        message: {
          messageId: "message:inherit",
          text: "Inherit current preferences",
          agentConfigs: [{}],
        },
      });
      const inherited = [...fixture.commands.values()].find(
        (value) => value.type === "message.dispatch" && value.messageId === "message:inherit",
      )!;
      if (inherited.type !== "message.dispatch") throw new Error("Expected inherited message");
      assert.equal(inherited.interactionMode, "default");
      assert.deepEqual(inherited.modelSelection?.options, [
        { id: "reasoningEffort", value: "medium" },
        { id: "serviceTier", value: "default" },
      ]);
      const catalogCount = fixture.calls.filter((call) => call.method === "providers.read").length;
      yield* owner.message({
        sessionId: created.sessionId,
        message: {
          messageId: "message:literal",
          text: ':agent-config{model="missing"}\n\nLiteral',
          agentConfigs: [],
        },
      });
      const literal = [...fixture.commands.values()].find(
        (value) => value.type === "message.dispatch" && value.messageId === "message:literal",
      )!;
      assert.equal(
        literal.type === "message.dispatch" && literal.text,
        ':agent-config{model="missing"}\n\nLiteral',
      );
      assert.equal(
        fixture.calls.filter((call) => call.method === "providers.read").length,
        catalogCount,
      );
      yield* owner.queue({
        sessionId: created.sessionId,
        requestId: "edit:markdown",
        action: "edit",
        runId: "queued",
        message: {
          messageId: "message:queued",
          text: "Edited task",
          agentConfigs: [{ model: "model-b", mode: "default" }],
        },
      });
      const edited = [...fixture.commands.values()].find(
        (value) => value.type === "queued-run.edit",
      )!;
      if (edited.type !== "queued-run.edit") throw new Error("Expected queued edit");
      assert.equal(edited.interactionMode, "default");
      assert.equal(edited.modelSelection?.model, "model-b");
      assert.equal(edited.text, "Edited task");
    }),
);

it.effect(
  "answers Session-origin questions with unknown Run and refuses stale or fabricated attribution without transcript reads",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const result = yield* owner.launch(launch);
      const current = fixture.snapshots.get(result.threadId)!;
      const request = {
        id: "question:session",
        nodeId: "question:node",
        kind: "user_input",
        providerTurnId: null,
        status: "pending",
        responseCapability: { type: "live", providerSessionId: "native-session" },
      };
      fixture.snapshots.set(result.threadId, {
        ...current,
        projection: {
          ...current.projection,
          runs: [
            { id: "completed-a", status: "completed" },
            { id: "foreground-b", status: "running" },
          ] as never,
          nodes: [
            { id: "question:node", threadId: result.threadId, runId: null, providerTurnId: null },
          ] as never,
          runtimeRequests: [request] as never,
        },
      });
      const before = fixture.calls.length;
      const source = {
        sessionId: result.sessionId,
        requestId: request.id,
        runId: null,
        answers: { question: ["Yes"] },
      };
      assert.equal(
        (yield* owner.respond({ ...source, runId: "foreground-b" }).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* owner.respond(source);
      const responses = [...fixture.commands.values()].filter(
        (command) => command.type === "runtime-request.respond",
      );
      assert.equal(responses.length, 1);
      assert.equal(responses[0]?.requestId, request.id);
      assert.deepEqual(responses[0]?.answers, source.answers);
      assert.isFalse(
        fixture.calls
          .slice(before)
          .some((call) => call.method === "thread.snapshot" || call.method === "thread.history"),
      );
      const pending = fixture.snapshots.get(result.threadId)!;
      fixture.snapshots.set(result.threadId, {
        ...pending,
        projection: {
          ...pending.projection,
          runtimeRequests: [
            {
              ...request,
              status: "expired",
              responseCapability: { type: "not_resumable", reason: "Native connection closed" },
            },
          ] as never,
        },
      });
      assert.equal((yield* owner.respond(source).pipe(Effect.result))._tag, "Failure");
      assert.equal(
        [...fixture.commands.values()].filter(
          (command) => command.type === "runtime-request.respond",
        ).length,
        1,
      );
    }),
);

it.effect(
  "a person's message that starts a Run carries interactive state the Agent has not seen",
  () =>
    Effect.gen(function* () {
      const parts = [{ path: "/responses/chart.html", state: { selected: 2 } }];
      let unsent: { key: string; parts: readonly unknown[] } | undefined = {
        key: "state:1",
        parts,
      };
      const marked: string[] = [];
      const fixture = setup({
        interactiveState: {
          unsent: () => Effect.succeed(unsent),
          sent: (_threadId, key) =>
            Effect.sync(() => {
              marked.push(key);
              unsent = undefined;
            }),
        },
      });
      const owner = yield* fixture.owner;
      const launched = yield* owner.launch(launch);
      const settle = () => {
        const current = fixture.snapshots.get(launched.threadId)!;
        fixture.snapshots.set(launched.threadId, {
          ...current,
          projection: {
            ...current.projection,
            runs: current.projection.runs.map((run) => ({ ...run, status: "completed" }) as never),
          },
        });
      };
      const dispatched = (messageId: string) =>
        [...fixture.commands.values()].find(
          (command) => command.type === "message.dispatch" && command.messageId === messageId,
        ) as Extract<AgentCommand, { type: "message.dispatch" }>;
      settle();
      yield* owner.message({
        sessionId: launch.sessionId,
        message: { messageId: "message:state", text: "Use the selection" },
      });
      const carried = dispatched("message:state");
      assert.match(
        carried.text,
        /^Use the selection\n\n\[Interactive response state\]\(t3-context:\/\/v1\/nodex-app-context\/\w+\)$/u,
      );
      assert.deepEqual(
        (carried.context?.records[0] as { payload: { items: unknown } } | undefined)?.payload.items,
        parts,
      );
      assert.deepEqual(marked, ["state:1"]);

      // Unchanged state is not offered again.
      settle();
      yield* owner.message({
        sessionId: launch.sessionId,
        message: { messageId: "message:plain", text: "Thanks" },
      });
      assert.equal(dispatched("message:plain").text, "Thanks");

      // A steer leaves new state for a later message that starts a Run.
      unsent = { key: "state:2", parts };
      settle();
      yield* owner.message({
        sessionId: launch.sessionId,
        message: { messageId: "message:steer", text: "Also this" },
        intent: "steer",
      });
      assert.equal(dispatched("message:steer").text, "Also this");
      assert.deepEqual(marked, ["state:1"]);
    }),
);

const importPreparationRefusal = () =>
  new AgentRuntimeApplicationError({
    operation: "import",
    message: "Choose an existing working directory for the imported chat.",
    admissionRejected: true,
  });
const preparedImport = Effect.succeed({ title: codexImport.title, model: codexImport.model });

it.effect(
  "proves a validation refusal before admission, then accepts corrected parameters as a new request",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const first = yield* owner.submitNativeImport(
        codexImport,
        Effect.fail(importPreparationRefusal()),
      );
      assert.deepEqual(first, {
        kind: "not_admitted",
        message: importPreparationRefusal().message,
      });
      assert.equal(fixture.bindings.size, 0);
      assert.equal(fixture.imports.size, 0);
      const corrected = {
        ...codexImport,
        requestId: "019d0000-0000-7000-8000-000000000003",
        cwd: "/corrected/workspace",
      };
      const result = yield* owner.submitNativeImport(corrected, preparedImport);
      assert.equal(result.kind, "imported");
      assert.equal([...fixture.imports.values()][0]?.cwd, corrected.cwd);
      assert.equal(fixture.bindings.size, 1);
    }),
);

it.effect("source/model/Project validation is definitive only before the binding attempt", () =>
  Effect.gen(function* () {
    for (const change of [
      (fixture: ReturnType<typeof setup>) => {
        fixture.state.nativeImportSourceHome = "/different-history";
      },
      (fixture: ReturnType<typeof setup>) => {
        fixture.state.codexModelsAvailable = false;
      },
      (fixture: ReturnType<typeof setup>) => {
        fixture.state.lifecycle = "archived";
      },
    ]) {
      const fixture = setup();
      change(fixture);
      const owner = yield* fixture.owner;
      assert.equal(
        (yield* owner.submitNativeImport(codexImport, preparedImport)).kind,
        "not_admitted",
      );
      assert.equal(fixture.bindings.size, 0);
    }
    const fixture = setup();
    const owner = yield* fixture.owner;
    assert.equal(
      (yield* owner
        .submitNativeImport(codexImport, Effect.fail(new Error("Source transport disconnected")))
        .pipe(Effect.result))._tag,
      "Failure",
    );
    fixture.state.failCore = true;
    assert.equal(
      (yield* owner.submitNativeImport(codexImport, preparedImport).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.equal(fixture.bindings.size, 0);
  }),
);

it.effect(
  "partial or complete admission never returns not_admitted, even when later validation fails",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      fixture.state.failCodexImportBeforeCommit = true;
      assert.equal(
        (yield* owner.submitNativeImport(codexImport, preparedImport).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(fixture.bindings.size, 1);
      assert.equal(
        (yield* owner
          .submitNativeImport(codexImport, Effect.fail(importPreparationRefusal()))
          .pipe(Effect.result))._tag,
        "Failure",
      );
      fixture.state.failCodexImportBeforeCommit = false;
      const completed = yield* owner.submitNativeImport(codexImport, preparedImport);
      assert.equal(completed.kind, "imported");
      assert.deepEqual(
        yield* owner.submitNativeImport(codexImport, Effect.fail(importPreparationRefusal())),
        completed,
      );
      assert.equal(
        (yield* owner
          .submitNativeImport({ ...codexImport, cwd: "/changed" }, preparedImport)
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(fixture.imports.size, 1);
    }),
);

it.effect(
  "serializes the no-binding rejection proof with a concurrent attempt of the same request",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = setup();
        const owner = yield* fixture.owner;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let secondPrepared = false;
        const first = yield* owner
          .submitNativeImport(
            codexImport,
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return yield* importPreparationRefusal();
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const second = yield* owner
          .submitNativeImport(
            codexImport,
            Effect.sync(() => {
              secondPrepared = true;
              return { title: codexImport.title, model: codexImport.model };
            }),
          )
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.equal(secondPrepared, false);
        assert.equal(fixture.bindings.size, 0);
        yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.join(first)).kind, "not_admitted");
        assert.equal((yield* Fiber.join(second)).kind, "imported");
        assert.equal(fixture.bindings.size, 1);
        assert.equal(fixture.imports.size, 1);
      }),
    ),
);

it.effect(
  "preserves only known rejected search cursor failures as actionable application errors",
  () =>
    Effect.gen(function* () {
      for (const test of [
        {
          reason: "rejected",
          tag: "SessionSearchError",
          engineReason: "cursor_stale",
          expected: "cursor_stale",
        },
        {
          reason: "rejected",
          tag: "SessionSearchError",
          engineReason: "invalid_cursor",
          expected: "invalid_cursor",
        },
        {
          reason: "request",
          tag: "SessionSearchError",
          engineReason: "cursor_stale",
          expected: undefined,
        },
        {
          reason: "rejected",
          tag: "OtherError",
          engineReason: "cursor_stale",
          expected: undefined,
        },
      ] as const) {
        const error = new AgentRuntimeProcessError({
          reason: test.reason,
          message: "Remote failure",
          engineTag: test.tag,
          engineReason: test.engineReason,
        });
        const fixture = setup({
          connect: Effect.succeed({
            identity: {
              runtimeId: "runtime",
              runtimeGeneration: "generation",
              schemaVersion: 1,
              databasePath: "/db",
              mcpEndpoint: "http://127.0.0.1",
              lastSequence: 0,
            },
            request: () => Effect.fail(error),
          } as AgentRuntimeApplicationConnection),
        });
        const owner = yield* fixture.owner;
        const requests: readonly Effect.Effect<unknown, AgentRuntimeApplicationError>[] = [
          owner.sessionSearch({ query: "alpha", cursor: "pending" }),
          owner.sessionSearchResolve({ query: "alpha", references: [] }),
        ];
        for (const request of requests) {
          const result = yield* request.pipe(Effect.flip);
          assert.equal(result.cursorReason, test.expected);
        }
      }
    }),
);

it.effect(
  "routes resource-only sends to a verified child and returns the canonical delivery result",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const launched = yield* owner.launch(launch);
      const root = fixture.snapshots.get(launched.threadId)!;
      fixture.snapshots.set("child", {
        ...root,
        projection: {
          ...root.projection,
          thread: {
            ...root.projection.thread,
            id: "child",
            lineage: {
              ...root.projection.thread.lineage,
              rootThreadId: launched.threadId,
              parentThreadId: launched.threadId,
              relationshipToParent: "subagent",
            },
          },
        },
      });
      const resources = [
        {
          name: "report.txt",
          mimeType: "text/plain",
          sizeBytes: 6,
          source: "/authorized/export/report.txt",
        },
      ];
      const before = fixture.calls.length;
      const delivered = yield* owner.sendMessage({
        sessionId: launched.sessionId,
        threadId: "child",
        mode: "queue",
        resources,
        message: { messageId: "message:resource", text: "" },
        senderThreadId: launched.threadId,
      });
      assert.equal(delivered.threadId, "child");
      assert.equal(delivered.delivery, "queued");
      assert.equal(delivered.runId, "run:canonical-delivery");
      const calls = fixture.calls.slice(before);
      const imported = calls.find((call) => call.method === "attachments.import")!;
      assert.equal((imported.input as { threadId: string }).threadId, "child");
      const sent = calls.find((call) => call.method === "thread.send")!;
      assert.deepEqual((sent.input as { attachments: unknown }).attachments, [
        {
          type: "file",
          id: "imported_0",
          name: "report.txt",
          mimeType: "text/plain",
          sizeBytes: 6,
        },
      ]);
      assert.isFalse(calls.some((call) => call.method === "command.dispatch"));
      fixture.snapshots.set("foreign", snapshot("foreign", "foreign-root"));
      const invalidBefore = fixture.calls.length;
      assert.equal(
        (yield* owner
          .sendMessage({
            sessionId: launched.sessionId,
            threadId: "foreign",
            mode: "queue",
            resources,
            message: { messageId: "message:forged", text: "" },
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.isFalse(
        fixture.calls
          .slice(invalidBefore)
          .some((call) => call.method === "attachments.import" || call.method === "thread.send"),
      );
    }),
);

it.effect(
  "recovers accepted message delivery before reimporting resources or checking changed Plan/model settings",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const launched = yield* owner.launch(launch);
      fixture.state.messageReplay = {
        messageId: "message:accepted",
        runId: "run:accepted",
        status: "completed",
        delivery: "queued",
      };
      const before = fixture.calls.length;
      const result = yield* owner.sendMessage({
        sessionId: launched.sessionId,
        mode: "queue",
        messageFingerprint: "a".repeat(64),
        interactionModeCeiling: "plan",
        resources: [
          { name: "gone.png", mimeType: "image/png", sizeBytes: 10, source: "/removed/source.png" },
        ],
        message: {
          messageId: "message:accepted",
          text: "",
          modelSelection: { instanceId: "removed-provider", model: "removed-model" },
        },
      });
      assert.equal(result.runId, "run:accepted");
      assert.equal(result.delivery, "queued");
      const calls = fixture.calls.slice(before);
      assert.isTrue(calls.some((call) => call.method === "thread.message-replay"));
      assert.isFalse(
        calls.some((call) =>
          ["attachments.import", "providers.read", "thread.send", "command.dispatch"].includes(
            call.method,
          ),
        ),
      );
      fixture.state.denyAgent = true;
      const revokedBefore = fixture.calls.length;
      const revoked = yield* owner
        .replayMessage({
          sessionId: launched.sessionId,
          messageId: "message:accepted",
          fingerprint: "a".repeat(64),
        })
        .pipe(Effect.provideService(CoreApplicationAgent, agent), Effect.result);
      assert.equal(revoked._tag, "Failure");
      assert.isFalse(
        fixture.calls.slice(revokedBefore).some((call) => call.method === "thread.message-replay"),
      );
    }),
);

it.effect(
  "a recovered draft launch keeps its first-message receipt ahead of mutable preparation",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      const input = { ...launch, messageFingerprint: "a".repeat(64) };
      const launched = yield* owner.launch(input);
      fixture.state.messageReplay = {
        messageId: launch.message.messageId,
        runId: "run:accepted",
        status: "running",
        delivery: "started",
      };
      const before = fixture.calls.length;
      const retry = yield* owner.launch({
        ...input,
        interactionModeCeiling: "plan",
        interactionMode: "default",
        resources: [
          { name: "gone.png", mimeType: "image/png", sizeBytes: 10, source: "/removed/source.png" },
        ],
      });
      assert.deepEqual(retry, launched);
      assert.isFalse(
        fixture.calls
          .slice(before)
          .some((call) =>
            ["attachments.import", "providers.read", "command.dispatch"].includes(call.method),
          ),
      );
    }),
);

it.effect(
  "resumes an interrupted Plan draft from its retained model and owned resources without default hydration",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      fixture.state.failThreadCreate = true;
      const input = {
        ...launch,
        messageFingerprint: "a".repeat(64),
        interactionMode: "plan" as const,
        interactionModeCeiling: "plan" as const,
        modelSelection: { instanceId: "codex", model: "model-b" },
        resources: [
          {
            name: "draft.txt",
            mimeType: "text/plain",
            sizeBytes: 7,
            source: "/authorized/draft.txt",
          },
        ],
        message: { messageId: "message:draft-interrupted", text: "" },
      };
      assert.equal((yield* owner.launch(input).pipe(Effect.result))._tag, "Failure");
      const binding = fixture.bindings.get(launch.sessionId)!;
      assert.isFalse(fixture.snapshots.has(binding.runtime_thread_id));
      const before = fixture.calls.length;
      assert.isNull(
        yield* owner.replayMessage({
          sessionId: input.sessionId,
          messageId: input.message.messageId,
          fingerprint: input.messageFingerprint,
        }),
      );
      assert.isFalse(
        fixture.snapshots.has(binding.runtime_thread_id),
        "A receipt query never manufactures defaults",
      );
      assert.equal(
        (yield* owner
          .resumeMessageLaunch({
            sessionId: input.sessionId,
            launchId: input.launchId,
            messageId: input.message.messageId,
            fingerprint: input.messageFingerprint,
            modeLimit: { runtimeMode: "auto", interactionMode: "plan" },
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.isFalse(
        fixture.snapshots.has(binding.runtime_thread_id),
        "Fresh recovery still obeys the current caller ceiling",
      );
      fixture.state.codexModelsAvailable = false;
      const resumed = yield* owner.resumeMessageLaunch({
        sessionId: input.sessionId,
        launchId: input.launchId,
        messageId: input.message.messageId,
        fingerprint: input.messageFingerprint,
        modeLimit: { runtimeMode: "full-access", interactionMode: "plan" },
      });
      assert.equal(resumed?.delivery, "started");
      const created = fixture.snapshots.get(binding.runtime_thread_id)!.projection.thread;
      assert.equal(created.interactionMode, "plan");
      assert.deepEqual(created.modelSelection, input.modelSelection);
      const calls = fixture.calls.slice(before);
      assert.isFalse(
        calls.some((call) =>
          ["providers.read", "attachments.import", "thread.message-stage"].includes(call.method),
        ),
      );
      assert.equal(
        [...fixture.commands.values()].filter((command) => command.type === "message.dispatch")
          .length,
        1,
      );
      const sent = [...fixture.commands.values()].find(
        (command) => command.type === "message.dispatch",
      )!;
      assert.equal(
        sent.type === "message.dispatch" ? sent.attachments[0]?.name : null,
        "draft.txt",
      );
    }),
);

it.effect(
  "stages prompt image sources through their canonical materializer before first-message delivery",
  () =>
    Effect.gen(function* () {
      const sources: string[][] = [];
      const fixture = setup({
        prepareImages: (images) =>
          Effect.sync(() => {
            sources.push(images.map((image) => image.source));
            return [{ mediaType: "image/png", data: "aW1hZ2U=" }];
          }),
      });
      const owner = yield* fixture.owner;
      yield* owner.launch({
        ...launch,
        messageFingerprint: "a".repeat(64),
        modelSelection: { instanceId: "codex", model: "model-a" },
        message: {
          messageId: "message:staged-image",
          text: "",
          images: [{ source: "nodex-asset:private", caption: "Evidence" }],
        },
      });
      assert.deepEqual(sources, [["nodex-asset:private"]]);
      const stage = fixture.calls.find((call) => call.method === "thread.message-stage")!
        .input as AgentRuntimeOperations["thread.message-stage"]["input"];
      assert.deepEqual(
        stage.resources.map(({ source: _source, ...metadata }) => metadata),
        [{ name: "Evidence", mimeType: "image/png", sizeBytes: 5 }],
      );
      assert.isFalse(stage.resources[0]!.source.startsWith("data:"));
      assert.isFalse(
        yield* Effect.promise(() =>
          access(stage.resources[0]!.source).then(
            () => true,
            () => false,
          ),
        ),
      );
      const sent = [...fixture.commands.values()].find(
        (command) => command.type === "message.dispatch",
      )!;
      assert.equal(sent.type === "message.dispatch" ? sent.attachments[0]?.name : null, "Evidence");
      assert.isFalse(fixture.calls.some((call) => call.method === "attachments.persist"));
    }),
);

it.effect("promotes a resource-only draft through one launch and one first-message dispatch", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    yield* owner.launch({
      ...launch,
      resources: [
        {
          name: "draft.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          source: "/authorized/draft.txt",
        },
      ],
      message: { messageId: "message:draft-resource", text: "" },
    });
    const imports = fixture.calls.filter((call) => call.method === "attachments.import");
    assert.equal(imports.length, 1);
    const messages = [...fixture.commands.values()].filter(
      (command) => command.type === "message.dispatch",
    );
    assert.equal(messages.length, 1);
    const message = messages[0] as Extract<AgentCommand, { type: "message.dispatch" }>;
    assert.equal(message.messageId, "message:draft-resource");
    assert.equal(message.attachments[0]?.name, "draft.txt");
  }),
);

const largeImageResources = () =>
  [0x51, 0xb4].map((value, index) => {
    const bytes = Buffer.alloc(9 * 1024 * 1024, value);
    return {
      name: `Image ${index + 1}.png`,
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      source: `data:image/png;base64,${bytes.toString("base64")}`,
    };
  });
const resourceDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it.effect("sends legal multi-image resources above one frame through scoped file references", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const owned = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-owned-images-test-" });
    const sources: string[] = [];
    const copies: string[] = [];
    const resources = largeImageResources();
    assert.isAbove(Buffer.byteLength(JSON.stringify(resources)), 16 * 1024 * 1024);
    const fixture = setup({}, [], (request) =>
      Effect.gen(function* () {
        assert.isBelow(Buffer.byteLength(JSON.stringify(request)), 16 * 1024 * 1024);
        const attachments = [];
        for (const [index, resource] of request.attachments.entries()) {
          assert.isFalse(resource.source.startsWith("data:"));
          const bytes = yield* fs.readFile(resource.source);
          assert.equal(
            resourceDigest(bytes),
            resourceDigest(Buffer.from(resources[index]!.source.split(",")[1]!, "base64")),
          );
          sources.push(resource.source);
          const copy = join(owned, String(index));
          yield* fs.copyFile(resource.source, copy);
          copies.push(copy);
          attachments.push({
            type: "image" as const,
            id: `owned_${index}`,
            name: resource.name,
            mimeType: resource.mimeType,
            sizeBytes: bytes.byteLength,
          });
        }
        return { attachments };
      }),
    );
    const owner = yield* fixture.owner;
    yield* owner.launch({
      ...launch,
      modelSelection: { instanceId: "codex", model: "model-a" },
    });
    const sent = yield* owner.sendMessage({
      sessionId: launch.sessionId,
      message: { messageId: "message:large-images", text: "Read both images" },
      mode: "auto",
      resources,
    });
    assert.equal(sent.delivery, "queued");
    assert.lengthOf(sources, 2);
    for (const source of sources) assert.isFalse(yield* fs.exists(source));
    for (const copy of copies) assert.equal(Number((yield* fs.stat(copy)).size), 9 * 1024 * 1024);
    for (const call of fixture.calls)
      assert.isBelow(Buffer.byteLength(JSON.stringify(call)), 16 * 1024 * 1024);
    const request = fixture.calls.find((call) => call.method === "thread.send")!
      .input as AgentRuntimeOperations["thread.send"]["input"];
    assert.deepEqual(
      request.attachments.map((attachment) => attachment.id),
      ["owned_0", "owned_1"],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retains independent draft images after temporary source cleanup and interrupted launch",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const owned = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-owned-draft-test-" });
      const sources: string[] = [];
      const digests: string[] = [];
      let imports = 0;
      const fixture = setup({}, [], (request) =>
        Effect.gen(function* () {
          imports += 1;
          assert.isBelow(Buffer.byteLength(JSON.stringify(request)), 16 * 1024 * 1024);
          const attachments = [];
          for (const [index, resource] of request.attachments.entries()) {
            const bytes = yield* fs.readFile(resource.source);
            sources.push(resource.source);
            digests.push(resourceDigest(bytes));
            yield* fs.copyFile(resource.source, join(owned, String(index)));
            attachments.push({
              type: "image" as const,
              id: `owned_draft_${index}`,
              name: resource.name,
              mimeType: resource.mimeType,
              sizeBytes: bytes.byteLength,
            });
          }
          return { attachments };
        }),
      );
      const owner = yield* fixture.owner;
      fixture.state.failThreadCreate = true;
      const resources = largeImageResources();
      const input = {
        ...launch,
        modelSelection: { instanceId: "codex", model: "model-a" },
        messageFingerprint: "b".repeat(64),
        resources,
      };
      assert.equal((yield* owner.launch(input).pipe(Effect.result))._tag, "Failure");
      assert.lengthOf(sources, 2);
      for (const source of sources) assert.isFalse(yield* fs.exists(source));
      const resumed = yield* owner.resumeMessageLaunch({
        sessionId: launch.sessionId,
        launchId: launch.launchId,
        messageId: launch.message.messageId,
        fingerprint: input.messageFingerprint,
        modeLimit: { runtimeMode: "full-access", interactionMode: "default" },
      });
      assert.equal(resumed?.delivery, "started");
      assert.equal(imports, 1);
      for (const [index, digest] of digests.entries())
        assert.equal(resourceDigest(yield* fs.readFile(join(owned, String(index)))), digest);
      for (const call of fixture.calls)
        assert.isBelow(Buffer.byteLength(JSON.stringify(call)), 16 * 1024 * 1024);
      const sent = [...fixture.commands.values()].find(
        (command) => command.type === "message.dispatch",
      );
      assert.equal(sent?.type, "message.dispatch");
      if (sent?.type !== "message.dispatch") throw new Error("Expected recovered dispatch");
      assert.deepEqual(
        sent.attachments.map((attachment) => attachment.id),
        ["owned_draft_0", "owned_draft_1"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "releases inline source files on failed and interrupted sends before the owner closes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const interrupted of [false, true]) {
        const captured = yield* Deferred.make<readonly string[]>();
        const fixture = setup({}, [], (request) =>
          Effect.gen(function* () {
            const sources = request.attachments.map((resource) => resource.source);
            for (const source of sources) assert.isTrue(yield* fs.exists(source));
            yield* Deferred.succeed(captured, sources);
            return yield* interrupted
              ? Effect.never
              : Effect.fail(new Error("Runtime import failed"));
          }),
        );
        const owner = yield* fixture.owner;
        yield* owner.launch({
          ...launch,
          modelSelection: { instanceId: "codex", model: "model-a" },
        });
        const send = owner.sendMessage({
          sessionId: launch.sessionId,
          message: { messageId: `message:cleanup-${interrupted}`, text: "Read it" },
          mode: "auto",
          resources: [
            {
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 3,
              source: "data:image/png;base64,AQID",
            },
          ],
        });
        if (interrupted) {
          const fiber = yield* Effect.forkChild(send);
          yield* Deferred.await(captured);
          yield* Fiber.interrupt(fiber);
        } else assert.equal((yield* send.pipe(Effect.result))._tag, "Failure");
        for (const source of yield* Deferred.await(captured))
          assert.isFalse(yield* fs.exists(source));
        assert.isFalse(fixture.calls.some((call) => call.method === "thread.send"));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses changed, malformed and oversized inline images before sending resource references",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      yield* owner.launch({ ...launch, modelSelection: { instanceId: "codex", model: "model-a" } });
      const before = fixture.calls.length;
      for (const resource of [
        { sizeBytes: 2, source: "data:image/png;base64,AQID" },
        { sizeBytes: 3, source: "data:image/png;base64,A===" },
        { sizeBytes: 3, source: "data:image/jpeg;base64,AQID" },
        { sizeBytes: 11 * 1024 * 1024, source: "data:image/png;base64,AQID" },
      ])
        assert.equal(
          (yield* owner
            .sendMessage({
              sessionId: launch.sessionId,
              message: { messageId: "message:invalid-image", text: "Read it" },
              mode: "auto",
              resources: [{ name: "image.png", mimeType: "image/png", ...resource }],
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
      assert.isFalse(
        fixture.calls
          .slice(before)
          .some((call) => call.method === "attachments.import" || call.method === "thread.send"),
      );
    }),
);

it.effect(
  "adopts one settled Native Session after import, preserving Plan and recovering an uncertain Core reply",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      fixture.state.nativeSession = {
        id: "session:native",
        projectId: "project",
        displayTitle: "Native work",
        archived: false,
        thread: {
          threadId: codexImport.nativeSessionId,
          executionHostId: "local",
          backendBinding: { kind: "codex" },
          cwd: "/native/work",
          statusType: "idle",
        },
      } as ProjectSession;
      const owner = yield* fixture.owner;
      const request = {
        sessionId: "session:native",
        requestId: "adopt:one",
        acceptedAt: launch.acceptedAt,
        expectedNativeThreadId: codexImport.nativeSessionId,
        expectedNativeHostId: "local",
        interactionMode: "plan" as const,
        model: "model-b",
      };
      fixture.state.failCodexImportBeforeCommit = true;
      assert.equal((yield* owner.adoptNativeSession(request).pipe(Effect.result))._tag, "Failure");
      assert.equal(fixture.bindings.size, 0, "Failed source capture keeps Native ownership");
      fixture.state.failCoreAcknowledgment = true;
      const adopted = yield* owner.adoptNativeSession(request);
      assert.equal(adopted.sessionId, "session:native");
      assert.equal(fixture.bindings.size, 1);
      assert.equal(
        fixture.snapshots.get(adopted.threadId)!.projection.thread.interactionMode,
        "plan",
      );
      const bindingIndex = fixture.order.indexOf("core.bind");
      assert.isAbove(bindingIndex, fixture.order.indexOf("runtime.thread.import-native"));
      const readsBefore = fixture.order.filter(
        (entry) => entry === "codex.import-source-home",
      ).length;
      fixture.state.nativeSession = null;
      fixture.state.nativeImportSourceHome = "/removed/source";
      const retry = yield* owner.adoptNativeSession(request);
      assert.deepEqual(retry, adopted);
      assert.equal(
        fixture.order.filter((entry) => entry === "codex.import-source-home").length,
        readsBefore,
      );
      assert.equal(
        fixture.applied.filter((entry) => entry.intent.kind === "adopt_native_session_execution")
          .length,
        1,
      );
    }),
);

it.effect("refuses an active Native adoption without changing its binding", () =>
  Effect.gen(function* () {
    const fixture = setup();
    fixture.state.nativeSession = {
      id: "session:native",
      projectId: "project",
      displayTitle: "Busy",
      archived: false,
      thread: {
        threadId: codexImport.nativeSessionId,
        executionHostId: "local",
        backendBinding: { kind: "codex" },
        cwd: "/native/work",
        statusType: "active",
      },
    } as ProjectSession;
    const owner = yield* fixture.owner;
    const result = yield* owner
      .adoptNativeSession({
        sessionId: "session:native",
        requestId: "adopt:busy",
        acceptedAt: launch.acceptedAt,
        expectedNativeThreadId: codexImport.nativeSessionId,
        expectedNativeHostId: "local",
        interactionMode: "default",
      })
      .pipe(Effect.flip);
    assert.equal(result.adoptionReason, "active_source_busy");
    assert.equal(fixture.bindings.size, 0);
    assert.equal(fixture.imports.size, 0);
  }),
);

it.effect("a Plan caller cannot use message config to widen the final send or launch mode", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    const message = {
      messageId: "message:ceiling",
      text: "Do it",
      agentConfigs: [{ mode: "default" }],
    };
    const launchResult = yield* owner
      .launch({
        ...launch,
        interactionMode: "plan",
        interactionModeCeiling: "plan",
        modelSelection: { instanceId: "codex", model: "model-a" },
        message,
      })
      .pipe(Effect.flip);
    assert.equal(launchResult.message, "interaction_mode_escalation_denied");
    assert.equal(fixture.bindings.size, 0, "A widened draft is rejected before binding");
    const started = yield* owner.launch({
      ...launch,
      interactionMode: "plan",
      modelSelection: { instanceId: "codex", model: "model-a" },
      interactionModeCeiling: "plan",
    });
    const first = fixture.calls.find(
      (call) =>
        call.method === "command.dispatch" &&
        (call.input as AgentRuntimeOperations["command.dispatch"]["input"]).command.type ===
          "message.dispatch",
    );
    assert.deepEqual(
      (first!.input as AgentRuntimeOperations["command.dispatch"]["input"]).modeLimit,
      { runtimeMode: "full-access", interactionMode: "plan" },
    );
    const before = fixture.calls.length;
    const sendResult = yield* owner
      .sendMessage({
        sessionId: started.sessionId,
        mode: "auto",
        interactionModeCeiling: "plan",
        message,
      })
      .pipe(Effect.flip);
    assert.equal(sendResult.message, "interaction_mode_escalation_denied");
    assert.isFalse(fixture.calls.slice(before).some((call) => call.method === "thread.send"));
    yield* owner.sendMessage({
      sessionId: started.sessionId,
      mode: "auto",
      interactionModeCeiling: "plan",
      message: { messageId: "message:allowed-plan", text: "Continue planning" },
    });
    const sent = fixture.calls.find((call) => call.method === "thread.send")!;
    assert.deepEqual((sent.input as AgentRuntimeOperations["thread.send"]["input"]).modeLimit, {
      runtimeMode: "full-access",
      interactionMode: "plan",
    });
  }),
);

it.effect("does not read same-named metadata from a different execution store", () =>
  Effect.gen(function* () {
    const fixture = setup();
    const owner = yield* fixture.owner;
    const failure = yield* owner
      .sessionMetadata({ runtimeId: "retired-runtime", threadIds: ["same-thread"] })
      .pipe(Effect.flip);
    assert.equal(failure.operation, "session-metadata");
    assert.match(failure.message, /bound execution store/);
    assert.isFalse(fixture.calls.some((call) => call.method === "sessions.metadata"));
  }),
);

it.effect(
  "authorizes original Native receipt reads independently from a later execution binding",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const owner = yield* fixture.owner;
      fixture.state.nativeReceipt = {
        admitted: false,
        sessionId: "session:native",
        hostId: "original-host",
        threadId: "native-thread",
        phase: "confirmed",
        attemptId: "attempt",
        result: {
          messageId: "accepted-message",
          runId: "accepted-turn",
          status: "completed",
          delivery: "started",
        },
      };
      const input = {
        sessionId: "session:native",
        messageId: "accepted-message",
        fingerprint: "a".repeat(64),
      };
      assert.equal((yield* owner.nativeMessageReceipt(input))?.hostId, "original-host");
      const beforeReserve = fixture.calls.length;
      const refused = yield* owner
        .nativeMessageReserve({
          ...input,
          hostId: "original-host",
          threadId: "native-thread",
          attemptId: "new-attempt",
          expiresAt: Date.now() + 60000,
        })
        .pipe(Effect.result);
      assert.equal(refused._tag, "Failure");
      assert.isFalse(
        fixture.calls.slice(beforeReserve).some((call) => call.method === "native-message.reserve"),
      );
      fixture.state.denyAgent = true;
      const beforeRead = fixture.calls.length;
      const revoked = yield* owner
        .nativeMessageReceipt(input)
        .pipe(Effect.provideService(CoreApplicationAgent, agent), Effect.result);
      assert.equal(revoked._tag, "Failure");
      assert.isFalse(
        fixture.calls.slice(beforeRead).some((call) => call.method === "native-message.receipt"),
      );
    }),
);

it.effect(
  "side chats create an idle independent binding, replay without recapturing and discard only their own execution",
  () =>
    Effect.gen(function* () {
      const f = setup();
      const owner = yield* f.owner;
      const source = yield* owner.launch(launch);
      const sourceBefore = structuredClone(f.snapshots.get(source.threadId));
      const input = {
        source: { sessionId: source.sessionId },
        sessionId: "side",
        requestId: "side:one",
        acceptedAt: launch.acceptedAt,
      };
      const side = yield* owner.createSideChat(input);
      assert.equal(f.bindings.get(side.sessionId)?.side_chat_source_session_id, source.sessionId);
      const fork = [...f.commands.values()].find((c) => c.type === "thread.fork");
      assert.isTrue(fork?.type === "thread.fork" && fork.sideChat);
      assert.lengthOf(f.snapshots.get(side.threadId)!.projection.runs, 0);
      assert.deepEqual(f.snapshots.get(source.threadId), sourceBefore);
      const before = f.calls.length;
      assert.deepEqual(yield* owner.createSideChat(input), side);
      assert.isFalse(f.calls.slice(before).some((c) => c.method === "thread.fork-source"));
      assert.equal([...f.commands.values()].filter((c) => c.type === "thread.fork").length, 1);
      yield* owner.createSideChat({ ...input, requestId: "changed" }).pipe(Effect.flip);
      yield* owner
        .discardSideChat({ sessionId: source.sessionId, requestId: "not-side" })
        .pipe(Effect.flip);
      assert.deepEqual(
        yield* owner.discardSideChat({ sessionId: side.sessionId, requestId: "discard" }),
        { discarded: true },
      );
      assert.deepEqual(
        yield* owner.discardSideChat({ sessionId: side.sessionId, requestId: "discard" }),
        { discarded: false },
      );
      assert.isTrue(f.bindings.has(source.sessionId));
      assert.isNotNull(f.snapshots.get(side.threadId)!.projection.thread.deletedAt);
      assert.deepEqual(f.snapshots.get(source.threadId), sourceBefore);
    }),
);

const sideChatTitleFixture = Effect.fnUntraced(function* (instanceId = "claude") {
  const fixture = setup();
  fixture.state.admitMessageRuns = true;
  const owner = yield* fixture.owner;
  const source = yield* owner.launch({
    ...launch,
    modelSelection: { instanceId, model: "model-a" },
  });
  const side = yield* owner.createSideChat({
    source: { sessionId: source.sessionId },
    sessionId: "side:title",
    requestId: "side:title:create",
    acceptedAt: launch.acceptedAt,
  });
  return { fixture, owner, source, side };
});

const acquireTitleCoreScenario = Effect.acquireRelease(
  Effect.callback<
    { scenario: CoreScenarioContext; release: () => void; completed: Promise<void> },
    unknown
  >((resume) => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completed = withCoreScenario(
      { scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID },
      async (scenario) => {
        resume(Effect.succeed({ scenario, release, completed }));
        await released;
      },
    );
    void completed.catch((cause) => resume(Effect.fail(cause)));
  }),
  ({ release, completed }) =>
    Effect.promise(() => {
      release();
      return completed;
    }),
);

it.effect(
  "persists the first side title through the real Core boundary and retains it when saved",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario } = yield* acquireTitleCoreScenario;
        const access = CoreSessionAccess.of({
          handshake: Effect.die("unused handshake"),
          use: (operation, run, options) =>
            Effect.tryPromise({
              try: (signal) =>
                run(
                  options?.projectId
                    ? scenario.client.forProject(options.projectId)
                    : scenario.client,
                  signal,
                ),
              catch: (cause) => classifyCoreOperationFailure(operation, cause),
            }),
        });
        const modules = yield* Layer.build(
          coreModulesLive.pipe(Layer.provide(Layer.succeed(CoreSessionAccess, access))),
        );
        const core = Context.get(modules, CoreModules);
        // Runtime admission stays deterministic; all Session writes and reads cross real Core.
        const f = setup({}, [], undefined, core.workspace);
        f.state.admitMessageRuns = true;
        f.state.generatedTitle = "Task";
        const owner = yield* f.owner;
        const projectId = scenario.manifest.projectId;
        const acceptedAt = Math.trunc(performance.timeOrigin + performance.now());
        const source = yield* owner.launch({
          ...launch,
          acceptedAt,
          projectId,
          initialPageIds: [],
          modelSelection: { instanceId: "claude", model: "model-a" },
        });
        const side = yield* owner.createSideChat({
          source: { sessionId: source.sessionId },
          sessionId: "side:real-core-title",
          requestId: "create:real-core-title",
          acceptedAt,
        });
        const displayTitle = (sessionId: string) =>
          core.workspace
            .read({ kind: "session", session_id: sessionId }, undefined, projectId)
            .pipe(
              Effect.map((read) =>
                read.value.kind === "session" ? read.value.session.display_title : null,
              ),
            );
        assert.equal(yield* displayTitle(side.sessionId), "Side chat");
        const input = {
          sessionId: side.sessionId,
          message: {
            messageId: "side:real-core-first",
            text: "**Inspect** the launch checklist",
          },
        };
        assert.equal((yield* owner.message(input)).sideChatTitle, "Inspect the launch checklist");
        assert.equal(yield* displayTitle(side.sessionId), "Inspect the launch checklist");
        assert.equal((yield* owner.message(input)).sideChatTitle, "Inspect the launch checklist");
        assert.equal(yield* displayTitle(source.sessionId), "Task");
        const current = f.snapshots.get(side.threadId)!;
        f.snapshots.set(side.threadId, {
          ...current,
          projection: {
            ...current.projection,
            runs: current.projection.runs.map((run) => ({ ...run, status: "completed" })),
          },
        });
        const saved = yield* owner.saveSideChat({
          source: { sessionId: side.sessionId },
          sessionId: "saved:real-core-title",
          requestId: "save:real-core-title",
          acceptedAt,
        });
        assert.equal(yield* displayTitle(saved.sessionId), "Inspect the launch checklist");
        yield* core.workspace.apply(
          {
            operationId: createOperationId("test.side-chat.rename"),
            intent: {
              kind: "mutate_session",
              session_id: side.sessionId,
              intent: { kind: "rename", title: "Keep this title" },
            },
          },
          undefined,
          projectId,
        );
        yield* owner.message(input);
        assert.equal(yield* displayTitle(side.sessionId), "Keep this title");
        assert.equal(yield* displayTitle(saved.sessionId), "Inspect the launch checklist");
        yield* Effect.promise(() => scenario.withStoppedCore(async () => {}));
        assert.equal(yield* displayTitle(saved.sessionId), "Inspect the launch checklist");
        assert.equal(yield* displayTitle(side.sessionId), "Keep this title");
        assert.equal(yield* displayTitle(source.sessionId), "Task");
      }),
    ),
);

it.effect.each(["codex", "claude", "opencode", "acp"])(
  "%s side chats take their first admitted request as title before a reply and retain it when saved",
  (instanceId) =>
    Effect.gen(function* () {
      const { fixture: f, owner, side, source } = yield* sideChatTitleFixture(instanceId);
      const text = "Context\n## My request:\n**Inspect** [the request](https://example.com)\n now";
      const result = yield* owner.message({
        sessionId: side.sessionId,
        message: { messageId: "side:first", text },
      });
      assert.equal(result.sideChatTitle, "Inspect the request now");
      assert.equal(f.titles.get(side.sessionId), "Inspect the request now");
      assert.equal(f.titles.get(source.sessionId), "Task");
      assert.equal(f.snapshots.get(side.threadId)!.projection.runs[0]!.status, "starting");
      const later = yield* owner.message({
        sessionId: side.sessionId,
        message: { messageId: "side:later", text: "A later request" },
      });
      assert.isUndefined(later.sideChatTitle);
      assert.equal(f.titles.get(side.sessionId), "Inspect the request now");
      const current = f.snapshots.get(side.threadId)!;
      f.snapshots.set(side.threadId, {
        ...current,
        projection: {
          ...current.projection,
          runs: current.projection.runs.map((run) => ({ ...run, status: "completed" })),
        },
      });
      const saved = yield* owner.saveSideChat({
        source: { sessionId: side.sessionId },
        sessionId: "saved:title",
        requestId: "save:title",
        acceptedAt: launch.acceptedAt,
      });
      assert.equal(f.titles.get(saved.sessionId), "Inspect the request now");
      assert.equal(
        f.snapshots.get(saved.threadId)!.projection.thread.title,
        "Inspect the request now",
      );
    }),
);

it.effect(
  "a rejected first side request leaves the default title available for an accepted retry",
  () =>
    Effect.gen(function* () {
      const { fixture: f, owner, side } = yield* sideChatTitleFixture();
      const input = {
        sessionId: side.sessionId,
        message: { messageId: "first", text: "Retry this request" },
      };
      f.state.failMessage = true;
      yield* owner.message(input).pipe(Effect.flip);
      assert.equal(f.titles.get(side.sessionId), "Side chat");
      assert.equal((yield* owner.message(input)).sideChatTitle, "Retry this request");
      assert.equal(f.titles.get(side.sessionId), "Retry this request");
    }),
);

it.effect(
  "an idle side request with Agent configuration is titled when its Run starts immediately",
  () =>
    Effect.gen(function* () {
      const { fixture: f, owner, side } = yield* sideChatTitleFixture("codex");
      const result = yield* owner.message({
        sessionId: side.sessionId,
        message: {
          messageId: "first",
          text: ':agent-config{mode="plan"}\n**Inspect** status',
        },
      });
      assert.equal(result.sideChatTitle, "Inspect status");
      assert.equal(f.titles.get(side.sessionId), "Inspect status");
      assert.equal(f.snapshots.get(side.threadId)!.projection.runs[0]!.status, "starting");
    }),
);

it.effect.each(["attachment-only", "agent"] as const)(
  "an admitted %s opening side request keeps the default title and later requests do not replace it",
  (kind) =>
    Effect.gen(function* () {
      const { fixture: f, owner, side } = yield* sideChatTitleFixture();
      const message =
        kind === "attachment-only"
          ? {
              messageId: "first",
              text: "",
              attachments: [
                {
                  type: "file" as const,
                  id: "file:one",
                  name: "notes.txt",
                  mimeType: "text/plain",
                  sizeBytes: 4,
                },
              ],
            }
          : { messageId: "first", text: "Opening request" };
      const first = owner.message({ sessionId: side.sessionId, message });
      const result = yield* kind === "agent"
        ? first.pipe(Effect.provideService(CoreApplicationAgent, agent))
        : first;
      assert.isUndefined(result.sideChatTitle);
      assert.equal(f.titles.get(side.sessionId), "Side chat");
      const later = yield* owner.message({
        sessionId: side.sessionId,
        message: { messageId: "later", text: "Later title" },
      });
      assert.isUndefined(later.sideChatTitle);
      assert.equal(f.titles.get(side.sessionId), "Side chat");
    }),
);

it.effect.each([false, true])(
  "queue intake titles a side request only when it is actually published, held %s",
  (held) =>
    Effect.gen(function* () {
      const { fixture: f, owner, side } = yield* sideChatTitleFixture();
      f.state.holdMessages = held;
      const result = yield* owner.queueMessage({
        sessionId: side.sessionId,
        message: { messageId: "first", text: "Opening request" },
      });
      assert.equal(result.sideChatTitle, held ? undefined : "Opening request");
      assert.equal(f.titles.get(side.sessionId), held ? "Side chat" : "Opening request");
    }),
);

it.effect.each(["interactive", "semantic"] as const)(
  "a person replaying an Agent's %s opening cannot name the side chat",
  (entry) =>
    Effect.gen(function* () {
      const { fixture: f, owner, side } = yield* sideChatTitleFixture();
      const input = {
        sessionId: side.sessionId,
        message: { messageId: "agent:first", text: "Agent opening request" },
      };
      const admitted =
        entry === "interactive"
          ? yield* owner.message(input).pipe(Effect.provideService(CoreApplicationAgent, agent))
          : yield* owner
              .sendMessage({ ...input, mode: "auto" })
              .pipe(Effect.provideService(CoreApplicationAgent, agent));
      assert.isUndefined(admitted.sideChatTitle);
      assert.isUndefined((yield* owner.message(input)).sideChatTitle);
      f.state.messageReplay = {
        messageId: input.message.messageId,
        runId: "run:agent:first",
        status: "starting",
        delivery: "started",
      };
      const replayed = yield* owner.sendMessage({
        ...input,
        mode: "auto",
        messageFingerprint: "agent-opening-fingerprint",
        message: { ...input.message, text: "Person retry text" },
      });
      assert.isUndefined(replayed.sideChatTitle);
      assert.equal(f.titles.get(side.sessionId), "Side chat");
      assert.lengthOf(f.snapshots.get(side.threadId)!.projection.runs, 1);
    }),
);

it.effect.each(["sent-second", "resumed-second"] as const)(
  "the first published side request names the chat when a queued first Run is activated after %s",
  (order) =>
    Effect.gen(function* () {
      const { fixture: f, owner, side } = yield* sideChatTitleFixture();
      f.state.holdMessages = true;
      yield* owner.queueMessage({
        sessionId: side.sessionId,
        message: { messageId: "queued:first", text: "Older queued request" },
      });
      if (order === "resumed-second")
        yield* owner.queueMessage({
          sessionId: side.sessionId,
          message: { messageId: "sent:second", text: "Chosen first request" },
        });
      f.state.holdMessages = false;
      const result =
        order === "sent-second"
          ? yield* owner.message({
              sessionId: side.sessionId,
              message: { messageId: "sent:second", text: "Chosen first request" },
            })
          : yield* owner.queue({
              sessionId: side.sessionId,
              requestId: "resume:second",
              action: "resume",
              runId: "run:sent:second",
            });
      assert.equal(result.sideChatTitle, "Chosen first request");
      assert.equal(f.titles.get(side.sessionId), "Chosen first request");
      const current = f.snapshots.get(side.threadId)!;
      f.snapshots.set(side.threadId, {
        ...current,
        projection: {
          ...current.projection,
          runs: current.projection.runs.map((run) =>
            run.userMessageId === "sent:second" ? { ...run, status: "completed" } : run,
          ),
        },
      });
      const resumed = yield* owner.queue({
        sessionId: side.sessionId,
        requestId: "resume:older",
        action: "resume",
        runId: "run:queued:first",
      });
      assert.isUndefined(resumed.sideChatTitle);
      assert.equal(f.titles.get(side.sessionId), "Chosen first request");
    }),
);

it.effect.each([undefined, "run:first"])(
  "resuming the first queued side request names it only after activation, selected Run %s",
  (runId) =>
    Effect.gen(function* () {
      const { fixture: f, owner, side } = yield* sideChatTitleFixture();
      f.state.holdMessages = true;
      yield* owner.queueMessage({
        sessionId: side.sessionId,
        message: { messageId: "first", text: "**Inspect** the paused request" },
      });
      assert.equal(f.titles.get(side.sessionId), "Side chat");
      const input = {
        sessionId: side.sessionId,
        requestId: "resume:first",
        action: "resume" as const,
        ...(runId ? { runId } : {}),
      };
      const result = yield* owner.queue(input);
      assert.equal(result.sideChatTitle, "Inspect the paused request");
      assert.equal(f.titles.get(side.sessionId), "Inspect the paused request");
      assert.equal(f.snapshots.get(side.threadId)!.projection.runs[0]!.status, "starting");
      const replayed = yield* owner.queue(input);
      assert.equal(replayed.sideChatTitle, "Inspect the paused request");
      assert.lengthOf(f.snapshots.get(side.threadId)!.projection.runs, 1);
    }),
);

it.effect(
  "semantic sends return the full first-request title while Core keeps a bounded Unicode prefix",
  () =>
    Effect.gen(function* () {
      const { fixture: f, owner, side } = yield* sideChatTitleFixture();
      const text = `${"中".repeat(1_999)}😀 more request text`;
      const result = yield* owner.sendMessage({
        sessionId: side.sessionId,
        mode: "auto",
        message: { messageId: "first", text },
      });
      assert.equal(result.delivery, "started");
      assert.equal(result.sideChatTitle, text);
      assert.equal(f.titles.get(side.sessionId), "中".repeat(1_999));
      const later = yield* owner.sendMessage({
        sessionId: side.sessionId,
        mode: "auto",
        message: { messageId: "later", text: "Changed title" },
      });
      assert.isUndefined(later.sideChatTitle);
    }),
);

it.effect(
  "accepted side requests still return their title when metadata storage fails, and replay repairs it",
  () =>
    Effect.gen(function* () {
      const { fixture: f, owner, side } = yield* sideChatTitleFixture();
      const input = {
        sessionId: side.sessionId,
        message: { messageId: "first", text: "Accepted request" },
      };
      f.state.failTitleWrite = true;
      assert.equal((yield* owner.message(input)).sideChatTitle, "Accepted request");
      assert.equal(f.titles.get(side.sessionId), "Side chat");
      f.state.failTitleWrite = false;
      assert.equal((yield* owner.message(input)).sideChatTitle, "Accepted request");
      assert.equal(f.titles.get(side.sessionId), "Accepted request");
      assert.lengthOf(f.snapshots.get(side.threadId)!.projection.runs, 1);
    }),
);

it.effect(
  "semantic receipt replay restores the accepted first side title without dispatching again",
  () =>
    Effect.gen(function* () {
      const { fixture: f, owner, side } = yield* sideChatTitleFixture();
      const input = {
        sessionId: side.sessionId,
        mode: "auto" as const,
        message: { messageId: "first", text: "Accepted semantic request" },
      };
      const accepted = yield* owner.sendMessage(input);
      f.state.messageReplay = {
        messageId: "first",
        runId: accepted.runId,
        status: accepted.status,
        delivery: accepted.delivery,
      };
      const before = f.calls.length;
      const replayed = yield* owner.sendMessage({
        ...input,
        messageFingerprint: "accepted-fingerprint",
        message: { messageId: "first", text: "Changed retry text" },
      });
      assert.equal(replayed.sideChatTitle, "Accepted semantic request");
      assert.isFalse(f.calls.slice(before).some((call) => call.method === "thread.send"));
      assert.lengthOf(f.snapshots.get(side.threadId)!.projection.runs, 1);
    }),
);

it.effect("first-request titles cannot overwrite a manually renamed side Session", () =>
  Effect.gen(function* () {
    const { fixture: f, owner, side } = yield* sideChatTitleFixture();
    yield* owner.renameSession({
      operationId: "rename:side",
      payload: { sessionId: side.sessionId, input: { title: "My title" } },
    });
    yield* owner.message({
      sessionId: side.sessionId,
      message: { messageId: "first", text: "First request" },
    });
    assert.equal(f.titles.get(side.sessionId), "My title");
  }),
);

it.effect(
  "replayed side-message receipts use the accepted request instead of altered retry text",
  () =>
    Effect.gen(function* () {
      const { fixture: f, owner, side } = yield* sideChatTitleFixture();
      const input = {
        sessionId: side.sessionId,
        message: { messageId: "first", text: "The accepted request" },
      };
      yield* owner.message(input);
      const replayed = yield* owner.message({
        ...input,
        message: { ...input.message, text: "Unaccepted replacement text" },
      });
      assert.equal(replayed.sideChatTitle, "The accepted request");
      assert.equal(f.titles.get(side.sessionId), "The accepted request");
      assert.lengthOf(f.snapshots.get(side.threadId)!.projection.runs, 1);
    }),
);

it.effect.each(["unused", "finished"] as const)(
  "saves an %s side chat as a durable Session and replays after source disposal",
  (state) =>
    Effect.gen(function* () {
      const f = setup();
      const owner = yield* f.owner;
      const source = yield* owner.launch(launch);
      const side = yield* owner.createSideChat({
        source: { sessionId: source.sessionId },
        sessionId: "side:save",
        requestId: "side:create",
        acceptedAt: launch.acceptedAt,
      });
      if (state === "finished") {
        const current = f.snapshots.get(side.threadId)!;
        f.snapshots.set(side.threadId, {
          ...current,
          projection: {
            ...current.projection,
            runs: [
              { ...f.snapshots.get(source.threadId)!.projection.runs[0]!, status: "completed" },
            ],
          },
        });
      }
      const before = structuredClone(f.snapshots.get(side.threadId));
      const input = {
        source: { sessionId: side.sessionId, threadId: side.threadId },
        sessionId: "saved",
        requestId: "side:save",
        acceptedAt: launch.acceptedAt,
      };
      const saved = yield* owner.saveSideChat(input);
      assert.equal(saved.sourceSessionId, side.sessionId);
      assert.equal(saved.projectId, source.projectId);
      assert.isUndefined(f.bindings.get(saved.sessionId)!.side_chat_source_session_id);
      assert.deepEqual(f.snapshots.get(side.threadId), before);
      assert.lengthOf(f.snapshots.get(saved.threadId)!.projection.runs, 0);
      assert.isUndefined(f.snapshots.get(saved.threadId)!.projection.thread.sideChat);
      assert.deepEqual(
        f.snapshots.get(saved.threadId)!.projection.thread.modelSelection,
        before!.projection.thread.modelSelection,
      );
      assert.equal(
        [...f.commands.values()].filter((c) => c.type === "thread.fork" && c.saveSideChat).length,
        1,
      );
      yield* owner.discardSideChat({ sessionId: side.sessionId, requestId: "discard" });
      const calls = f.calls.length;
      assert.deepEqual(yield* owner.saveSideChat(input), saved);
      assert.deepEqual(
        yield* owner.saveSideChat({ ...input, source: { sessionId: side.sessionId } }),
        saved,
      );
      assert.isFalse(
        f.calls.slice(calls).some((call) => call.method === "thread.side-chat-save-source"),
      );
      yield* owner.saveSideChat({ ...input, requestId: "different" }).pipe(Effect.flip);
      yield* owner
        .saveSideChat({ ...input, source: { sessionId: source.sessionId } })
        .pipe(Effect.flip);
    }),
);

it.effect("rejects non-side and pending-work saves before destination admission", () =>
  Effect.gen(function* () {
    const f = setup();
    const owner = yield* f.owner;
    const source = yield* owner.launch(launch);
    const input = {
      source: { sessionId: source.sessionId },
      sessionId: "saved",
      requestId: "save",
      acceptedAt: launch.acceptedAt,
    };
    const before = { applied: f.applied.length, commands: f.commands.size };
    yield* owner.saveSideChat(input).pipe(Effect.flip);
    assert.equal(f.applied.length, before.applied);
    assert.equal(f.commands.size, before.commands);
    const side = yield* owner.createSideChat({ ...input, sessionId: "side" });
    const sourceBefore = structuredClone(f.snapshots.get(side.threadId));
    f.state.refuseSideChatSave = true;
    const applied = f.applied.length;
    const commands = f.commands.size;
    yield* owner
      .saveSideChat({ ...input, source: { sessionId: side.sessionId } })
      .pipe(Effect.flip);
    assert.equal(f.applied.length, applied);
    assert.equal(f.commands.size, commands);
    assert.isFalse(f.bindings.has("saved"));
    assert.deepEqual(f.snapshots.get(side.threadId), sourceBefore);
  }),
);

it.effect(
  "revalidates save authority before reading execution and when replaying a saved chat",
  () =>
    Effect.gen(function* () {
      const f = setup();
      const owner = yield* f.owner;
      const source = yield* owner.launch(launch);
      const side = yield* owner.createSideChat({
        source: { sessionId: source.sessionId },
        sessionId: "side",
        requestId: "side:create",
        acceptedAt: launch.acceptedAt,
      });
      const input = {
        source: { sessionId: side.sessionId },
        sessionId: "saved",
        requestId: "side:save",
        acceptedAt: launch.acceptedAt,
      };
      f.state.denyAgent = true;
      const calls = f.calls.length;
      yield* owner
        .saveSideChat(input)
        .pipe(Effect.provideService(CoreApplicationAgent, agent), Effect.flip);
      assert.isFalse(
        f.calls.slice(calls).some((call) => call.method === "thread.side-chat-save-source"),
      );
      assert.isFalse(f.bindings.has(input.sessionId));
      f.state.denyAgent = false;
      yield* owner.saveSideChat(input);
      f.state.denyAgent = true;
      const afterSave = f.calls.length;
      yield* owner
        .saveSideChat(input)
        .pipe(Effect.provideService(CoreApplicationAgent, agent), Effect.flip);
      assert.isFalse(f.calls.slice(afterSave).some((call) => call.method === "thread.read"));
    }),
);

it.effect.each(["before-commit", "lost-reply"] as const)(
  "preserves the source and retries the same save after %s failure",
  (failure) =>
    Effect.gen(function* () {
      const f = setup();
      const owner = yield* f.owner;
      const source = yield* owner.launch(launch);
      const side = yield* owner.createSideChat({
        source: { sessionId: source.sessionId },
        sessionId: "side",
        requestId: "side:create",
        acceptedAt: launch.acceptedAt,
      });
      const before = structuredClone(f.snapshots.get(side.threadId));
      const input = {
        source: { sessionId: side.sessionId },
        sessionId: "saved",
        requestId: "side:save",
        acceptedAt: launch.acceptedAt,
      };
      f.state.failSideChatSave = failure === "before-commit";
      f.state.loseSideChatSaveReply = failure === "lost-reply";
      yield* owner.saveSideChat(input).pipe(Effect.flip);
      assert.deepEqual(f.snapshots.get(side.threadId), before);
      const saved = yield* owner.saveSideChat(input);
      assert.equal(saved.sessionId, "saved");
      assert.equal(
        f.applied.filter(
          (op) =>
            op.intent.kind === "create_agent_runtime_session" && op.intent.session_id === "saved",
        ).length,
        1,
      );
      assert.equal(
        [...f.commands.values()].filter((c) => c.type === "thread.fork" && c.saveSideChat).length,
        1,
      );
      assert.deepEqual(f.snapshots.get(side.threadId), before);
    }),
);

it.effect.each(["stored", "live", "standard"] as const)(
  "native side capture preserves current settings without adopting its source or reopening history (%s)",
  (settings) =>
    Effect.gen(function* () {
      const f = setup({
        ...(settings === "stored"
          ? {}
          : {
              nativeCodexSettings: (threadId) => {
                assert.equal(threadId, codexImport.nativeSessionId);
                return {
                  model: "model-b",
                  reasoningEffort: settings === "standard" ? null : "low",
                  serviceTier: settings === "standard" ? null : "fast",
                  personality: null,
                  collaborationMode: {
                    mode: "plan",
                    settings: {
                      model: "model-b",
                      reasoning_effort: "low",
                      developer_instructions: null,
                    },
                  },
                };
              },
            }),
      });
      f.state.nativeSession = {
        id: "native-source",
        projectId: "project",
        displayTitle: "Native source",
        archived: false,
        thread: {
          threadId: codexImport.nativeSessionId,
          executionHostId: "local",
          backendBinding: { kind: "codex" },
          cwd: "/native/work",
          statusType: "active",
          executionProfile: { modelId: "model-b", reasoningEffort: "low", serviceTier: "fast" },
        },
      } as ProjectSession;
      const original = structuredClone(f.state.nativeSession);
      const owner = yield* f.owner;
      const input = {
        source: { sessionId: "native-source", threadId: codexImport.nativeSessionId },
        sessionId: "native-side",
        requestId: "native-side:create",
        acceptedAt: launch.acceptedAt,
      };
      const side = yield* owner.createSideChat(input);
      assert.isFalse(f.bindings.has("native-source"));
      assert.deepEqual(f.state.nativeSession, original);
      const capture = [...f.imports.values()][0]!;
      assert.isTrue(capture.sideChatCapture);
      assert.equal(capture.sourceNativeThreadId, codexImport.nativeSessionId);
      assert.equal(capture.interactionMode, settings === "stored" ? undefined : "plan");
      assert.deepEqual(capture.modelSelection, {
        instanceId: "codex",
        model: "model-b",
        options:
          settings === "standard"
            ? [{ id: "serviceTier", value: "default" }]
            : [
                { id: "reasoningEffort", value: "low" },
                { id: "serviceTier", value: "fast" },
              ],
      });
      assert.isNotNull(f.snapshots.get(capture.threadId)!.projection.thread.deletedAt);
      assert.equal(f.bindings.size, 1);
      const reads = f.calls.filter((c) => c.method === "thread.import-native").length;
      f.state.nativeSession = null;
      assert.deepEqual(yield* owner.createSideChat(input), side);
      assert.equal(f.calls.filter((c) => c.method === "thread.import-native").length, reads);
    }),
);

it.effect.each(["current", "missing", "account", "home"] as const)(
  "captures passive Claude history with its native identity and choices only from the current profile (%s)",
  (profile) =>
    Effect.gen(function* () {
      const backendBinding = { kind: "claude" as const, instanceConfigId: "personal" };
      const instanceId = agentRuntimeProviderId(backendBinding)!;
      const f = setup({}, [
        {
          instanceId,
          driver: "claudeAgent",
          enabled: true,
          models: [
            { slug: "claude-default", isDefault: true },
            {
              slug: "claude-current",
              capabilities: {
                optionDescriptors: [
                  { id: "effort", type: "select", options: [{ id: "high" }] },
                  { id: "fastMode", type: "boolean" },
                  { id: "thinking", type: "boolean" },
                  { id: "contextWindow", type: "select", options: [{ id: "1m" }] },
                ],
              },
            },
          ],
        },
      ] as unknown as AgentRuntimeOperations["providers.read"]["output"]);
      f.state.nativeImportSourceHome = "/native/claude";
      f.state.nativeSession = {
        id: "native-source",
        projectId: "project",
        displayTitle: "Claude source",
        archived: false,
        thread: {
          threadId: "claude-product-thread",
          executionHostId: "local",
          backendBinding,
          cwd: "/native/work",
          statusType: "idle",
        },
      } as ProjectSession;
      f.state.nativeBackendSession = {
        threadId: "claude-product-thread",
        backendBinding:
          profile === "account" ? { ...backendBinding, instanceConfigId: "other" } : backendBinding,
        backendSessionId: codexImport.nativeSessionId,
        nativeHome: profile === "home" ? "/different/claude" : "/native/claude",
        updatedAt: 0,
        runtimeOptions: null,
        nativeState: {
          ever_saved: true,
          preferences: {
            model: "claude-current",
            effort: "high",
            fast: true,
            thinking: false,
            context: "1m",
            interaction_mode: "plan",
          },
        },
      };
      if (profile === "missing") f.state.nativeBackendSession = null;
      const original = structuredClone(f.state.nativeBackendSession);
      const owner = yield* f.owner;
      const create = owner.createSideChat({
        source: { sessionId: "native-source" },
        sessionId: "native-side",
        requestId: "native-side:create",
        acceptedAt: launch.acceptedAt,
      });
      if (profile !== "current") {
        yield* create.pipe(Effect.flip);
        assert.equal(f.imports.size, 0);
        assert.equal(f.bindings.size, 0);
        return;
      }
      yield* create;
      const capture = [...f.imports.values()][0]!;
      assert.equal(capture.sourceNativeThreadId, codexImport.nativeSessionId);
      assert.equal(capture.sourceHome, "/native/claude");
      assert.equal(capture.interactionMode, "plan");
      assert.deepEqual(capture.modelSelection, {
        instanceId,
        model: "claude-current",
        options: [
          { id: "fastMode", value: true },
          { id: "thinking", value: false },
          { id: "contextWindow", value: "1m" },
          { id: "effort", value: "high" },
        ],
      });
      assert.isFalse(f.bindings.has("native-source"));
      assert.deepEqual(f.state.nativeBackendSession, original);
    }),
);

it.effect(
  "startup reclaims hidden side Sessions while retaining regular chats for normal recovery",
  () =>
    Effect.gen(function* () {
      const f = setup();
      const owner = yield* f.owner;
      const source = yield* owner.launch(launch);
      const side = yield* owner.createSideChat({
        source: { sessionId: source.sessionId },
        sessionId: "orphan-side",
        requestId: "orphan:create",
        acceptedAt: launch.acceptedAt,
      });
      yield* owner.discardOrphanSideChats("engine");
      assert.isTrue(f.bindings.has(source.sessionId));
      assert.isFalse(f.bindings.has(side.sessionId));
      assert.equal(f.cleanups.size, 1);
      yield* owner.cleanupDeletedSessions;
      assert.isNotNull(f.snapshots.get(side.threadId)!.projection.thread.deletedAt);
      assert.isNull(f.snapshots.get(source.threadId)!.projection.thread.deletedAt);
    }),
);
