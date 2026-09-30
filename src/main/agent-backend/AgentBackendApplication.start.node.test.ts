// @effect-diagnostics strictEffectProvide:off
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { AgentBackendThreadStartInput } from "../../shared/agent-backend-api";
import type { ProjectSessionThreadLinkInput } from "../../shared/types";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import type { DesktopProjectWorkspaceNativeAgentState } from "../core-client/project-workspace-adapter";
import { ProjectWorkspace, ProjectWorkspaceError } from "../project-application/ProjectWorkspace";
import {
  live as projectLifecycle,
  ProjectRuntimeLifecycleRuntime,
} from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { AgentBackendRegistry } from "./AgentBackendRegistry";
import {
  bindingLayer,
  NativeConversationBinding,
  NativeConversationExtension,
} from "../app-tools/NativeConversationExtension";
import { make, AgentBackendApplicationError } from "./AgentBackendApplication";
import { emptyAgentConversationSnapshot } from "./AgentConversationProjection";
import type { AgentSessionHandle } from "./AgentSessionHandle";
import { NativeSessionWorkspace, type NativeSessionWorkspaceInput } from "./NativeSessionWorkspace";
import { AcpBackendSessionManager } from "./acp/AcpBackendSessionManager";
import { ClaudeSessionManager, type OpenClaudeSessionInput } from "./claude/ClaudeSessionManager";

const binding = { kind: "claude" as const, instanceConfigId: "work" };
const startInput: AgentBackendThreadStartInput = {
  sessionId: "draft",
  backendKind: "claude",
  instanceConfigId: "work",
  runInTarget: "newWorktree",
  runInEnvironmentPath: ".codex/environments/setup.toml",
  worktreeStartingState: { type: "working-tree" },
  prompt: "Continue in the selected workspace",
  firstSubmission: {
    launchId: "01991e60-b800-7000-8000-000000000011",
    clientUserMessageId: "01991e60-b800-7000-8000-000000000012",
  },
};

