import { describe, vi } from "vite-plus/test";
import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { CodexGateway } from "../../codex-runtime/CodexGateway";
import { WebContentsDestructionSubscriptions } from "../../platform/electron/WebContentsDestructionSubscriptions";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import {
  createFuzzyQueryScorer,
  matchFuzzyQueryFragments,
} from "../../../shared/fuzzy-query-match";
import type { FileIndexWorkerHostMessage } from "../../file-index-worker/file-index-worker-protocol";
import {
  FileIndexWorkerRuntime,
  live as fileIndexWorkerLive,
  type FileIndexWorkerProcess,
} from "../../host-runtime/FileIndexWorkerRuntime";
import { RipgrepExecutionRuntime } from "../../platform/node/RipgrepExecutionRuntime";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { type FileSearchIpcError, live } from "./FileSearchIpc";
import type { CodexRuntimeError } from "../../codex-runtime/CodexRuntimeError";
import { ChatSearch } from "../../chat-search/ChatSearch";
import { live as liveFindIpc } from "./FindIpc";
import { CoreModules } from "../../core-runtime/CoreModules";
import { LibraryModule } from "../../library-application/LibraryModule";
import { WorkspaceTextSearch } from "../../codex-application/WorkspaceTextSearch";
import { live as liveWorkspaceTextSearchIpc } from "./WorkspaceTextSearchIpc";

vi.mock("../../platform/electron/TrustedRendererSender", () => ({
  requireTrustedAppRendererSender: () => undefined,
}));

vi.mock("../../../shared/fuzzy-query-match", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/fuzzy-query-match")>();
  return {
    ...actual,
    createFuzzyQueryScorer: vi.fn(actual.createFuzzyQueryScorer),
    matchFuzzyQueryFragments: vi.fn(actual.matchFuzzyQueryFragments),
  };
});

