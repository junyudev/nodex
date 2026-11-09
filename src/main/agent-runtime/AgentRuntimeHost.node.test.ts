import { assert, it } from "@effect/vitest";
import type {
  AgentHostNativeSessionIdentity,
  AgentHostToolIdentity,
  AgentHostTurnIdentity,
  AgentHostRequest,
  AgentRuntimeMethod,
  AgentRuntimeOperations,
} from "@nodex/agent-runtime/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { MainConfig } from "../app/MainConfig";
import type { ProjectWorkspaceApplyInput, ProjectWorkspaceRead } from "../core-client/types";
import type {
  AgentRuntimeProcessConnection,
  AgentRuntimeProcessDelivery,
} from "../platform/node/AgentRuntimeProcess";
import {
  captureHostedAppToolAuthority,
  readHostedAppToolSessionContext,
  type AppToolCaller,
} from "../app-tools/AppToolCaller";
import { resolveAppToolCallingSession } from "../app-tools/AppToolCallingSession";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { make } from "./AgentRuntimeHost";
import {
  COORDINATOR_INSTRUCTIONS,
  MANAGED_SESSION_INSTRUCTIONS,

const frame = {
  runtimeId: "runtime",
  runtimeGeneration: "lease",
  projectId: "engine-project",
  threadId: "thread:child",
  providerInstanceId: "acp",
  providerSessionId: "provider-session",
  providerThreadId: "provider-thread",
  nativeGeneration: 1,
  nativeThreadRef: { driver: "acpRegistry", nativeId: "native-session", strength: "strong" },
  cwd: "/worktree",
} as const;
const actor = (incarnationId = "incarnation:one"): AgentHostNativeSessionIdentity => ({
  ...frame,
  source: "native-session",
  runId: null,
  attemptId: null,
  incarnationId,
});
const turn = (runId = "run:one"): AgentHostTurnIdentity => ({
  ...frame,
  runId,
  attemptId: `attempt:${runId}`,
});
const request = (identity: AgentHostToolIdentity = actor(), id = "request"): AgentHostRequest => ({
  type: "host.request",
  id,
  operation: "tool.call",
  tool: "get_session_context",
  input: {},
  identity,
});
const proofOf = (identity: AgentHostTurnIdentity | AgentHostNativeSessionIdentity) => ({
  ...identity,
  rootThreadId: "thread:root",
  admittedAtMs: identity.runId === null ? 2_000 : 1_000,
  status: (identity.runId === null ? null : "running") as string | null,
  userMessageId: "message",
  archived: false,
  nativeTurnId: null,
  branch: null,
  worktreePath: null,
  hasNativeBackgroundWork: false,
});

const desktopTools = {
  server: {
    command: "/desktop/node",
    args: ["signed-launcher"],
    env: { CODEX_HOME: "/desktop/codex" },
  },
  pluginRoots: ["/materialized/browser"],
};

const fixture = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<AgentRuntimeProcessDelivery>();
  const ended = yield* Deferred.make<never>();
  const calls: AgentRuntimeMethod[] = [];
  const coreReads: ProjectWorkspaceRead[] = [];
  const coreWrites: ProjectWorkspaceApplyInput[] = [];
  const attributions: { session_id: string; backend: string }[] = [];
  const live = new Map<string, ReturnType<typeof proofOf>>();
  const bind = (identity: AgentHostTurnIdentity | AgentHostNativeSessionIdentity) =>
    live.set(identity.runId ?? identity.incarnationId, proofOf(identity));
  bind(actor());
  bind(turn());
  let attributionUnavailable = false;
  let caller: AppToolCaller | undefined;
  let bound = true;
  let coordinatorId: string | null = null;
  let managed = false;
  let boundProjectId: string | null = "current-project";
  const projectSources = new Map<string, readonly string[]>([
    ["current-project", ["/project/frontend", "/project/backend"]],
  ]);
  const desktopCalls: unknown[] = [];
  let desktopToolsFailure = false;
  let desktopToolsAvailable = true;
  let desktopPreparations = 0;
  const connection: AgentRuntimeProcessConnection = {
    identity: {
      runtimeId: "runtime",
      runtimeGeneration: "lease",
      schemaVersion: 1,
      databasePath: "/runtime.sqlite",
      mcpEndpoint: "http://localhost:1/mcp",
      lastSequence: 0,
    },
    terminated: Deferred.await(ended),
    notifications: Stream.fromPubSub(events),
    subscribeNotifications: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
    responsive: Stream.make(true),
    subscribeExecutionNotifications: PubSub.subscribe(events).pipe(
      Effect.map(Stream.fromSubscription),
    ),
    request: <M extends AgentRuntimeMethod>(method: M, input: AgentRuntimeOperations[M]["input"]) =>
      Effect.sync(() => {
        calls.push(method);
        if (method === "native-session.authority")
          return (live.get(
            (input as AgentRuntimeOperations["native-session.authority"]["input"]).incarnationId,
          ) ?? null) as AgentRuntimeOperations[M]["output"];
        if (method === "thread.authority")
          return (live.get((input as AgentRuntimeOperations["thread.authority"]["input"]).runId) ??
            null) as AgentRuntimeOperations[M]["output"];
        if (method === "thread.run-message")
          return {
            id: "message",
            text: "Original inbound words",
            attachments: [],
            createdBy: "user",
          } as AgentRuntimeOperations[M]["output"];
        throw new Error(`Unexpected runtime request ${method}`);
      }),
  };
  const read = (input: ProjectWorkspaceRead) =>
    Effect.sync(() => {
      coreReads.push(input);
      if (input.kind === "effective_execution_hold")
        return { value: { kind: input.kind, holds: [] } };
      if (input.kind === "read_coordinator")
        return { value: { kind: input.kind, session_id: coordinatorId } };
      if (input.kind === "read_managed_session")
        return { value: { kind: input.kind, managed: managed ? { session_id: "session" } : null } };
      if (input.kind === "project")
        return {
          value: {
            kind: "project",
            project: {
              sources: (projectSources.get(input.project_id) ?? []).map((root) => ({ root })),
            },
          },
        };
      if (input.kind !== "agent_runtime_session_binding_by_execution")
        throw new Error(`Unexpected Core read ${input.kind}`);
      assert.equal(input.runtime_thread_id, "thread:root");
      return {
        value: {
          kind: "agent_runtime_session_binding",
          binding: bound
            ? {
                session_id: "session",
                project_id: boundProjectId,
                runtime_id: "runtime",
                runtime_thread_id: "thread:root",
                launch_request_id: "launch",
                bound_at: "2026-10-14T00:00:00Z",
              }
            : null,
        },
      };
    });
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const execute = yield* make(connection, {
    projectlessId: "projectless",
    providers: {
      acp: { driver: "acpRegistry", config: {} },
      claude: { driver: "claudeAgent", config: {} },
      codex: { driver: "codex", config: {} },
    },
    workspaceEnvironment: (cwd) =>
      Effect.succeed(
        cwd === "/worktree" ? { set: { WORKTREE_READY: "prepared" }, exclude: ["NODE_ENV"] } : null,
      ),
    desktop: {
      desktopTools: Effect.suspend(() => {
        desktopPreparations++;
        if (desktopToolsFailure) return Effect.fail(new Error("secret launch environment"));
        return Effect.succeed(desktopToolsAvailable ? desktopTools : null);
      }),
      threadConfig: (cwd) => Effect.succeed({ "mcp_servers.node_repl": { cwd } }),
      observeNativeTurn: (turn) =>
        Effect.sync(() => {
          desktopCalls.push(turn);
        }),
    },
    execute: (captured) => {
      caller = captured;
      return Effect.succeed({ content: [] });
    },
  }).pipe(
    Scope.provide(scope),
    Effect.provideService(CoreModules, {
      workspace: {
        read,
        apply: (input: ProjectWorkspaceApplyInput) =>
          Effect.sync(() => {
            coreWrites.push(input);
            return {};
          }),
          Effect.suspend(() => {
            if (attributionUnavailable)
              return coreRuntimeError({
                operation: "workspace.issueAgentAttribution",
                reason: "operation",
                retryable: false,
                cause: new Error("Credential unavailable"),
              });
            return Effect.sync(() => {
              attributions.push(input);
              return `credential:${input.session_id}`;
            });
          }),
      },
    } as never),
    Effect.provideService(CoreAuthority, {
      identity: { profileId: "profile", libraryId: "library", storeEpoch: "epoch" },
    } as never),
    Effect.provideService(MainConfig, {} as never),
  );
  return {
    execute,
    desktopCalls,
    desktopPreparations: () => desktopPreparations,
    failDesktopTools: () => {
      desktopToolsFailure = true;
    },
    disableDesktopTools: () => {
      desktopToolsAvailable = false;
    },
    calls,
    coreReads,
    coreWrites,
    attributions,
    failAttribution: () => {
      attributionUnavailable = true;
    },
    live,
    bind,
    caller: () => caller!,
    moveToProject: (projectId: string | null) => {
      boundProjectId = projectId;
    },
    setProjectSources: (projectId: string, roots: readonly string[]) => {
      projectSources.set(projectId, roots);
    },
    setCoordinator: (id: string | null) => {
      coordinatorId = id;
    },
    setManaged: (value: boolean) => {
      managed = value;
    },
    unbind: () => {
      bound = false;
    },
    close: Scope.close(scope, Exit.void),
  };
});