const fixture = (environmentPath: string) =>
  Effect.gen(function* () {
    const lifecycle = Context.get(
      yield* Layer.buildWithScope(projectLifecycle, yield* Scope.Scope),
      ProjectRuntimeLifecycleRuntime,
    );
    const events: string[] = [];
    const prepared: NativeSessionWorkspaceInput[] = [];
    const opened: OpenClaudeSessionInput[] = [];
    const admissionStarted = yield* Deferred.make<void>();
    const releaseAdmission = yield* Deferred.make<void>();
    let pauseAdmission = false;
    let projectActive = true;
    let archiveDuringPreparation = false;
    let commitOutcome: "rejected" | "committed" | "uncertain" | "relocated" | null = null;
    let failReconciliation = false;
    let linked: ProjectSessionThreadLinkInput | null = null;
    let live: AgentSessionHandle | null = null;
    let durable: {
      threadId: string;
      backendBinding: typeof binding;
      backendSessionId: string;
      nativeHome?: string;
      nativeState?: DesktopProjectWorkspaceNativeAgentState;
    } | null = null;
    const sourceRoots = ["/source", "/additional"];
    const worktreeRoots = ["/managed/work", "/additional", "/source/.git"];
    const application = yield* make.pipe(
      Effect.provideService(NativeSessionWorkspace, {
        prepare: (input) =>
          Effect.gen(function* () {
            prepared.push(input);
            events.push("prepare");
            if (archiveDuringPreparation) projectActive = false;
            let attached = false;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                if (!attached) events.push("cleanup");
              }),
            );
            return {
              location: {
                cwd: "/managed/work",
                workspaceRoots: worktreeRoots,
                managedWorktreePath: "/managed/work",
                projectlessOutputDirectory: null,
                projectlessWorkspaceBrowserRoot: null,
              },
              retain: Effect.sync(() => {
                attached = true;
                events.push("retain");
              }),
              attach: () =>
                Effect.sync(() => {
                  attached = true;
                  events.push("attach");
                }),
            };
          }),
      }),
      Effect.provideService(CodexGitProbe, {
        readPath: () => Effect.succeed(environmentPath),
        isNonGitWorkspace: () => Effect.succeed(false),
        isNonGitWorkspaceOnHost: () => Effect.succeed(false),
      }),
      Effect.provideService(AgentBackendRegistry, {
        resolve: () =>
          Effect.succeed({ kind: "claude", binding, displayName: "Claude", instance: {} as never }),
        resolveAcpInstance: () => Effect.die("Unexpected ACP launch"),
      }),
      Effect.provideService(ClaudeSessionManager, {
        nativeHome: () => Effect.succeed("/native-home"),
        nativeCatalog: () => Effect.die("Unexpected native listing"),
        nativeSessionInfo: () => Effect.die("Unexpected native lookup"),
        open: (input) =>
          Effect.gen(function* () {
            opened.push(input);
            events.push("open");
            const snapshot = yield* SubscriptionRef.make(
              emptyAgentConversationSnapshot({
                backend: "claude",
                threadId: input.threadId,
                sessionId: input.sessionId ?? "native-session",
              }),
            );
            const handle: AgentSessionHandle = {
              threadId: input.threadId,
              sessionId: input.sessionId ?? "native-session",
              snapshot,
              capabilities: {} as never,
              configOptions: [],
              modes: null,
              setMode: () => Effect.void,
              setConfigOption: () => Effect.succeed([]),
              cancel: Effect.void,
              prompt: () => Effect.succeed({ stopReason: "end_turn" }),
              setIntelligence: () => Effect.void,
              setPermissionPolicy: () => Effect.void,
              respond: () => Effect.void,
            };
            live = handle;
            return handle;
          }),
        get: () => Effect.succeed(live),
        close: () => Effect.sync(() => (live = null)).pipe(Effect.asVoid),
        observe: () => Effect.void,
        unobserve: () => Effect.void,
        changes: Stream.empty,
        models: () => Effect.die("Unexpected model discovery"),
        discover: () => Effect.die("Unexpected native discovery"),
      }),
      Effect.provideService(AcpBackendSessionManager, {
        get: () => Effect.succeed(null),
        open: () => Effect.die("Unexpected ACP launch"),
        close: () => Effect.void,
        observe: () => Effect.void,
        unobserve: () => Effect.void,
        changes: Stream.empty,
      } as never),
      Effect.provideService(ProjectWorkspace, {
        getProjectSession: () =>
          failReconciliation
            ? Effect.fail(
                new ProjectWorkspaceError({
                  operation: "session.read",
                  cause: new Error("read failed"),
                }),
              )
            : Effect.succeed({ id: "draft", projectId: "project", thread: linked }),
        getProject: () =>
          Effect.succeed({
            id: "project",
            lifecycle: projectActive ? "active" : "archived",
            primaryWorkspaceRoot: "/source",
            sources: sourceRoots.map((root, order) => ({ root, order })),
          }),
        getThread: () => Effect.succeed(linked),
        upsertProjectSessionThreadLink: (input: ProjectSessionThreadLinkInput) =>
          Effect.gen(function* () {
            if (pauseAdmission) {
              yield* Deferred.succeed(admissionStarted, undefined);
              yield* Deferred.await(releaseAdmission);
            }
            if (commitOutcome === "rejected")
              return yield* new ProjectWorkspaceError({
                operation: "session.thread.link",
                cause: new Error("Core rejected the link"),
                threadAdmissionOutcome: "rejected",
              });
            if (commitOutcome === "uncertain") {
              failReconciliation = true;
              return yield* new ProjectWorkspaceError({
                operation: "session.thread.link",
                cause: new Error("Core disconnected while committing"),
                threadAdmissionOutcome: "uncertain",
              });
            }
            linked = input;
            events.push("link");
            if (commitOutcome === "relocated") {
              linked = { ...input, cwd: "/changed/work", managedWorktreePath: "/changed/work" };
              return linked;
            }
            if (commitOutcome === "committed")
              return yield* new ProjectWorkspaceError({
                operation: "session.thread.link",
                cause: new Error("Readback failed after Core committed"),
                threadAdmissionOutcome: "committed",
              });
            return input;
          }),
        readProjectPermissionMode: () => Effect.succeed("auto"),
        readProjectlessPermissionMode: Effect.succeed("auto"),
        readThreadExecutionContext: () =>
          Effect.succeed({
            projectId: "project",
            writableRoots: linked?.runtimeWorkspaceRoots ?? [],
            workspaceState: null,
          }),
        readThreadBackendSession: () => Effect.succeed(durable),
        bindThreadBackendSession: (input: NonNullable<typeof durable>) =>
          Effect.sync(() => {
            durable = { ...durable, ...input };
          }),
        updateThread: () => Effect.succeed(linked),
      } as never),
      Effect.provideService(ProjectRuntimeLifecycleRuntime, lifecycle),
    );
    return {
      application,
      prepared,
      opened,
      events,
      linked: () => linked,
      pauseAdmission: () => {
        pauseAdmission = true;
      },
      admissionStarted,
      releaseAdmission,
      archiveDuringPreparation: () => {
        archiveDuringPreparation = true;
      },
      failCommit: (outcome: NonNullable<typeof commitOutcome>) => {
        commitOutcome = outcome;
      },
    };
  });

it.effect(
  "new native chats bind the selected worktree before launching and reload its environment",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-native-launch-"))),
          (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
        );
        const environmentPath = path.join(directory, "codex-shell-environment.json");
        yield* Effect.promise(() =>
          writeFile(
            environmentPath,
            JSON.stringify({ version: 1, set: { READY: "first" }, exclude: [] }),
          ),
        );
        const f = yield* fixture(environmentPath);
        const result = yield* f.application.startAgentThread(startInput);
        assert.deepEqual(f.prepared[0]?.worktreeStartingState, { type: "working-tree" });
        assert.equal(f.prepared[0]?.localEnvironmentConfigPath, ".codex/environments/setup.toml");
        assert.equal(result.thread.cwd, "/managed/work");
        assert.equal(result.thread.managedWorktreePath, "/managed/work");
        assert.deepEqual(f.linked()?.runtimeWorkspaceRoots, [
          "/managed/work",
          "/additional",
          "/source/.git",
        ]);
        assert.deepEqual(f.events.slice(0, 4), ["prepare", "link", "attach", "open"]);
        assert.equal(f.opened[0]?.workspaceRoot, "/managed/work");
        assert.equal(f.opened[0]?.workspaceEnvironment?.set.READY, "first");
        yield* f.application.closeAgentSession(result.thread.threadId);
        yield* Effect.promise(() =>
          writeFile(
            environmentPath,
            JSON.stringify({ version: 1, set: { READY: "reopened" }, exclude: [] }),
          ),
        );
        yield* f.application.openAgentSession({ threadId: result.thread.threadId });
        assert.equal(f.opened[1]?.sessionId, "native-session");
        assert.equal(f.opened[1]?.workspaceEnvironment?.set.READY, "reopened");
        assert.notInclude(f.events, "cleanup");
      }),
    ),
);