describe("FileSearchIpc", () => {
  type Handler = (
    event: IpcMainInvokeEvent,
    input: unknown,
  ) => Effect.Effect<unknown, FileSearchIpcError | CodexRuntimeError>;

  it.effect(
    "restricts updates to the owning window and stops on window destruction or Main shutdown",
    () =>
      Effect.gen(function* () {
        const handlers = new Map<string, Handler>();
        const ipc = makeTestElectronIpc({
          handle: (channel: string, handler: Handler) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                handlers.set(channel, handler);
              }),
              () =>
                Effect.sync(() => {
                  handlers.delete(channel);
                }),
            ),
          on: () => Effect.die("unused"),
        });
        let stopped = yield* Deferred.make<void>();
        const calls: Array<{ method: string; sessionId: string }> = [];
        const gateway = {
          localHostId: "local",
          events: Stream.never,
          awaitReady: () => Effect.void,
          connection: () => Effect.succeed({ kind: "ready", hostId: "remote", generation: 1 }),
          requestOnHost: (_host: string, method: string, params: { sessionId: string }) =>
            Effect.gen(function* () {
              calls.push({ method, sessionId: params.sessionId });
              if (method === "fuzzyFileSearch/sessionStop")
                yield* Deferred.succeed(stopped, undefined);
              return {};
            }),
        } as unknown as CodexGateway["Service"];
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(
          live.pipe(
            Layer.provideMerge(WebContentsDestructionSubscriptions.live),
            Layer.provide(
              Layer.mergeAll(
                mainConfigLayer(),
                Layer.succeed(ElectronIpc, ipc),
                Layer.succeed(CodexGateway, gateway),
                Layer.succeed(FileIndexWorkerRuntime, {
                  openSession: () => Effect.die("unexpected local search"),
                }),
                Layer.succeed(WindowRuntime, {
                  has: () => true,
                } as unknown as WindowRuntime["Service"]),
              ),
            ),
          ),
          scope,
        );
        const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
        const other = Object.assign(new EventEmitter(), { id: 2, isDestroyed: () => false });
        const event = { sender } as unknown as IpcMainInvokeEvent;
        const otherEvent = { sender: other } as unknown as IpcMainInvokeEvent;
        const input = {
          hostId: "remote",
          sessionId: "128cc777-30ab-4c91-8857-a2083e8349f1",
          roots: ["/repo"],
        };
        const destruction = Context.get(context, WebContentsDestructionSubscriptions);
        let unrelatedCleanup = 0;
        let releaseUnrelated = destruction.subscribe(sender, () => unrelatedCleanup++);
        const start = handlers.get("file-search:start")!;
        const update = handlers.get("file-search:update")!;
        const stop = handlers.get("file-search:stop")!;
        for (let index = 0; index < 16; index++) {
          yield* start(event, input);
          assert.strictEqual(sender.listenerCount("destroyed"), 1);
          yield* stop(event, { sessionId: input.sessionId });
        }
        assert.strictEqual(
          calls.filter((call) => call.method === "fuzzyFileSearch/sessionStop").length,
          16,
        );
        releaseUnrelated();
        assert.strictEqual(sender.listenerCount("destroyed"), 0);
        releaseUnrelated = destruction.subscribe(sender, () => unrelatedCleanup++);
        stopped = yield* Deferred.make<void>();
        calls.length = 0;
        yield* start(event, input);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(update(otherEvent, { sessionId: input.sessionId, query: "abc" })),
          ),
        );
        yield* start(otherEvent, input);
        assert.notStrictEqual(calls[0]?.sessionId, calls[1]?.sessionId);
        assert.notStrictEqual(calls[0]?.sessionId, input.sessionId);
        yield* update(event, { sessionId: input.sessionId, query: "abc" });
        sender.emit("destroyed");
        yield* Deferred.await(stopped);
        assert.strictEqual(sender.listenerCount("destroyed"), 0);
        assert.strictEqual(unrelatedCleanup, 1);
        releaseUnrelated();
        yield* update(otherEvent, { sessionId: input.sessionId, query: "other" });
        yield* Scope.close(scope, Exit.succeed(undefined));
        assert.strictEqual(other.listenerCount("destroyed"), 0);
        assert.strictEqual(handlers.size, 0);
        assert.deepEqual(
          calls.map((call) => call.method),
          [
            "fuzzyFileSearch/sessionStart",
            "fuzzyFileSearch/sessionStart",
            "fuzzyFileSearch/sessionUpdate",
            "fuzzyFileSearch/sessionStop",
            "fuzzyFileSearch/sessionUpdate",
            "fuzzyFileSearch/sessionStop",
          ],
        );
        assert.strictEqual(calls[2]?.sessionId, calls[0]?.sessionId);
        assert.strictEqual(calls[3]?.sessionId, calls[0]?.sessionId);
        assert.strictEqual(calls[4]?.sessionId, calls[1]?.sessionId);
        assert.strictEqual(calls[5]?.sessionId, calls[1]?.sessionId);
      }),
  );

  it.effect("keeps local indexing and ranking in the file index worker while a window types", () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const ipc = makeTestElectronIpc({
        handle: (channel: string, handler: Handler) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              handlers.set(channel, handler);
            }),
            () =>
              Effect.sync(() => {
                handlers.delete(channel);
              }),
          ),
        on: () => Effect.die("unused"),
      });
      const sentToWorker: FileIndexWorkerHostMessage[] = [];
      const worker = new EventEmitter();
      const process: FileIndexWorkerProcess = {
        send: (message) => {
          sentToWorker.push(message);
          if (message.type === "shutdown") worker.emit("exit", 0);
        },
        onMessage: (listener) => (
          worker.on("message", listener),
          () => worker.off("message", listener)
        ),
        onError: (listener) => (worker.on("error", listener), () => worker.off("error", listener)),
        onExit: (listener) => (worker.on("exit", listener), () => worker.off("exit", listener)),
        terminate: async () => 0,
      };
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        live.pipe(
          Layer.provideMerge(WebContentsDestructionSubscriptions.live),
          Layer.provide(
            Layer.mergeAll(
              mainConfigLayer(),
              Layer.succeed(ElectronIpc, ipc),
              Layer.succeed(CodexGateway, {} as CodexGateway["Service"]),
              fileIndexWorkerLive({
                workerPath: "/test/file-index-worker.js",
                createProcess: () => process,
              }).pipe(
                Layer.provide(
                  Layer.mergeAll(
                    mainConfigLayer(),
                    Layer.succeed(RipgrepExecutionRuntime, {
                      resolve: Effect.succeed("/verified/rg"),
                    } as unknown as RipgrepExecutionRuntime["Service"]),
                  ),
                ),
              ),
              Layer.succeed(WindowRuntime, {
                has: () => true,
              } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
        scope,
      );
      const delivered: unknown[] = [];
      const sender = Object.assign(new EventEmitter(), {
        id: 1,
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => void delivered.push({ channel, payload }),
      });
      const event = { sender } as unknown as IpcMainInvokeEvent;
      const sessionId = "4f3c3bd5-0fd5-4c8a-9a1a-0f1f6c7e4c51";
      const queries = ["s", "sr", "src", "src/", "src/m", "src/ma", "src/mai", "src/main"];
      yield* handlers.get("file-search:start")!(event, {
        hostId: "local",
        sessionId,
        roots: ["/repo"],
      });
      for (const query of queries)
        yield* handlers.get("file-search:update")!(event, { sessionId, query });

      const [opened, ...asked] = sentToWorker;
      assert.equal(opened?.type, "open");
      const workerSessionId = opened?.type === "open" ? opened.sessionId : "";
      assert.notEqual(workerSessionId, sessionId);
      assert.deepEqual(
        asked,
        queries.map((query, index) => ({
          type: "query",
          sessionId: workerSessionId,
          seq: index + 1,
          query,
        })),
      );
      const files = [
        {
          root: "/repo",
          path: "src/main.ts",
          file_name: "main.ts",
          match_type: "file",
          score: 42,
          indices: [0, 1],
        },
      ];
      const reply = (outcome: object) =>
        worker.emit("message", {
          type: "session",
          sessionId: workerSessionId,
          seq: queries.length,
          outcome,
        });
      reply({ kind: "updated", files });
      reply({ kind: "completed" });
      yield* Effect.yieldNow;
      assert.deepEqual(delivered, [
        {
          channel: "file-search:event",
          payload: {
            method: "fuzzyFileSearch/sessionUpdated",
            params: { sessionId, query: "src/main", files },
          },
        },
        {
          channel: "file-search:event",
          payload: {
            method: "fuzzyFileSearch/sessionCompleted",
            params: { sessionId, query: "src/main" },
          },
        },
      ]);
      // Main forwards queries and results; scoring and highlight ranges come from the worker.
      assert.equal(vi.mocked(createFuzzyQueryScorer).mock.calls.length, 0);
      assert.equal(vi.mocked(matchFuzzyQueryFragments).mock.calls.length, 0);

      yield* handlers.get("file-search:stop")!(event, { sessionId });
      assert.deepEqual(sentToWorker.at(-1), { type: "close", sessionId: workerSessionId });
      yield* Scope.close(scope, Exit.succeed(undefined));
      assert.deepEqual(sentToWorker.at(-1), { type: "shutdown" });
    }),
  );
});