const prepareTurn = (identity = turn()): AgentHostRequest => ({
  type: "host.request",
  id: "prepare",
  operation: "turn.prepare",
  identity,
});

it.effect("a delegated Turn receives its bound Project's current Sources", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    assert.deepInclude(yield* f.execute(prepareTurn()), {
      sourceRoots: ["/project/frontend", "/project/backend"],
    });
    assert.deepEqual(
      f.coreReads.filter((read) => read.kind === "project"),
      [{ kind: "project", project_id: "current-project" }],
    );

    f.setProjectSources("current-project", ["/project/frontend", "/project/shared"]);
    assert.deepInclude(yield* f.execute(prepareTurn()), {
      sourceRoots: ["/project/frontend", "/project/shared"],
    });

    f.setProjectSources("destination-project", ["/destination/source"]);
    f.moveToProject("destination-project");
    assert.deepInclude(yield* f.execute(prepareTurn()), {
      sourceRoots: ["/destination/source"],
    });
    assert.deepEqual(f.coreReads.filter((read) => read.kind === "project").at(-1), {
      kind: "project",
      project_id: "destination-project",
    });
  }).pipe(Effect.scoped),
);

it.effect("a projectless Turn contributes no Project directory scope", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.moveToProject(null);
    assert.deepInclude(yield* f.execute(prepareTurn()), { sourceRoots: [] });
    assert.isFalse(f.coreReads.some((read) => read.kind === "project"));
  }).pipe(Effect.scoped),
);

