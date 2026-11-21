import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import { rgPath } from "@vscode/ripgrep";
import { build } from "esbuild";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import type { FileSearchEvent, FileSearchResult } from "../../shared/file-search";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import type { FileIndexWorkerHostMessage } from "../file-index-worker/file-index-worker-protocol";
import { RipgrepExecutionRuntime } from "../platform/node/RipgrepExecutionRuntime";
import {
  FileIndexWorkerRuntime,
  live,
  type FileIndexWorkerProcess,
  type FileIndexWorkerProcessFactory,
} from "./FileIndexWorkerRuntime";

class FakeWorker implements FileIndexWorkerProcess {
  readonly sent: FileIndexWorkerHostMessage[] = [];
  readonly events = new EventEmitter();
  terminated = false;

  constructor(readonly epoch: number) {}

  send(message: FileIndexWorkerHostMessage): void {
    this.sent.push(message);
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
    this.terminated = true;
    return 1;
  }
  reply(sessionId: string, seq: number, outcome: object) {
    this.events.emit("message", { type: "session", sessionId, seq, outcome });
  }
}

class RipgrepUnavailable extends Schema.TaggedError<RipgrepUnavailable>()("RipgrepUnavailable", {
  cause: Schema.Defect(),
}) {}

const result = (path: string): FileSearchResult => ({
  root: "/repo",
  path,
  file_name: path,
  match_type: "file",
  score: 10,
  indices: [0],
});

const verifiedRipgrep = (resolve: Effect.Effect<string, RipgrepUnavailable>) =>
  Layer.succeed(RipgrepExecutionRuntime, {
    resolve,
  } as unknown as RipgrepExecutionRuntime["Service"]);

const makeHarness = (
  options: { readonly ripgrep?: Effect.Effect<string, RipgrepUnavailable> } = {},
) =>
  Effect.gen(function* () {
    const workers: FakeWorker[] = [];
    const createProcess: FileIndexWorkerProcessFactory = (input) => {
      const worker = new FakeWorker(input.workerData.epoch);
      assert.equal(input.workerData.ripgrepPath, "/verified/rg");
      workers.push(worker);
      return worker;
    };
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      live({
        workerPath: "/test/file-index-worker.js",
        createProcess,
        shutdownTimeoutMs: 500,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            mainConfigLayer(),
            verifiedRipgrep(options.ripgrep ?? Effect.succeed("/verified/rg")),
          ),
        ),
      ),
      scope,
    );
    const runtime = Context.get(context, FileIndexWorkerRuntime);
    const open = (sessionId: string) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<FileSearchEvent>();
        const sessionScope = yield* Scope.make();
        const session = yield* runtime
          .openSession({ sessionId, roots: ["/repo"] }, (event) =>
            Queue.offer(events, event).pipe(Effect.asVoid),
          )
          .pipe(Scope.provide(sessionScope));
        return { session, events, close: Scope.close(sessionScope, Exit.void) };
      });
    return { workers, scope, open };
  });

it.effect("routes every query to the worker and delivers only the latest answers", () =>
  Effect.gen(function* () {
    const { workers, open } = yield* makeHarness();
    const search = yield* open("search");
    yield* search.session.update("a");
    yield* search.session.update("ab");
    yield* search.session.update("abc");
    assert.lengthOf(workers, 1);
    const worker = workers[0]!;
    assert.deepEqual(worker.sent, [
      { type: "open", sessionId: "search", roots: ["/repo"] },
      { type: "query", sessionId: "search", seq: 1, query: "a" },
      { type: "query", sessionId: "search", seq: 2, query: "ab" },
      { type: "query", sessionId: "search", seq: 3, query: "abc" },
    ]);
    worker.events.emit("message", { type: "ready", epoch: 1 });
    worker.reply("search", 1, { kind: "updated", files: [result("stale")] });
    worker.reply("search", 3, { kind: "updated", files: [result("abc.ts")] });
    worker.reply("search", 3, { kind: "completed" });
    assert.deepEqual(yield* Queue.take(search.events), {
      method: "fuzzyFileSearch/sessionUpdated",
      params: { sessionId: "search", query: "abc", files: [result("abc.ts")] },
    });
    assert.deepEqual(yield* Queue.take(search.events), {
      method: "fuzzyFileSearch/sessionCompleted",
      params: { sessionId: "search", query: "abc" },
    });

    yield* search.session.update("");
    yield* search.close;
    assert.deepEqual(worker.sent.slice(4), [
      { type: "query", sessionId: "search", seq: 4, query: "" },
      { type: "close", sessionId: "search" },
    ]);
    assert.lengthOf(yield* Queue.clear(search.events), 0);
  }),
);

it.effect("fails searches in flight when the worker stops and reopens sessions in a new one", () =>
  Effect.gen(function* () {
    const { workers, open } = yield* makeHarness();
    const pending = yield* open("pending");
    const settled = yield* open("settled");
    yield* settled.session.update("x");
    workers[0]!.reply("settled", 1, { kind: "completed" });
    yield* Queue.take(settled.events);
    yield* pending.session.update("a");

    workers[0]!.events.emit("exit", 1);
    assert.deepEqual(yield* Queue.take(pending.events), {
      method: "file-search/sessionFailed",
      params: { sessionId: "pending", query: "a" },
    });
    assert.isTrue(workers[0]!.terminated);
    workers[0]!.reply("pending", 1, { kind: "completed" });

    yield* pending.session.update("ab");
    yield* settled.session.update("xy");
    assert.lengthOf(workers, 2);
    assert.equal(workers[1]!.epoch, 2);
    assert.deepEqual(workers[1]!.sent, [
      { type: "open", sessionId: "pending", roots: ["/repo"] },
      { type: "query", sessionId: "pending", seq: 2, query: "ab" },
      { type: "open", sessionId: "settled", roots: ["/repo"] },
      { type: "query", sessionId: "settled", seq: 2, query: "xy" },
    ]);
    workers[1]!.reply("pending", 2, { kind: "completed" });
    assert.deepEqual(yield* Queue.take(pending.events), {
      method: "fuzzyFileSearch/sessionCompleted",
      params: { sessionId: "pending", query: "ab" },
    });
    assert.lengthOf(yield* Queue.clear(settled.events), 0);
  }),
);

