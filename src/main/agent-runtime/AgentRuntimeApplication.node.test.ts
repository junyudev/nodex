import { assert, it } from "@effect/vitest";
import { access, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { components } from "@nodex/core-protocol";
import type {
  AgentCommand,
  AgentRuntimeMethod,
  AgentRuntimeOperations,
  AgentSnapshot,
} from "@nodex/agent-runtime/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreModuleResponseError } from "../core-client/core-client";
import { coreRuntimeError, type CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import type { ProjectWorkspaceApplyInput, ProjectWorkspaceRead } from "../core-client/types";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { ProjectWorkspace, ProjectWorkspaceError } from "../project-application/ProjectWorkspace";
import type { ProjectSession } from "../../shared/types";
import {
  make,
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

const snapshot = (
  threadId: string,
  rootThreadId = threadId,
  projectId = "project",
): AgentSnapshot =>
  ({
    kind: "snapshot",
    snapshotSequence: 0,
    historyCursor: "cursor:older",
    hasMoreHistory: true,
    projection: {
      thread: {
        id: threadId,
        projectId,
        lineage: { rootThreadId, parentThreadId: threadId === rootThreadId ? null : rootThreadId },
        deletedAt: null,
        archivedAt: null,
        interactionMode: "default",
      },
      runs: [],
      runtimeRequests: [],
      nodes: [],
      messages: [],
    },
  }) as unknown as AgentSnapshot;

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
) => {
  const bindings = new Map<string, Binding>();
  const snapshots = new Map<string, AgentSnapshot>();
  const commands = new Map<string, AgentCommand>();
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
  ] as unknown as AgentRuntimeOperations["providers.read"]["output"];
  const state = {
    archived: false,
    lifecycle: "active",
    mode: "auto",
    runtimeId: "engine",
    failMessage: false,
    failThreadCreate: false,
    failCore: false,
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
                      primary_workspace_root: "/workspace",
                      lifecycle: state.lifecycle,
                      sources: [{ root: "/workspace", order: 0 }],
                    },
                  },
                };
              if (input.kind === "session")
                return {
                  value: {
                    kind: "session",
                    session: { archived: state.archived, display_title: "Task" },
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
                          (binding.project_id ?? null) === (input.project_id ?? null),
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
      if (intent.kind !== "create_agent_runtime_session") throw new Error("Unexpected Core intent");
      bindings.set(intent.session_id, {
        session_id: intent.session_id,
        project_id: intent.project_id,
        runtime_id: intent.runtime_id,
        runtime_thread_id: intent.runtime_thread_id,
        launch_request_id: intent.launch_request_id,
        bound_at: "2026-10-14T00:00:00Z",
      });
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
      if (method === "providers.read") return providers as AgentRuntimeOperations[M]["output"];
      if (method === "text.generate-structured")
        return (
          state.generatedTitle === null
            ? yield* Effect.fail(new Error("No title model"))
            : { title: state.generatedTitle, description: "Login fix" }
        ) as AgentRuntimeOperations[M]["output"];
      if (method === "command.dispatch") {
        const command = input as AgentCommand;
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
          if (command.dispatchMode.type === "defer_start") {
            const current = snapshots.get(command.threadId)!;
            snapshots.set(command.threadId, {
              ...current,
              projection: {
                ...current.projection,
                runs: [
                  ...current.projection.runs,
                  {
                    id: `run:${command.messageId}`,
                    userMessageId: command.messageId,
                    status: "preparing",
                    ordinal: current.projection.runs.length + 1,
                  } as never,
                ],
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
                lineage: {
                  rootThreadId: independent
                    ? command.targetThreadId
                    : source.projection.thread.lineage.rootThreadId,
                  parentThreadId: independent ? null : command.sourceThreadId,
                  relationshipToParent: independent ? null : "fork",
                },
              },
            },
          });
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
      noThreadFallbackTitle: "Task",
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
    connect: Effect.sync(connection),
    projectless: options.projectless ?? {
      engineProjectId: "profile:projectless",
      workspaceRoot: "/tasks",
      ensureWorkspaceRoot: Effect.void,
    },
  }).pipe(
    Effect.provideService(CoreModules, { workspace: { read, apply } } as never),
    Effect.provideService(ProjectWorkspace, {
      renameProjectSession: (command) =>
        mutateSession("rename", () => ({
          ...sessionValue(command.payload.sessionId),
          noThreadFallbackTitle: state.supersededTitle
            ? "Newer title"
            : command.payload.input.title.trim(),
        })),
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
  );
  return { owner, bindings, snapshots, commands, calls, applied, actors, order, state, cleanups };
};

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
            ? Effect.fail(new Error("Branch feature is checked out elsewhere"))
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
            (call.input as AgentCommand).type === "run.interrupt",
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
  "parses raw NFM lines, respects structured input and queues overrides without steering",
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
          messageId: "message:nfm",
          text: '<agent-config mode="plan" reasoning="high" speed="standard" />\nNext task',
        },
      });
      const command = [...fixture.commands.values()].find(
        (value) => value.type === "message.dispatch" && value.messageId === "message:nfm",
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
          text: '<agent-config model="missing" />\nLiteral',
          agentConfigs: [],
        },
      });
      const literal = [...fixture.commands.values()].find(
        (value) => value.type === "message.dispatch" && value.messageId === "message:literal",
      )!;
      assert.equal(
        literal.type === "message.dispatch" && literal.text,
        '<agent-config model="missing" />\nLiteral',
      );
      assert.equal(
        fixture.calls.filter((call) => call.method === "providers.read").length,
        catalogCount,
      );
      yield* owner.queue({
        sessionId: created.sessionId,
        requestId: "edit:nfm",
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