it.effect("a Turn's CLI is vouched for as its own Session's Agent", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.execute(prepareTurn());
    assert.deepEqual(f.attributions, [
    ]);
  }).pipe(Effect.scoped),
);

it.effect("a Run call carries engine coordinates, its bound Session, and the Run start time", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.execute(request(turn()));
    const authority = yield* captureHostedAppToolAuthority(f.caller());
    assert.deepEqual(authority, {
      threadId: "thread:child",
      turnId: "run:one",
      rootThreadId: "thread:root",
      actorProjectId: "current-project",
      libraryId: "library",
      storeEpoch: "epoch",
      admittedAtMs: 1_000,
      runtime: { sessionId: "session", runtimeId: "runtime", turnKind: "run" },
    });
    assert.deepEqual(toCoreAgentTurnProvenance("profile", authority!).authority.runtime, {
      session_id: "session",
      runtime_id: "runtime",
      turn_kind: "run",
    });
    assert.deepEqual(f.coreWrites, []);
    f.live.delete("run:one");
    assert.isNull(yield* captureHostedAppToolAuthority(f.caller()));
    yield* Effect.flip(f.execute(request(turn())));
    f.live.set("run:cancelled", { ...proofOf(turn("run:cancelled")), status: "cancelled" });
    yield* Effect.flip(f.execute(request(turn("run:cancelled"))));
    assert.deepEqual(f.coreWrites, []);
  }).pipe(Effect.scoped),
);

