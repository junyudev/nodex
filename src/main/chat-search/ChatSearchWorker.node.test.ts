import { EventEmitter } from "node:events";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import { build } from "esbuild";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { serveChatSearchWorker } from "../chat-search-worker/chat-search-worker-module";
import type { ChatSearchWorkerHostMessage } from "../chat-search-worker/chat-search-worker-protocol";
import { projectChat } from "./ChatCatalogProjection";
import { ChatSearchEngine, type SessionSearchRequest } from "./ChatSearchEngine";
import { fact, row } from "./ChatSearch.test-support";
import { live, type ChatSearchWorkerProcess } from "./ChatSearchWorker";

const chats = ["Quartz migration", "Database index", "Sidebar polish"].map((title, index) =>
  projectChat(row(`chat-${index}`, title), undefined, true)!,
);
const now = Date.parse("2026-10-02T00:00:00.000Z");
const page = (threadId: string) => ({
  runtimeId: "runtime",
  items: [fact(threadId, "needle in history")],
  nextCursor: null,
  coverage: "indexed" as const,
  startCursor: null,
  strongWords: [true],
  truncated: false,
});

/** A worker on the test's own thread: the real serving module behind a cloning message boundary. */
class LocalWorker implements ChatSearchWorkerProcess {
  readonly sent: ChatSearchWorkerHostMessage[] = [];
  readonly events = new EventEmitter();
  readonly inbound = new EventEmitter();
  stop: () => void = () => undefined;

  send(message: ChatSearchWorkerHostMessage) {
    this.sent.push(message);
    const copy = structuredClone(message);
    queueMicrotask(() => this.inbound.emit("message", copy));
  }
  onMessage(listener: (message: unknown) => void) {
    this.events.on("message", listener);
    return () => void this.events.off("message", listener);
  }
  onError(listener: (error: Error) => void) {
    this.events.on("error", listener);
    return () => void this.events.off("error", listener);
  }
  onExit(listener: (code: number) => void) {
    this.events.on("exit", listener);
    return () => void this.events.off("exit", listener);
  }
  async terminate() {
    this.stop();
    return 1;
  }
  crash() {
    this.events.emit("exit", 1);
  }
}

const harness = Effect.gen(function* () {
  const workers: LocalWorker[] = [];
  const histories: SessionSearchRequest[] = [];
  /** Opens when the worker asks Main for history it will never receive. */
  const stalled = yield* Deferred.make<void>();
  const scope = yield* Scope.make();
  const spawn = yield* FiberSet.runtime(yield* FiberSet.make())();
  const context = yield* Layer.buildWithScope(
    live({
      workerPath: "/test/chat-search-worker.js",
      shutdownTimeoutMs: 100,
      createProcess: ({ workerData }) => {
        const worker = new LocalWorker();
        const fiber = spawn(
          serveChatSearchWorker(
            {
              post: (message) => {
                const copy = structuredClone(message);
                queueMicrotask(() => worker.events.emit("message", copy));
              },
              listen: (listener) => {
                worker.inbound.on("message", listener);
                return () => void worker.inbound.off("message", listener);
              },
            },
            workerData.epoch,
          ).pipe(Effect.ensuring(Effect.sync(() => worker.events.emit("exit", 0)))),
        );
        worker.stop = () => void spawn(Fiber.interrupt(fiber));
        workers.push(worker);
        return worker;
      },
    }).pipe(
      Layer.provide(
        Layer.succeed(AgentRuntimeApplication, {
          sessionSearch: (request: SessionSearchRequest) =>
            request.query === "stall"
              ? Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.sync(() => {
                  histories.push(request);
                  return page(request.threadIds?.find((id) => id === "chat-1") ?? "missing");
                }),
        } as unknown as AgentRuntimeApplication["Service"]),
      ),
    ),
    scope,
  );
  return { engine: Context.get(context, ChatSearchEngine), workers, histories, stalled, scope };
});