it.effect("treats an invalid worker message as a stopped worker", () =>
  Effect.gen(function* () {
    const { workers, open } = yield* makeHarness();
    const search = yield* open("search");
    yield* search.session.update("a");
    workers[0]!.events.emit("message", { type: "session", sessionId: "search" });
    assert.equal((yield* Queue.take(search.events)).method, "file-search/sessionFailed");
    assert.isTrue(workers[0]!.terminated);
  }),
);

it.effect("reports a failed search without starting a worker when ripgrep is unavailable", () =>
  Effect.gen(function* () {
    const { workers, open } = yield* makeHarness({
      ripgrep: Effect.fail(new RipgrepUnavailable({ cause: "missing" })),
    });
    const search = yield* open("search");
    yield* search.session.update("a");
    assert.deepEqual(yield* Queue.take(search.events), {
      method: "file-search/sessionFailed",
      params: { sessionId: "search", query: "a" },
    });
    assert.lengthOf(workers, 0);
  }),
);

it.effect("does not open a session in the worker once it closed while the worker started", () =>
  Effect.gen(function* () {
    const resolved = yield* Deferred.make<string>();
    const { workers, open } = yield* makeHarness({ ripgrep: Deferred.await(resolved) });
    const search = yield* open("search");
    const updating = yield* Effect.forkChild(search.session.update("a"));
    yield* Effect.yieldNow;
    yield* search.close;
    yield* Deferred.succeed(resolved, "/verified/rg");
    yield* Fiber.join(updating);
    assert.lengthOf(workers, 1);
    assert.deepEqual(workers[0]!.sent, []);
    assert.lengthOf(yield* Queue.clear(search.events), 0);
  }),
);

it.effect("asks the worker to stop with Main and terminates it after the grace period", () =>
  Effect.gen(function* () {
    const { workers, open, scope } = yield* makeHarness();
    const search = yield* open("search");
    yield* search.session.update("a");
    yield* search.close;
    const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
    yield* Effect.yieldNow;
    assert.deepEqual(workers[0]!.sent.at(-1), { type: "shutdown" });
    assert.isFalse(workers[0]!.terminated);
    yield* TestClock.adjust("500 millis");
    yield* Fiber.join(closing);
    assert.isTrue(workers[0]!.terminated);
  }),
);

// The ripgrep stand-in that counts listings is a POSIX shell script.
it.live.skipIf(process.platform === "win32")(
  "indexes in a real worker thread and lists a root once for every window searching it",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-file-index-worker-"))),
        (created) => Effect.promise(() => rm(created, { recursive: true, force: true })),
      );
      const root = path.join(directory, "repo");
      const workerPath = path.join(directory, "file-index-worker.js");
      const ripgrep = path.join(directory, "rg");
      const invocations = path.join(directory, "invocations.log");
      yield* Effect.promise(async () => {
        await mkdir(path.join(root, "src/app"), { recursive: true });
        await writeFile(path.join(root, "src/app/main.ts"), "");
        await writeFile(path.join(root, "src/app/maintenance.md"), "");
        await writeFile(
          ripgrep,
          `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(invocations)}\nexec ${JSON.stringify(rgPath)} "$@"\n`,
        );
        await chmod(ripgrep, 0o700);
        await build({
          entryPoints: [path.resolve("src/main/file-index-worker/entry.ts")],
          outfile: workerPath,
          bundle: true,
          platform: "node",
          format: "cjs",
          target: "node24",
          logLevel: "silent",
        });
      });
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        live({ workerPath }).pipe(
          Layer.provide(
            Layer.mergeAll(mainConfigLayer(), verifiedRipgrep(Effect.succeed(ripgrep))),
          ),
        ),
        scope,
      );
      const runtime = Context.get(context, FileIndexWorkerRuntime);
      const search = (sessionId: string, query: string) =>
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<FileSearchEvent>();
          const session = yield* runtime.openSession({ sessionId, roots: [root] }, (event) =>
            Queue.offer(events, event).pipe(Effect.asVoid),
          );
          yield* session.update(query);
          let files: readonly FileSearchResult[] = [];
          while (true) {
            const event = yield* Queue.take(events);
            if (event.method === "fuzzyFileSearch/sessionUpdated") files = event.params.files;
            else return { method: event.method, files: files.map((file) => file.path) };
          }
        }).pipe(Effect.scoped);

      const first = yield* search("composer", "main");
      const second = yield* search("palette", "main");
      assert.deepEqual(first, {
        method: "fuzzyFileSearch/sessionCompleted",
        files: ["src/app/main.ts", "src/app/maintenance.md"],
      });
      assert.deepEqual(second, first);
      const listings = (yield* Effect.promise(() => readFile(invocations, "utf8")))
        .split("\n")
        .filter((line) => line.includes("--files"));
      assert.lengthOf(listings, 1);
      yield* Scope.close(scope, Exit.void);
    }),
);