it.effect("ACP calls name the bound Session without reading or inventing a Run", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.execute(request());
    assert.deepEqual(readHostedAppToolSessionContext(f.caller()), {
      sessionId: "session",
      projectId: "current-project",
      runtimeId: "runtime",
      rootThreadId: "thread:root",
      threadId: "thread:child",
      runId: null,
      cwd: "/worktree",
    });
    const calling = yield* resolveAppToolCallingSession(f.caller(), {
      getThread: () => Effect.die("Legacy Thread lookup"),
    });
    assert.equal(calling?.sessionId, "session");
    assert.isNull(calling?.runId);
    assert.notInclude(f.calls, "thread.authority");
    const authority = yield* captureHostedAppToolAuthority(f.caller());
    assert.equal(authority?.turnId, "incarnation:one");
    assert.equal(authority?.admittedAtMs, 2_000);
    assert.deepEqual(authority?.runtime?.turnKind, "native_connection");
    f.live.delete("incarnation:one");
    f.bind(actor("incarnation:next"));
    assert.isNull(yield* captureHostedAppToolAuthority(f.caller()));
    yield* Effect.flip(f.execute(request()));
    yield* f.execute(request(actor("incarnation:next")));
    assert.isNotNull(yield* captureHostedAppToolAuthority(f.caller()));
  }).pipe(Effect.scoped),
);

it.effect("an unbound engine execution cannot acquire product content credentials", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.unbind();
    yield* Effect.flip(f.execute(request()));
    yield* Effect.flip(f.execute(request(turn())));
    assert.deepEqual(f.coreWrites, []);
  }).pipe(Effect.scoped),
);

it.effect("a closed Host scope fences captures taken before it closed", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.execute(request(turn()));
    const captured = f.caller();
    yield* f.close;
    assert.isNull(yield* captureHostedAppToolAuthority(captured));
    yield* Effect.flip(f.execute(request(turn())));
  }).pipe(Effect.scoped),
);

it.effect(
  "native call registration keys identify retries while SDK call IDs alone never deduplicate commands",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const native = { ...actor(), nativeCallId: "tool-use", nativeCallKey: "captured-source-key" };
      yield* f.execute(request(native, "transport:one"));
      assert.equal(f.caller().callId, JSON.stringify(["native", "captured-source-key", null]));
      yield* f.execute(request(native, "transport:retry"));
      assert.equal(f.caller().callId, JSON.stringify(["native", "captured-source-key", null]));
      yield* f.execute(request({ ...native, mcpRequestId: "nested-one" }));
      const nestedFirst = f.caller().callId;
      yield* f.execute(request({ ...native, mcpRequestId: "nested-one" }));
      assert.equal(f.caller().callId, nestedFirst);
      yield* f.execute(request({ ...native, mcpRequestId: "nested-two" }));
      assert.notEqual(f.caller().callId, nestedFirst);
      yield* f.execute(
        request(
          { ...actor(), nativeCallId: "same-sdk-id", mcpClientId: 7, mcpRequestId: "rpc-id" },
          "transport:three",
        ),
      );
      const first = f.caller().callId;
      yield* f.execute(
        request(
          { ...actor(), nativeCallId: "same-sdk-id", mcpClientId: 7, mcpRequestId: "rpc-id" },
          "transport:four",
        ),
      );
      assert.equal(f.caller().callId, first);
      yield* f.execute(
        request({
          ...actor(),
          nativeCallId: "same-sdk-id",
          mcpClientId: 8,
          mcpRequestId: "rpc-id",
        }),
      );
      assert.notEqual(f.caller().callId, first);
    }).pipe(Effect.scoped),
);