describe("FindIpc", () => {
  type Handler = (
    event: IpcMainInvokeEvent,
    ...args: readonly unknown[]
  ) => Effect.Effect<unknown, unknown>;

  it.effect("validates bounded chat queries and rejects callers without an active window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handlers = new Map<string, Handler>();
        const calls: unknown[] = [];
        const ipc = makeTestElectronIpc({
          handle: (channel, handler: Handler) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                handlers.set(channel, handler);
              }),
              () =>
                Effect.sync(() => {
                  handlers.delete(channel);
                }),
            ),
          on: () => Effect.die("unused"),
        });
        yield* Layer.buildWithScope(
          liveFindIpc.pipe(
            Layer.provide(
              Layer.mergeAll(
                mainConfigLayer(),
                Layer.succeed(ElectronIpc, ipc),
                Layer.succeed(CoreModules, {} as CoreModules["Service"]),
                Layer.succeed(LibraryModule, {} as LibraryModule["Service"]),
                Layer.succeed(WindowRuntime, {
                  has: (id: number) => id === 1,
                } as unknown as WindowRuntime["Service"]),
                Layer.succeed(ChatSearch, {
                  search: (input) =>
                    Effect.sync(() => {
                      calls.push(input);
                      return { matches: [], complete: true };
                    }),
                  searchMessages: (input) =>
                    Effect.sync(() => {
                      calls.push(input);
                      return { matches: [], truncated: false, sources: [] };
                    }),
                  rankSessionIds: () => Effect.succeed([]),
                }),
              ),
            ),
          ),
          yield* Scope.Scope,
        );
        const event = {
          sender: { id: 1, isDestroyed: () => false },
        } as unknown as IpcMainInvokeEvent;
        const search = handlers.get("find:search")!;
        const input = {
          query: " needle ",
          kinds: ["chat"],
          place: { kind: "everywhere" },
          limit: 10,
        };
        const response = yield* search(event, input, "instant");
        assert.include(response as object, { phase: "instant", nextCursor: null });
        assert.equal((calls[0] as { query: string }).query, "needle");
        assert.equal(
          (yield* search(event, { ...input, limit: 161 }, "instant").pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* search(event, input, "bad_phase").pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* search(
            { sender: { id: 2, isDestroyed: () => false } } as unknown as IpcMainInvokeEvent,
            input,
            "instant",
          ).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(calls.length, 1);
      }),
    ),
  );
});

