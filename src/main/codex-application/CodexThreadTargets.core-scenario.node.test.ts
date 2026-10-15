import { expect, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import {
  withCoreScenario,
  type CoreScenarioContext,
} from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { IpcApi } from "../../shared/ipc-api";
import { CoreModules, live as coreModulesLive } from "../core-runtime/CoreModules";
import { CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { classifyCoreOperationFailure } from "../core-runtime/CoreRuntimeError";
import { makeTestElectronIpc } from "../platform/electron/ElectronIpc.test-support";
import { registerCodexThreadTargetEndpoints } from "../ipc/handlers/codex-thread-target-endpoints";
import { CodexClientThreadIdentity } from "./CodexClientThreadIdentity";
import { CodexPendingWorktreeRuntime } from "./CodexPendingWorktreeRuntime";
import { CodexThreadTargets, type CodexThreadTargetError } from "./CodexThreadTargets";
import { make as makeResolution } from "./CodexCreatedThreadResolution";
import { makeTargetFixture, targetThread } from "./CodexThreadTargets.test-support";
import * as Stream from "effect/Stream";
import { make as makeInternalRegistry } from "./CodexInternalThreadRegistry";
import { CodexInternalThreadRegistry } from "./CodexInternalThreadRegistry";
import { make as makeSidebar } from "./CodexSidebarSyncRuntime";
import { make as makeCatalog } from "./CodexThreadCatalog";
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { projectCoreWorkspaceThread } from "./CodexThreadDirectoryProjection";
import { buildWorkspaceThreadSummary } from "./CodexThreadCatalogProjection";
import { ScopedCallbackRuntime, layer as callbackLayer } from "../app/ScopedCallbackRuntime";
import { prepareCreatedThreadNavigation } from "../../renderer/lib/created-thread-navigation";

type TargetChannel =
  | "codex:thread:ensure-open"
  | "codex:thread:child-summary"
  | "codex:created-thread:resolve";
type TargetHandler = (
  event: IpcMainInvokeEvent,
  input: IpcApi[TargetChannel]["args"][0],
) => Effect.Effect<IpcApi[TargetChannel]["result"], CodexThreadTargetError>;

class CodexTargetScenarioError extends Data.TaggedError("CodexTargetScenarioError")<{
  readonly cause: unknown;
}> {}
const acquireScenario = Effect.acquireRelease(
  Effect.callback<
    { client: CoreScenarioContext["client"]; release: () => void; completed: Promise<void> },
    CodexTargetScenarioError
  >((resume) => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completed = withCoreScenario(
      { scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID },
      async ({ client }) => {
        resume(Effect.succeed({ client, release, completed }));
        await released;
      },
    );
    void completed.catch((cause) => resume(Effect.fail(new CodexTargetScenarioError({ cause }))));
  }),
  ({ release, completed }) =>
    Effect.promise(() => {
      release();
      return completed;
    }),
);

it.effect(
  "explicit target IPC crosses the real Main/Core transaction with readonly and race guarantees",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* acquireScenario;
        let applies = 0;
        let beforeApply: (() => Promise<void>) | null = null;
        const access = CoreSessionAccess.of({
          handshake: Effect.die("Unused handshake"),
          use: (operation, run, options) =>
            Effect.tryPromise({
              try: async (signal) => {
                if (operation === "workspace.apply") {
                  applies++;
                  const intervene = beforeApply;
                  beforeApply = null;
                  if (intervene) await intervene();
                }
                return run(
                  options?.projectId ? client.forProject(options.projectId) : client,
                  signal,
                );
              },
              catch: (cause) => classifyCoreOperationFailure(operation, cause),
            }),
        });
        const context = yield* Layer.buildWithScope(
          coreModulesLive.pipe(Layer.provide(Layer.succeed(CoreSessionAccess, access))),
          yield* Scope.Scope,
        );
        const core = Context.get(context, CoreModules);
        const fixture = yield* makeTargetFixture({
          core,
          request: (_host, method, params) =>
            Effect.succeed(
              method === "thread/read"
                ? { thread: targetThread((params as { threadId: string }).threadId) }
                : { data: [], nextCursor: "ignored" },
            ) as never,
        });
        let pending = false;
        const resolution = yield* makeResolution.pipe(
          Effect.provideService(CodexThreadTargets, fixture.service),
          Effect.provideService(CodexClientThreadIdentity, {
            candidates: () =>
              Effect.succeed([
                {
                  hostId: "ssh:owner",
                  threadId: "created-root",
                  clientThreadId: "client-new-thread:created",
                },
              ]),
          } as unknown as CodexClientThreadIdentity["Service"]),
          Effect.provideService(CodexPendingWorktreeRuntime, {
            list: () =>
              pending
                ? [
                    {
                      launchMode: "start-conversation",
                      clientThreadId: "client-new-thread:created",
                      hostId: "local",
                      threadStartHostId: "ssh:owner",
                    },
                  ]
                : [],
            resolveThread: () => (pending ? { state: "starting" } : null),
          } as unknown as CodexPendingWorktreeRuntime["Service"]),
        );
        const handlers = new Map<string, TargetHandler>();
        const ipc = makeTestElectronIpc({
          handle: (channel: string, handler: TargetHandler) =>
            Effect.sync(() => {
              handlers.set(channel, handler);
            }),
          on: () => Effect.void,
        });
        yield* registerCodexThreadTargetEndpoints(ipc, fixture.service, resolution);
        const invoke = <Channel extends TargetChannel>(
          channel: Channel,
          input: IpcApi[Channel]["args"][0],
        ) => {
          const handler = handlers.get(channel);
          if (!handler) return Effect.die(`Missing endpoint ${channel}`);
          return handler(null as unknown as IpcMainInvokeEvent, input) as Effect.Effect<
            IpcApi[Channel]["result"],
            CodexThreadTargetError
          >;
        };
        const target = { hostId: "ssh:owner", threadId: "created-root" };
        const baseline = yield* core.workspace.read({
          kind: "project_window",
          include_archived: false,
          window: { first: 1, after: null },
        });
        const callbacks = Context.get(
          yield* Layer.buildWithScope(callbackLayer, yield* Scope.Scope),
          ScopedCallbackRuntime,
        );
        const calls: TargetChannel[] = [];
        const navigation = yield* Effect.tryPromise({
          try: (signal) =>
            prepareCreatedThreadNavigation(
              { threadId: target.threadId, expectedHostId: target.hostId },
              {
                resolve: (input) => {
                  calls.push("codex:created-thread:resolve");
                  return callbacks.runPromise(invoke("codex:created-thread:resolve", input), {
                    signal,
                  });
                },
                ensureOpen: (input) => {
                  calls.push("codex:thread:ensure-open");
                  return callbacks.runPromise(invoke("codex:thread:ensure-open", input), {
                    signal,
                  });
                },
              },
            ),
          catch: (cause) => new CodexTargetScenarioError({ cause }),
        });
        expect(calls).toEqual(["codex:created-thread:resolve", "codex:thread:ensure-open"]);
        expect(navigation?.type).toBe("session");
        const session = navigation?.type === "session" ? navigation.session : null;
        if (navigation?.type === "session") expect(navigation.resolution).toBeNull();
        expect(session?.thread?.threadId).toBe(target.threadId);
        expect(session?.thread?.executionHostId).toBe(target.hostId);
        expect(applies).toBe(1);
        expect(fixture.requests).toHaveLength(1);
        const initial = yield* core.workspace.read({ kind: "thread", thread_id: target.threadId });
        expect(initial.value).toMatchObject({
          kind: "thread",
          thread: { session_id: session!.id, execution_host_id: target.hostId },
        });
        expect(initial.commit_head).toBe(baseline.commit_head + 1);

        // The real create_thread producer can label a already-linked root as subagent.
        yield* Effect.promise(() =>
          client.workspaceApply({
            operationId: createUuidV7(),
            intent: {
              kind: "update_thread",
              thread_id: target.threadId,
              patch: { thread_source: "subagent" },
            },
          }),
        );
        yield* Effect.promise(() =>
          client.workspaceApply({
            operationId: createUuidV7(),
            intent: { kind: "set_thread_unread", thread_id: target.threadId, unread: true },
          }),
        );
        const beforeReuse = yield* core.workspace.read({
          kind: "thread",
          thread_id: target.threadId,
        });
        fixture.disconnect();
        const reused = yield* invoke("codex:thread:ensure-open", target);
        expect(reused?.id).toBe(session!.id);
        expect(reused?.unread).toBe(true);
        expect(applies).toBe(1);
        expect(yield* core.workspace.read({ kind: "thread", thread_id: target.threadId })).toEqual(
          beforeReuse,
        );

        yield* Effect.promise(() =>
          client.workspaceApply({
            operationId: createUuidV7(),
            intent: {
              kind: "upsert_thread",
              thread_id: "true-child",
              patch: {
                backend_binding: { kind: "codex" },
                execution_host_id: target.hostId,
                parent_thread_id: target.threadId,
              },
            },
          }),
        );
        expect(
          yield* invoke("codex:thread:ensure-open", { ...target, threadId: "true-child" }),
        ).toBeNull();
        expect(applies).toBe(1);
        expect(fixture.requests).toHaveLength(1);
        const registry = yield* makeInternalRegistry;
        const listed = { ...targetThread(target.threadId), threadSource: "subagent" };
        const readDirectory = (threadId: string) =>
          core.workspace.read({ kind: "thread", thread_id: threadId }).pipe(
            Effect.map((snapshot) => {
              if (snapshot.value.kind !== "thread") throw new Error("Wrong Thread read");
              const durable = projectCoreWorkspaceThread(snapshot.value.thread);
              return {
                durable,
                summary: buildWorkspaceThreadSummary(durable),
                canonical: null,
                snapshot: null,
                historyMode: "paginated",
                fidelity: "durable",
              } as const;
            }),
          );
        const directory = {
          resolve: ({ threadId }: { threadId: string }) => readDirectory(threadId),
          observeMetadata: () => readDirectory(target.threadId),
        } as unknown as CodexThreadDirectory["Service"];
        const gateway = {
          localHostId: target.hostId,
          awaitReady: () => Effect.void,
          promoteQueuedCatalogPage: Effect.void,
          connection: () => Effect.succeed({ kind: "ready", hostId: target.hostId, generation: 1 }),
          requestLocal: (method: string, params: { archived?: boolean }) =>
            Effect.succeed(
              method === "thread/search"
                ? { data: [{ thread: listed, matches: [] }], nextCursor: null }
                : {
                    data: params.archived ? [] : [listed],
                    nextCursor: null,
                    backwardsCursor: null,
                  },
            ),
        } as unknown as CodexGateway["Service"];
        const hub = { events: Stream.empty, publish: () => {} };
        const sidebarScope = yield* Scope.make();
        const sidebar = yield* makeSidebar().pipe(
          Effect.provideService(Scope.Scope, sidebarScope),
          Effect.provideService(CoreModules, core),
          Effect.provideService(CodexGateway, gateway),
          Effect.provideService(CodexThreadDirectory, directory),
          Effect.provideService(CodexInternalThreadRegistry, registry),
          Effect.provideService(CodexApplicationEventHub, hub),
          Effect.provideService(ExecutionHostRuntime, {
            hosts: () => Effect.succeed([]),
          } as unknown as ExecutionHostRuntime["Service"]),
          Effect.provideService(DatabaseNotifierRuntime, {
            projectSessionInvalidations: Stream.empty,
          } as unknown as DatabaseNotifierRuntime["Service"]),
        );
        const beforeEnsure = applies;
        const beforeLocalEnsure = yield* core.workspace.read({
          kind: "thread",
          thread_id: target.threadId,
        });
        expect(
          Exit.isFailure(yield* sidebar.ensureSession(target.threadId).pipe(Effect.exit)),
        ).toBe(true);
        expect(yield* core.workspace.read({ kind: "thread", thread_id: target.threadId })).toEqual(
          beforeLocalEnsure,
        );
        expect(applies).toBe(beforeEnsure);
        yield* sidebar.sync({ policy: "force", reason: "app-server-reconnect" });
        expect(
          (yield* core.workspace.read({ kind: "thread", thread_id: target.threadId })).value,
        ).toMatchObject({
          kind: "thread",
          thread: { archived: false, session_id: session!.id, thread_source: "subagent" },
        });
        const catalog = yield* makeCatalog().pipe(
          Effect.provideService(CoreModules, core),
          Effect.provideService(CodexGateway, gateway),
          Effect.provideService(CodexThreadDirectory, directory),
          Effect.provideService(CodexInternalThreadRegistry, registry),
          Effect.provideService(CodexSidebarSyncRuntime, sidebar),
        );
        expect(
          (yield* catalog.searchPalette({ query: "Created" })).map(
            (result) => result.thread.sessionId,
          ),
        ).toContain(session!.id);
        yield* Scope.close(sidebarScope, Exit.void);
        const afterSweep = applies;
        expect(
          Exit.isFailure(
            yield* invoke("codex:thread:ensure-open", { ...target, hostId: "foreign" }).pipe(
              Effect.exit,
            ),
          ),
        ).toBe(true);
        expect(applies).toBe(afterSweep);

        pending = true;
        expect(
          yield* invoke("codex:created-thread:resolve", {
            clientThreadId: "client-new-thread:created",
          }),
        ).toMatchObject({ hostId: target.hostId, threadId: target.threadId, ready: false });
        pending = false;
        expect(
          yield* invoke("codex:created-thread:resolve", {
            clientThreadId: "client-new-thread:created",
          }),
        ).toMatchObject({ hostId: target.hostId, threadId: target.threadId, ready: true });
        expect(applies).toBe(afterSweep);
        expect(fixture.requests).toHaveLength(1);

        const online = yield* makeTargetFixture({
          core,
          request: (_host, method, params) =>
            Effect.succeed(
              method === "thread/read"
                ? { thread: targetThread((params as { threadId: string }).threadId) }
                : { data: [], nextCursor: "must-not-follow" },
            ) as never,
        });
        const summaryBefore = yield* core.workspace.read({
          kind: "thread",
          thread_id: target.threadId,
        });
        expect(yield* online.service.readSummary(target)).toMatchObject({
          hostId: target.hostId,
          title: "Created chat",
          latestReply: null,
        });
        expect(online.requests.map(({ method }) => method)).toEqual([
          "thread/read",
          "thread/items/list",
        ]);
        expect(applies).toBe(afterSweep);
        expect(yield* core.workspace.read({ kind: "thread", thread_id: target.threadId })).toEqual(
          summaryBefore,
        );

        beforeApply = () =>
          client
            .workspaceApply({
              operationId: createUuidV7(),
              intent: {
                kind: "upsert_thread",
                thread_id: "racing-root",
                patch: {
                  execution_host_id: "ssh:foreign",
                  backend_binding: { kind: "codex" },
                  thread_name: "Foreign title",
                },
              },
            })
            .then(() => undefined);
        expect(
          Exit.isFailure(
            yield* online.service
              .ensureOpen({ ...target, threadId: "racing-root" })
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        const foreign = yield* core.workspace.read({ kind: "thread", thread_id: "racing-root" });
        expect(foreign.value).toMatchObject({
          kind: "thread",
          thread: {
            session_id: null,
            thread_name: "Foreign title",
            execution_host_id: "ssh:foreign",
          },
        });
        const afterRace = applies;
        expect(
          Exit.isFailure(
            yield* online.service
              .ensureOpen({ ...target, threadId: "racing-root" })
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(applies).toBe(afterRace);

        yield* Effect.promise(() =>
          client.workspaceApply({
            operationId: createUuidV7(),
            intent: {
              kind: "mutate_session",
              session_id: session!.id,
              intent: { kind: "unlink_thread", thread_id: target.threadId },
            },
          }),
        );
        beforeApply = () =>
          client
            .workspaceApply({
              operationId: createUuidV7(),
              intent: {
                kind: "mutate_session",
                session_id: session!.id,
                intent: {
                  kind: "link_thread",
                  thread_id: target.threadId,
                  expected_project_id: null,
                },
              },
            })
            .then(() => undefined);
        expect(Exit.isFailure(yield* online.service.ensureOpen(target).pipe(Effect.exit))).toBe(
          true,
        );
        expect((yield* online.service.ensureOpen(target))?.id).toBe(session!.id);
      }),
    ),
  { timeout: 60_000 },
);
