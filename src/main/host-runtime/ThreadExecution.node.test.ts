import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import {
  AgentRuntimeThreadExecution,
  AgentRuntimeThreadExecutionError,
} from "../agent-runtime/AgentRuntimeThreadExecution";
import { CodexThreadExecution } from "../codex-application/CodexThreadExecution";
import type { CodexThreadExecutionLocation } from "../codex/codex-thread-handoff-journal";
import {
  ProjectWorkspace,
  type DesktopProjectWorkspaceThread,
} from "../project-application/ProjectWorkspace";
import { make } from "./ThreadExecution";

const source: CodexThreadExecutionLocation = {
  hostId: "local",
  cwd: "/repo/project/src",
  workspaceRoots: ["/repo/project", "/repo/shared"],
  managedWorktreePath: null,
  projectId: "project",
  projectlessOutputDirectory: null,
  projectlessWorkspaceBrowserRoot: null,
};
const destination = {
  ...source,
  cwd: "/managed/task/src",
  workspaceRoots: ["/managed/task", "/repo/shared"],
  managedWorktreePath: "/managed/task",
};
const thread = (backendBinding: AgentBackendBinding): DesktopProjectWorkspaceThread => ({
  threadId: "thread",
  projectId: "project",
  sessionId: "session",
  forkedFromId: null,
  parentThreadId: null,
  threadSource: null,
  serviceName: null,
  agentNickname: null,
  agentRole: null,
  agentPath: null,
  threadName: "Work",
  threadPreview: "",
  backendBinding,
  executionHostId: "local",
  cwd: source.cwd,
  managedWorktreePath: null,
  projectlessOutputDirectory: null,
  projectlessWorkspaceBrowserRoot: null,
  statusType: "idle",
  statusActiveFlags: [],
  archived: false,
  pinnedOrder: null,
  hasUnreadTurn: false,
  createdAt: 1,
  updatedAt: 1,
  recencyAt: 1,
  linkedAt: "2026-09-30T00:00:00Z",
});

const harness = (
  backendBinding: AgentBackendBinding,
  runtime?: AgentRuntimeThreadExecution["Service"],
) =>
  Effect.gen(function* () {
    let authority = thread(backendBinding);
    const calls: string[] = [];
    const commits: unknown[] = [];
    const prompts: { threadId: string; prompt: string; operationId: string }[] = [];
    const safety: { provider: string; threadId: string; required: boolean }[] = [];
    const record = (name: string) =>
      Effect.sync(() => {
        calls.push(name);
      });
    const codex = CodexThreadExecution.of({
      setRecoveryRequired: (threadId, required) =>
        Effect.sync(() => {
          safety.push({ provider: "codex", threadId, required });
        }),
      read: () => record("codex:read").pipe(Effect.as(source)),
      stop: () => record("codex:stop"),
      withHandoff: (_threadId, use) => record("codex:handoff").pipe(Effect.andThen(use)),
      switchRuntime: () => record("codex:switch"),
      relocate: () => Effect.void,
      commit: () => record("codex:commit"),
      followUp: () => record("codex:follow-up"),
    });
    const workspace = {
      getThread: () => Effect.succeed(authority),
      readThreadExecutionContext: () =>
        Effect.succeed({ projectId: authority.projectId, workspaceRoots: source.workspaceRoots }),
      setThreadExecutionLocation: (threadId: string, location: unknown) =>
        Effect.sync(() => {
          commits.push({ threadId, location });
          return authority;
        }),
    } as unknown as ProjectWorkspace["Service"];
    const construction = make.pipe(
      Effect.provideService(ProjectWorkspace, workspace),
      Effect.provideService(CodexThreadExecution, codex),
    );
    const execution = yield* runtime
      ? construction.pipe(Effect.provideService(AgentRuntimeThreadExecution, runtime))
      : construction;
    return {
      execution,
      calls,
      commits,
      prompts,
      safety,
      change: (patch: Partial<DesktopProjectWorkspaceThread>) => {
        authority = { ...authority, ...patch };
      },
    };
  });

it.effect("preserves native Codex handoff routing and execution location", () =>
  Effect.gen(function* () {
    const f = yield* harness({ kind: "codex" });
    assert.deepEqual(yield* f.execution.read("thread", "remote"), source);
    assert.strictEqual(yield* f.execution.withHandoff("thread", Effect.succeed("owned")), "owned");
    yield* f.execution.stop("thread");
    const used = yield* f.execution.withRuntimeLocation(
      "thread",
      destination,
      null,
      Effect.succeed("committed"),
    );
    assert.strictEqual(used, "committed");
    yield* f.execution.commit("thread", destination);
    yield* f.execution.followUp("thread", "continue");
    assert.deepEqual(f.calls, [
      "codex:read",
      "codex:handoff",
      "codex:stop",
      "codex:switch",
      "codex:commit",
      "codex:follow-up",
    ]);
  }),
);