describe("WorkspaceTextSearchIpc", () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Effect.Effect<unknown>;

  it.effect(
    "owns cancellation by window and request, replacing requests and releasing destroyed windows and Main",
    () =>
      Effect.gen(function* () {
        const handlers = new Map<string, Handler>();
        const ipc = makeTestElectronIpc({
          handle: (channel: string, handler: Handler) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                handlers.set(channel, handler);
              }),
              () =>
                Effect.sync(() => {
                  handlers.delete(channel);
                }),
            ),
          on: () => Effect.die("unused"),
        });
        const active = new Set<number>();
        let next = 0;
        const started = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const service = WorkspaceTextSearch.of({
          search: () =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                const id = ++next;
                active.add(id);
                return id;
              }),
              () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
              (id) =>
                Effect.sync(() => {
                  active.delete(id);
                }).pipe(Effect.andThen(Deferred.succeed(stopped, undefined))),
            ),
        });
        const sender = (id: number) =>
          Object.assign(new EventEmitter(), {
            id,
            isDestroyed: () => false,
            send: () => undefined,
          });
        const a = sender(1);
        const b = sender(2);
        const eventA = { sender: a } as unknown as IpcMainInvokeEvent;
        const eventB = { sender: b } as unknown as IpcMainInvokeEvent;
        const scope = yield* Scope.make();
        yield* Layer.buildWithScope(
          liveWorkspaceTextSearchIpc.pipe(
            Layer.provide(
              Layer.mergeAll(
                mainConfigLayer(),
                Layer.succeed(ElectronIpc, ipc),
                Layer.succeed(WorkspaceTextSearch, service),
                Layer.succeed(WindowRuntime, {
                  has: () => true,
                } as unknown as WindowRuntime["Service"]),
              ),
            ),
          ),
          scope,
        );
        const request = {
          requestId: "f3ebc134-7b2b-4c8d-8758-01e7b2a87065",
          hostId: "local",
          roots: ["/workspace"],
          query: "needle",
        };
        const start = handlers.get("workspace-text-search:start")!;
        const stop = handlers.get("workspace-text-search:stop")!;
        yield* start(eventA, request);
        yield* Deferred.await(started);
        assert.deepEqual([...active], [1]);
        yield* stop(eventB, { requestId: request.requestId });
        assert.deepEqual([...active], [1]);
        yield* start(eventA, request);
        yield* Effect.yieldNow;
        assert.deepEqual([...active], [2]);
        yield* start(eventB, request);
        yield* Effect.yieldNow;
        assert.deepEqual([...active], [2, 3]);
        a.emit("destroyed");
        yield* Effect.yieldNow;
        assert.deepEqual([...active], [3]);
        assert.equal(a.listenerCount("destroyed"), 0);
        yield* Scope.close(scope, Exit.void);
        assert.equal(active.size, 0);
        assert.equal(b.listenerCount("destroyed"), 0);
        assert.equal(handlers.size, 0);
      }),
  );
});
