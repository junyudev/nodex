import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import { NativeConversationExtension } from "../app-tools/NativeConversationExtension";
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

const harness = (backendBinding: AgentBackendBinding) =>
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
    const native = NativeConversationExtension.of({
      setExecutionRecoveryRequired: (threadId, required) =>
        Effect.sync(() => {
          safety.push({ provider: "claude", threadId, required });
        }),
      read: () => Effect.succeed(null),
      submit: (input) =>
        Effect.sync(() => {
          prompts.push(input);
          calls.push("claude:follow-up");
          return { turnId: "turn" };
        }),
      wait: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      stopExecution: () => record("claude:stop"),
      withExecutionHandoff: (_threadId, use) => record("claude:handoff").pipe(Effect.andThen(use)),
      withExecutionLocation: (_threadId, _location, use) =>
        record("claude:switch").pipe(Effect.andThen(use)),
      createAutomationSession: () => Effect.die("unused"),
      validateAutomation: () => Effect.die("unused"),
    });
    const workspace = {
      getThread: () => Effect.succeed(authority),
      readThreadExecutionContext: () =>
        Effect.succeed({ projectId: authority.projectId, writableRoots: source.workspaceRoots }),
      setThreadExecutionLocation: (threadId: string, location: unknown) =>
        Effect.sync(() => {
          commits.push({ threadId, location });
          return authority;
        }),
    } as unknown as ProjectWorkspace["Service"];
    const execution = yield* make.pipe(
      Effect.provideService(ProjectWorkspace, workspace),
      Effect.provideService(CodexThreadExecution, codex),
      Effect.provideService(NativeConversationExtension, native),
    );
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

it.effect("selects execution from the current durable backend for every operation", () =>
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
    f.calls.length = 0;
    f.change({ backendBinding: { kind: "claude", instanceConfigId: "work" } });
    assert.deepEqual(yield* f.execution.read("thread", "local"), source);
    assert.strictEqual(
      yield* f.execution.withHandoff("thread", Effect.succeed("native")),
      "native",
    );
    yield* f.execution.stop("thread");
    yield* f.execution.withRuntimeLocation("thread", destination, null, Effect.void);
    yield* f.execution.commit("thread", destination);
    yield* f.execution.followUp("thread", "continue natively");
    assert.deepEqual(f.calls, [
      "claude:handoff",
      "claude:stop",
      "claude:switch",
      "claude:follow-up",
    ]);
    assert.deepEqual(f.commits, [
      {
        threadId: "thread",
        location: {
          executionHostId: "local",
          cwd: destination.cwd,
          managedWorktreePath: destination.managedWorktreePath,
          runtimeWorkspaceRoots: destination.workspaceRoots,
          projectlessOutputDirectory: null,
          projectlessWorkspaceBrowserRoot: null,
        },
      },
    ]);
    assert.strictEqual(f.prompts[0]?.threadId, "thread");
    assert.strictEqual(f.prompts[0]?.prompt, "continue natively");
    assert.isNotEmpty(f.prompts[0]?.operationId);
  }),
);

it.effect("rejects native host and Project changes before runtime or durable mutation", () =>
  Effect.gen(function* () {
    const f = yield* harness({ kind: "claude", instanceConfigId: "work" });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(f.execution.read("thread", "remote"))));
    for (const invalid of [
      { ...destination, hostId: "remote" },
      { ...destination, projectId: "other" },
      { ...destination, cwd: "relative" },
    ])
      assert.isTrue(Exit.isFailure(yield* Effect.exit(f.execution.commit("thread", invalid))));
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          f.execution.withRuntimeLocation(
            "thread",
            { ...destination, hostId: "remote" },
            null,
            Effect.void,
          ),
        ),
      ),
    );
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.commits, []);
    f.change({ executionHostId: "remote" });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(f.execution.read("thread"))));
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
      { provider: "claude", threadId: "thread", required: true },
      { provider: "codex", threadId: "thread", required: false },
      { provider: "claude", threadId: "thread", required: false },
    ]);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.commits, []);
    assert.deepEqual(f.prompts, []);
  }),
);