it.effect("cancelling Core admission cannot delete a worktree once its Thread was committed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture("/tmp/nodex-missing-worktree-environment.json");
      f.pauseAdmission();
      const start = yield* f.application.startAgentThread(startInput).pipe(Effect.forkChild);
      yield* Deferred.await(f.admissionStarted);
      const interruption = yield* Fiber.interrupt(start).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(f.releaseAdmission, undefined);
      yield* Fiber.join(interruption);
      const exit = start.pollUnsafe()!;
      assert.isTrue(Exit.isFailure(exit));
      assert.isNotNull(f.linked());
      assert.deepEqual(f.events, ["prepare", "link", "attach"]);
      assert.lengthOf(f.opened, 0);
    }),
  ),
);

it.effect("a changed Project rejects admission and cleans the prepared native workspace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture("/tmp/nodex-missing-worktree-environment.json");
      f.archiveDuringPreparation();
      const failure = yield* f.application.startAgentThread(startInput).pipe(Effect.flip);
      assert.equal(failure.operation, "thread.start.admit");
      assert.isNull(f.linked());
      assert.deepEqual(f.events, ["prepare", "cleanup"]);
      assert.lengthOf(f.opened, 0);
    }),
  ),
);

it.effect(
  "a committed link survives readback failure and an unknown Core reply retains its workspace",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const outcome of ["committed", "uncertain", "rejected"] as const) {
          const f = yield* fixture("/tmp/nodex-missing-worktree-environment.json");
          f.failCommit(outcome);
          yield* f.application.startAgentThread(startInput).pipe(Effect.flip);
          assert.lengthOf(f.opened, 0);
          if (outcome === "rejected") {
            assert.include(f.events, "cleanup");
            assert.notInclude(f.events, "retain");
            continue;
          }
          assert.include(f.events, "retain");
          assert.notInclude(f.events, "cleanup");
          if (outcome === "committed") {
            assert.isNotNull(f.linked());
            assert.include(f.events, "attach");
          } else {
            assert.isNull(f.linked());
            assert.notInclude(f.events, "attach");
          }
        }
      }),
    ),
);

it.effect(
  "a changed execution location cannot publish stale worktree ownership or launch Claude",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture("/tmp/nodex-missing-worktree-environment.json");
        f.failCommit("relocated");
        const failure = yield* f.application.startAgentThread(startInput).pipe(Effect.flip);
        assert.equal(failure.operation, "thread.start.admit");
        assert.deepEqual(f.events, ["prepare", "link", "retain"]);
        assert.lengthOf(f.opened, 0);
      }),
    ),
);

it.effect("unsupported ACP Environments fail before preparing or linking a workspace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture("/tmp/nodex-missing-worktree-environment.json");
      const failure = yield* f.application
        .startAgentThread({ ...startInput, backendKind: "acp" })
        .pipe(Effect.flip);
      assert.equal(failure.operation, "thread.start.environment");
      assert.deepEqual(f.events, []);
      assert.isNull(f.linked());
    }),
  ),
);

it.effect("Claude automations reject local Environments before saving an unusable launch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bindingContext = yield* Layer.buildWithScope(bindingLayer, yield* Scope.Scope);
      yield* fixture("/tmp/nodex-missing-worktree-environment.json").pipe(
        Effect.provideService(
          NativeConversationBinding,
          Context.get(bindingContext, NativeConversationBinding),
        ),
      );
      const native = Context.get(bindingContext, NativeConversationExtension);
      const definition = {
        backendBinding: binding,
        model: null,
        reasoningEffort: null,
        serviceTier: null,
        executionEnvironment: "local" as const,
        localEnvironmentConfigPath: ".codex/environments/setup.toml",
      };
      const rejected = yield* native.validateAutomation(definition).pipe(Effect.flip);
      assert.instanceOf(rejected, AgentBackendApplicationError);
      const validationError = rejected as AgentBackendApplicationError;
      assert.equal(validationError.operation, "automation.validate");
      assert.instanceOf(validationError.cause, AgentBackendApplicationError);
      assert.equal(
        (validationError.cause as AgentBackendApplicationError).operation,
        "automation.settings",
      );
      yield* native.validateAutomation({ ...definition, executionEnvironment: "worktree" });
    }),
  ),
);