it.effect("only the bound native Codex owner admits legacy handoff operations", () =>
  Effect.gen(function* () {
    const f = yield* harness({ kind: "claude", instanceConfigId: "work" });
    for (const operation of [
      f.execution.read("thread", "local"),
      f.execution.stop("thread"),
      f.execution.withHandoff("thread", Effect.void),
      f.execution.withRuntimeLocation("thread", destination, null, Effect.void),
      f.execution.commit("thread", destination),
      f.execution.followUp("thread", "continue"),
    ])
      assert.isTrue(Exit.isFailure(yield* Effect.exit(operation)));
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.commits, []);
    assert.deepEqual(f.prompts, []);
  }),
);

it.effect("ACP never acquires Codex or Claude execution capabilities", () =>
  Effect.gen(function* () {
    const f = yield* harness({
      kind: "acp",
      agentDefinitionId: "external",
      instanceConfigId: null,
    });
    for (const operation of [
      f.execution.read("thread"),
      f.execution.stop("thread"),
      f.execution.withHandoff("thread", Effect.void),
      f.execution.withRuntimeLocation("thread", destination, null, Effect.void),
      f.execution.commit("thread", destination),
      f.execution.followUp("thread", "continue"),
    ])
      assert.isTrue(Exit.isFailure(yield* Effect.exit(operation)));
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.commits, []);
    assert.deepEqual(f.prompts, []);
  }),
);

it.effect("recovery seals admission without asking Core to route or starting execution", () =>
  Effect.gen(function* () {
    const f = yield* harness({
      kind: "acp",
      agentDefinitionId: "external",
      instanceConfigId: null,
    });
    yield* f.execution.setRecoveryRequired("thread", true);
    yield* f.execution.setRecoveryRequired("thread", false);
    assert.deepEqual(f.safety, [
      { provider: "codex", threadId: "thread", required: true },
      { provider: "codex", threadId: "thread", required: false },
    ]);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.commits, []);
    assert.deepEqual(f.prompts, []);
  }),
);

it.effect(
  "routes a bound Runtime Session through its execution owner with stable operation identity",
  () =>
    Effect.gen(function* () {
      const calls: Array<{ kind: string; operationId?: string }> = [];
      const record = (kind: string, operationId?: string) =>
        Effect.sync(() => {
          calls.push({ kind, operationId });
        });
      const port = AgentRuntimeThreadExecution.of({
        owns: () => Effect.succeed(true),
        read: () => record("read").pipe(Effect.as(source)),
        setRecoveryRequired: (_threadId, _required, operationId) => record("recovery", operationId),
        withHandoff: (_threadId, use, operationId) =>
          record("handoff", operationId).pipe(
            Effect.andThen(use),
            Effect.mapError(
              (cause) =>
                new AgentRuntimeThreadExecutionError({
                  operation: "handoff",
                  threadId: "thread",
                  cause,
                }),
            ),
          ),
        stop: () => record("stop"),
        withRuntimeLocation: (_threadId, _location, _preparation, use) =>
          record("location").pipe(Effect.andThen(use)),
        commit: () => record("commit"),
        followUp: (_threadId, _prompt, operationId) =>
          record("follow-up", operationId).pipe(Effect.as(undefined)),
        reconcileRecovery: () => record("reconcile").pipe(Effect.as(undefined)),
      });
      const f = yield* harness({ kind: "claude", instanceConfigId: "work" }, port);
      assert.deepEqual(yield* f.execution.read("thread"), source);
      yield* f.execution.withHandoff("thread", Effect.void, "move");
      yield* f.execution.setRecoveryRequired("thread", true, "move");
      yield* f.execution.stop("thread");
      yield* f.execution.withRuntimeLocation("thread", destination, null, Effect.void);
      yield* f.execution.commit("thread", destination);
      yield* f.execution.followUp("thread", "continue", "move");
      yield* f.execution.reconcileRecovery!([]);
      assert.deepEqual(calls, [
        { kind: "read", operationId: undefined },
        { kind: "handoff", operationId: "move" },
        { kind: "recovery", operationId: "move" },
        { kind: "stop", operationId: undefined },
        { kind: "location", operationId: undefined },
        { kind: "commit", operationId: undefined },
        { kind: "follow-up", operationId: "move" },
        { kind: "reconcile", operationId: undefined },
      ]);
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.safety, []);
    }),
);