const codexTurn = (runId: string): AgentHostTurnIdentity => ({
  ...turn(runId),
  providerInstanceId: "codex",
  nativeThreadRef: { driver: "codex", nativeId: "codex-thread", strength: "strong" },
});
const nativeTurn = (
  identity: AgentHostTurnIdentity,
  phase: "started" | "ended",
): Extract<AgentHostRequest, { operation: "turn.native" }> => ({
  type: "host.request",
  id: `native:${phase}`,
  operation: "turn.native",
  identity,
  nativeTurnId: "native-turn",
  phase,
});
const prepareThread = (
  providerInstanceId: string,
  runtimeGeneration = "lease",
  cwd: string | null = "/worktree",
): AgentHostRequest => ({
  type: "host.request",
  id: "thread",
  operation: "thread.prepare",
  identity: {
    runtimeId: "runtime",
    runtimeGeneration,
    threadId: "thread:child",
    providerInstanceId,
    nativeDriver:
      providerInstanceId === "codex"
        ? "codex"
        : providerInstanceId === "claude"
          ? "claudeAgent"
          : "acpRegistry",
  },
  cwd,
});

it.effect("only the current lease's Codex threads receive the desktop tool config", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    assert.deepEqual(yield* f.execute(prepareThread("codex")), {
      config: { "mcp_servers.node_repl": { cwd: "/worktree" } },
    });
    yield* Effect.flip(f.execute(prepareThread("codex", "previous-lease")));
  }).pipe(Effect.scoped),
);

it.effect("other providers receive the Environment their worktree's setup prepared", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const environment = { set: { WORKTREE_READY: "prepared" }, exclude: ["NODE_ENV"] };
    assert.deepEqual(yield* f.execute(prepareThread("claude")), { environment, desktopTools });
    assert.deepEqual(yield* f.execute(prepareThread("acp")), { environment });
    assert.deepEqual(yield* f.execute(prepareThread("claude", "lease", "/checkout")), {
      desktopTools,
    });
    assert.deepEqual(yield* f.execute(prepareThread("claude", "lease", null)), { desktopTools });
  }).pipe(Effect.scoped),
);

it.effect("a starting Codex Turn names its live Run and Session; ending needs only the lease", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const live = codexTurn("run:codex");
    f.bind(live);
    yield* f.execute(nativeTurn(live, "started"));
    yield* Effect.flip(f.execute(nativeTurn(codexTurn("run:unknown"), "started")));
    f.live.delete("run:codex");
    yield* f.execute(nativeTurn(live, "ended"));
    yield* Effect.flip(f.execute(nativeTurn({ ...live, runtimeGeneration: "old" }, "ended")));
    assert.deepEqual(f.desktopCalls, [
      {
        nativeThreadId: "codex-thread",
        nativeTurnId: "native-turn",
        threadId: "thread:child",
        runId: "run:codex",
        sessionId: "session",
        projectId: "current-project",
        phase: "started",
      },
      { nativeThreadId: "codex-thread", nativeTurnId: "native-turn", phase: "ended" },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("standing instructions follow the verified Session role on each turn", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const prepare = Effect.gen(function* () {
      const response = yield* f.execute(prepareTurn());
      return (response as { instructions: string }).instructions;
    });
    assert.notInclude(yield* prepare, COORDINATOR_INSTRUCTIONS);
    assert.notInclude(yield* prepare, MANAGED_SESSION_INSTRUCTIONS);
    f.setCoordinator("another-session");
    f.setManaged(true);
    assert.include(yield* prepare, MANAGED_SESSION_INSTRUCTIONS);
    assert.notInclude(yield* prepare, COORDINATOR_INSTRUCTIONS);
    f.setManaged(false);
    f.setCoordinator("session");
    assert.include(yield* prepare, COORDINATOR_INSTRUCTIONS);
    assert.notInclude(yield* prepare, MANAGED_SESSION_INSTRUCTIONS);
  }).pipe(Effect.scoped),
);

it.effect("binds the managed Run to its proved inbound before tools execute", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.setManaged(true);
    yield* f.execute(prepareTurn());
    const binding = f.coreWrites.find((input) => input.intent.kind === "bind_chat_inbound")?.intent;
    assert.equal(binding?.kind, "bind_chat_inbound");
    if (binding?.kind !== "bind_chat_inbound") throw new Error("No inbound binding");
    assert.equal(binding.delivery_id, "message");
    assert.equal(binding.run_id, "run:one");
    yield* f.execute(request(turn()));
    assert.equal(readHostedAppToolSessionContext(f.caller()!)?.inboundMessageId, "message");
  }),
);