it.effect("ranks the shared catalog and merges Runtime history in one worker", () =>
  Effect.gen(function* () {
    const { engine, workers, histories, scope } = yield* harness;
    yield* engine.publish(chats);
    const titles = yield* engine.search({
      catalog: { kind: "shared" },
      input: { query: "quartz", limit: 5, instant: true },
      now,
    });
    assert.deepEqual(
      titles.matches.map(({ chat }) => chat.sessionId),
      ["chat-0"],
    );
    const history = yield* engine.searchMessages({
      catalog: { kind: "shared" },
      input: { query: "needle", limit: 5 },
      now,
    });
    assert.deepEqual(
      history.matches.map(({ chat, historyMatch }) => [chat.sessionId, historyMatch?.itemId]),
      [["chat-1", "item:chat-1"]],
    );
    assert.deepEqual(history.sources, [{ source: "runtime", state: "complete" }]);
    assert.sameMembers([...(histories[0]?.threadIds ?? [])], ["chat-0", "chat-1", "chat-2"]);
    // A Member's chats travel with the request and leave the shared catalog alone.
    const member = yield* engine.rankSessionIds({
      catalog: { kind: "inline", entries: chats.slice(2) },
      query: "",
      archived: false,
      now,
    });
    assert.deepEqual(member, ["chat-2"]);
    assert.lengthOf(workers, 1);
    yield* Scope.close(scope, Exit.void);
    assert.deepEqual(workers[0]!.sent.at(-1), { type: "shutdown" });
  }),
);

it.effect("fails calls a stopped worker held and gives the next worker the latest catalog", () =>
  Effect.gen(function* () {
    const { engine, workers, stalled, scope } = yield* harness;
    yield* engine.publish(chats);
    const pending = yield* engine
      .searchMessages({ catalog: { kind: "shared" }, input: { query: "stall", limit: 5 }, now })
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(stalled);
    workers[0]!.crash();
    assert.equal((yield* Fiber.join(pending))._tag, "ChatSearchEngineUnavailable");
    const ranked = yield* engine.search({
      catalog: { kind: "shared" },
      input: { query: "sidebar", limit: 5 },
      now,
    });
    assert.deepEqual(
      ranked.matches.map(({ chat }) => chat.sessionId),
      ["chat-2"],
    );
    assert.lengthOf(workers, 2);
    assert.deepEqual(workers[1]!.sent[0], { type: "publish", entries: chats });
    yield* Scope.close(scope, Exit.void);
  }),
);

it.live("starts the bundled entry in a worker thread", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-chat-search-worker-"))),
      (created) => Effect.promise(() => rm(created, { recursive: true, force: true })),
    );
    const workerPath = path.join(directory, "chat-search-worker.mjs");
    yield* Effect.promise(async () => {
      // The search kernel reads its binary beside the module that loads it.
      await mkdir(path.join(directory, "generated"));
      await copyFile(
        path.resolve("crates/nodex-search-kernel/generated/nodex_search_kernel_bg.wasm"),
        path.join(directory, "generated/nodex_search_kernel_bg.wasm"),
      );
      await build({
        entryPoints: [path.resolve("src/main/chat-search-worker/entry.ts")],
        outfile: workerPath,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node24",
        logLevel: "silent",
        banner: {
          js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        },
      });
    });
    const context = yield* Layer.build(
      live({ workerPath }).pipe(
        Layer.provide(
          Layer.succeed(AgentRuntimeApplication, {
            sessionSearch: (request: SessionSearchRequest) =>
              Effect.succeed(page(request.threadIds?.[0] ?? "missing")),
          } as unknown as AgentRuntimeApplication["Service"]),
        ),
      ),
    );
    const engine = Context.get(context, ChatSearchEngine);
    yield* engine.publish(chats);
    const titles = yield* engine.search({
      catalog: { kind: "shared" },
      input: { query: "database", limit: 5, instant: true },
      now,
    });
    assert.deepEqual(
      titles.matches.map(({ chat }) => chat.sessionId),
      ["chat-1"],
    );
    const history = yield* engine.searchMessages({
      catalog: { kind: "shared" },
      input: { query: "needle", limit: 5 },
      now,
    });
    assert.deepEqual(
      history.matches.map(({ chat, historyMatch }) => [chat.sessionId, historyMatch?.itemId]),
      [["chat-0", "item:chat-0"]],
    );
  }).pipe(Effect.scoped),
);