it.effect("credential failure refuses Agent preparation before exposing CLI access", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.failAttribution();
    const result = yield* Effect.result(f.execute(prepareTurn()));
    assert.equal(result._tag, "Failure");
    assert.isEmpty(f.attributions);
  }),
);

it.effect("Claude desktop preparation requires both driver identities and the current lease", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.flip(f.execute(prepareThread("claude", "old-lease")));
    const mismatched = prepareThread("acp");
    if (mismatched.operation !== "thread.prepare") throw new Error("expected preparation");
    yield* f.execute({
      ...mismatched,
      identity: { ...mismatched.identity, nativeDriver: "claudeAgent" },
    });
    const claude = prepareThread("claude");
    if (claude.operation !== "thread.prepare") throw new Error("expected preparation");
    yield* f.execute({ ...claude, identity: { ...claude.identity, nativeDriver: "codex" } });
    assert.equal(f.desktopPreparations(), 0);
    yield* f.execute(claude);
    assert.equal(f.desktopPreparations(), 1);
  }).pipe(Effect.scoped),
);

it.effect(
  "failed Claude desktop preparation retains the workspace Environment and logs no launch values",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const logs: unknown[] = [];
      f.failDesktopTools();
      const result = yield* f.execute(prepareThread("claude")).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((entry) => {
              logs.push(entry.message);
            }),
          ]),
        ),
      );
      assert.deepEqual(result, {
        environment: { set: { WORKTREE_READY: "prepared" }, exclude: ["NODE_ENV"] },
      });
      assert.deepEqual(logs, [["Desktop tools are unavailable for a Claude thread"]]);
    }).pipe(Effect.scoped),
);

it.effect("unavailable Claude desktop tools do not change Environment preparation", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.disableDesktopTools();
    assert.deepEqual(yield* f.execute(prepareThread("claude")), {
      environment: { set: { WORKTREE_READY: "prepared" }, exclude: ["NODE_ENV"] },
    });
    assert.deepEqual(yield* f.execute(prepareThread("claude", "lease", null)), {});
  }).pipe(Effect.scoped),
);

it.effect("Claude native Turns retain start authorization and lease-only completion", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const identity: AgentHostTurnIdentity = {
      ...turn("run:claude"),
      providerInstanceId: "claude",
      nativeThreadRef: {
        driver: "claudeAgent",
        nativeId: "c40ae828-c6b0-47fe-b5a4-eaf624a1f9f4",
        strength: "strong",
      },
    };
    const started = {
      ...nativeTurn(identity, "started"),
      nativeTurnId: "turn:attempt:claude",
    } as const;
    yield* Effect.flip(f.execute(started));
    f.bind(identity);
    yield* f.execute(started);
    f.live.delete("run:claude");
    const ended = {
      ...nativeTurn(identity, "ended"),
      nativeTurnId: "turn:attempt:claude",
    } as const;
    yield* f.execute(ended);
    yield* Effect.flip(
      f.execute({ ...ended, identity: { ...identity, runtimeGeneration: "old" } }),
    );
    assert.deepEqual(f.desktopCalls, [
      {
        nativeThreadId: identity.nativeThreadRef!.nativeId,
        nativeTurnId: "turn:attempt:claude",
        threadId: identity.threadId,
        runId: identity.runId,
        sessionId: "session",
        projectId: "current-project",
        phase: "started",
      },
      {
        nativeThreadId: identity.nativeThreadRef!.nativeId,
        nativeTurnId: "turn:attempt:claude",
        phase: "ended",
      },
    ]);
  }).pipe(Effect.scoped),
);
