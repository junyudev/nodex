import { assert, it } from "@effect/vitest";
import { rgPath } from "@vscode/ripgrep";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { FileSearchResult } from "../../shared/file-search";
import { FileWatchError, type FileWatchEvent, type FileWatchHost } from "../file-watch-host";
import {
  layer as listingLayer,
  WorkspaceFileListing,
  WorkspaceFileListingError,
  type WorkspaceFileListingRequest,
} from "../platform/node/WorkspaceFileListing";
import {
  makeFileIndexModule,
  type FileIndexModuleOptions,
  type FileIndexRootState,
} from "./file-index-module";
import { FILE_INDEX_TIMINGS } from "./file-index-timings";
import type { FileIndexWorkerThreadMessage } from "./file-index-worker-protocol";

type Listing = WorkspaceFileListing["Service"];

const writeFiles = (root: string, files: Record<string, string>) =>
  Effect.promise(async () => {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
  });

const temporaryRoot = (files: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const root = await mkdtemp(path.join(tmpdir(), "nodex-file-index-"));
      await mkdir(path.join(root, ".git"));
      return root;
    }),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  ).pipe(Effect.tap((root) => writeFiles(root, files)));

const realListing = Effect.gen(function* () {
  const context = yield* Layer.build(listingLayer({ executable: rgPath, environment: {} }));
  return Context.get(context, WorkspaceFileListing);
});

/** Ripgrep stand-in that lists fixed paths per root. */
const fixedListing = (trees: Record<string, readonly string[]>): Listing =>
  WorkspaceFileListing.of({
    list: (request) =>
      Effect.gen(function* () {
        const files = trees[request.root] ?? [];
        const completed = files.length === 0 || (yield* request.onPaths(files));
        return { kind: completed ? "completed" : "stopped", aliases: [] } as const;
      }),
    readDirectory: () => Effect.die("unexpected directory read"),
    pathKind: () => Effect.die("unexpected path inspection"),
  });

/** A watch that reports only the changes a test makes. */
const makeWatch = (fail = false) =>
  Effect.gen(function* () {
    const sinks = new Map<string, Queue.Queue<FileWatchEvent, FileWatchError | Cause.Done>>();
    const released = yield* Queue.unbounded<string>();
    const host: FileWatchHost = {
      watch: (input) =>
        fail
          ? Stream.fail(new FileWatchError({ path: input.path, cause: new Error("unavailable") }))
          : Stream.callback<FileWatchEvent, FileWatchError>((queue) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  sinks.set(input.path, queue);
                  Queue.offerUnsafe(queue, {
                    _tag: "Ready",
                    coverage: { recursive: true, typedPathChanges: false },
                    path: input.path,
                  });
                }),
                () =>
                  Effect.sync(() => sinks.delete(input.path)).pipe(
                    Effect.andThen(Queue.offer(released, input.path)),
                  ),
              ),
            ),
    };
    return {
      host,
      released,
      change: (root: string, ...files: string[]) =>
        Effect.sync(() => {
          Queue.offerUnsafe(sinks.get(root)!, {
            _tag: "Changed",
            changedPaths: files.map((file) => path.join(root, file)),
          });
        }),
    };
  });

const makeHarness = (
  input: {
    readonly listing?: Listing;
    readonly watchFails?: boolean;
  } & Pick<FileIndexModuleOptions, "limits" | "timings"> = {},
) =>
  Effect.gen(function* () {
    const watch = yield* makeWatch(input.watchFails);
    const outbox = yield* Queue.unbounded<FileIndexWorkerThreadMessage>();
    const log: FileIndexWorkerThreadMessage[] = [];
    const updates = yield* Queue.unbounded<FileIndexRootState>();
    const requests: WorkspaceFileListingRequest[] = [];
    const base = input.listing ?? (yield* realListing);
    const listing = WorkspaceFileListing.of({
      ...base,
      list: (request) =>
        Effect.suspend(() => {
          requests.push(request);
          return base.list(request);
        }),
    });
    const index = yield* makeFileIndexModule({
      platform: process.platform,
      watchHost: watch.host,
      publish: (message) => {
        log.push(message);
        Queue.offerUnsafe(outbox, message);
      },
      onUpdated: (state) => Queue.offer(updates, state).pipe(Effect.asVoid),
      ...(input.limits ? { limits: input.limits } : {}),
      ...(input.timings ? { timings: input.timings } : {}),
    }).pipe(Effect.provideService(WorkspaceFileListing, listing));
    /** Sends a query and returns its last results once it completes. */
    const search = (sessionId: string, seq: number, query: string) =>
      Effect.gen(function* () {
        yield* index.query(sessionId, seq, query);
        let files: readonly FileSearchResult[] = [];
        while (true) {
          const message = yield* Queue.take(outbox);
          if (message.type !== "session" || message.sessionId !== sessionId || message.seq !== seq)
            continue;
          if (message.outcome.kind === "updated") files = message.outcome.files;
          else
            return { outcome: message.outcome.kind, files, incomplete: message.outcome.incomplete };
        }
      });
    const names = (sessionId: string, seq: number, query: string) =>
      search(sessionId, seq, query).pipe(
        Effect.map(({ files }) => files.map((file) => `${file.match_type}:${file.path}`)),
      );
    return { index, watch, outbox, log, updates, requests, search, names };
  });

it.effect(
  "lists real files and inferred directories using repository ignores and file-name ranking",
  () =>
    Effect.gen(function* () {
      const root = yield* temporaryRoot({
        ".gitignore": "ignored-alpha.ts\n",
        ".ignore": "ignored-by-dot-alpha.ts\n",
        ".hidden/Alpha.ts": "",
        "docs/alpha-guide.md": "",
        "docs/RemoteAlpha.ts": "",
        "folder-alpha/index.ts": "",
        "ignored-alpha.ts": "",
        "ignored-by-dot-alpha.ts": "",
        "normal.txt": "",
        "src/main/file-index-worker/file-index-module.ts": "",
        "node_modules/alpha/index.js": "",
      });
      const { index, search } = yield* makeHarness();
      yield* index.open("local-fixture", [root]);
      const result = yield* search("local-fixture", 1, "alpha");
      assert.equal(result.outcome, "completed");
      const visible = result.files;
      assert.deepEqual(
        visible.map((file) => file.path),
        [
          ".hidden/Alpha.ts",
          "docs/alpha-guide.md",
          "docs/RemoteAlpha.ts",
          "folder-alpha",
          "folder-alpha/index.ts",
        ],
      );
      assert.isTrue(visible.every((file) => file.root === root));
      assert.deepEqual(
        visible.find((file) => file.file_name === "Alpha.ts")?.indices,
        [8, 9, 10, 11, 12],
      );
      assert.equal(
        visible.find((file) => file.file_name === "folder-alpha")?.match_type,
        "directory",
      );
      assert.isFalse(
        result.files.some(
          (file) => file.path.includes("ignored") || file.path.includes("node_modules"),
        ),
      );
      const fuzzy = yield* search("local-fixture", 2, "fileindxmod");
      assert.equal(fuzzy.files[0]?.path, "src/main/file-index-worker/file-index-module.ts");
    }),
);

it.effect("shares one index per root across sessions and releases it once idle", () =>
  Effect.gen(function* () {
    const files = ["Alpha.ts", "src/alpha-two.ts", "src/bravo.ts", "docs/alpha.md"];
    const { index, watch, requests, names } = yield* makeHarness({
      listing: fixedListing({ "/repo": files }),
    });
    yield* index.open("picker", ["/repo"]);
    yield* index.open("palette", ["/repo"]);
    const picker = yield* names("picker", 1, "alpha");
    assert.deepEqual(yield* names("palette", 1, "alpha"), picker);
    assert.include(picker, "file:src/alpha-two.ts");
    assert.lengthOf(requests, 1);
    assert.deepEqual(
      (yield* index.inspect).map(({ root, sessions, entries }) => ({ root, sessions, entries })),
      [{ root: "/repo", sessions: 2, entries: files.length + 2 }],
    );

    yield* index.close("picker");
    yield* index.close("palette");
    yield* index.open("picker-again", ["/repo"]);
    assert.deepEqual(yield* names("picker-again", 1, "alpha"), picker);
    assert.lengthOf(requests, 1, "reopening within the idle window reuses the index");
    yield* index.close("picker-again");

    yield* TestClock.adjust(FILE_INDEX_TIMINGS.idleRelease);
    assert.equal(yield* Queue.take(watch.released), "/repo");
    assert.deepEqual(yield* index.inspect, []);
    yield* index.open("later", ["/repo"]);
    yield* names("later", 1, "alpha");
    assert.lengthOf(requests, 2);
  }),
);

it.effect(
  "publishes while indexing, supersedes the old query, and keeps listing until the root is released",
  () =>
    Effect.gen(function* () {
      const firstBatch = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const { index, outbox } = yield* makeHarness({
        listing: WorkspaceFileListing.of({
          list: (request) =>
            Deferred.await(firstBatch).pipe(
              Effect.andThen(request.onPaths(["Alpha.ts", "folder/Bravo.ts"])),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
            ),
          readDirectory: () => Effect.die("unexpected directory read"),
          pathKind: () => Effect.die("unexpected path inspection"),
        }),
      });
      yield* index.open("incremental", ["/root"]);
      yield* index.query("incremental", 1, "alpha");
      yield* Deferred.succeed(firstBatch, undefined);
      const incremental = yield* Queue.take(outbox);
      assert.deepEqual(incremental, {
        type: "session",
        sessionId: "incremental",
        seq: 1,
        outcome: {
          kind: "updated",
          files: [
            {
              root: "/root",
              path: "Alpha.ts",
              file_name: "Alpha.ts",
              match_type: "file",
              score: 65_536 + 134,
              indices: [0, 1, 2, 3, 4],
            },
          ],
        },
      });
      yield* index.query("incremental", 2, "bravo");
      const replacement = yield* Queue.take(outbox);
      assert.equal(replacement.type === "session" && replacement.seq, 2);
      assert.deepEqual(
        replacement.type === "session" &&
          replacement.outcome.kind === "updated" &&
          replacement.outcome.files.map((file) => file.path),
        ["folder/Bravo.ts"],
      );
      yield* index.close("incremental");
      assert.isFalse(yield* Deferred.isDone(stopped), "a closed search leaves the shared listing");
      yield* TestClock.adjust(FILE_INDEX_TIMINGS.idleRelease);
      yield* Deferred.await(stopped);
      assert.lengthOf(yield* Queue.clear(outbox), 0);
    }),
);

it.effect("stops ranking superseded queries and closed sessions", () =>
  Effect.gen(function* () {
    const files = Array.from({ length: 8_000 }, (_, index) => `src/file-${index}.ts`);
    const { index, log, search } = yield* makeHarness({
      listing: fixedListing({ "/repo": files }),
    });
    yield* index.open("search", ["/repo"]);
    assert.equal((yield* search("search", 1, "file")).outcome, "completed");

    yield* index.query("search", 2, "file");
    const latest = yield* search("search", 3, "file-7");
    yield* index.query("search", 4, "file");
    yield* index.close("search");
    // A later search gives any ranking that was not stopped time to keep scanning.
    yield* index.open("later", ["/repo"]);
    assert.equal((yield* search("later", 1, "file")).outcome, "completed");

    assert.include(latest.files[0]?.path ?? "", "file-7");
    const answered = log.flatMap((message) =>
      message.type === "session" ? [`${message.seq}:${message.outcome.kind}`] : [],
    );
    assert.notInclude(answered, "2:completed");
    assert.notInclude(answered, "4:completed");
  }),
);

it.effect("bounds each root and the resident total, releasing idle roots first", () =>
  Effect.gen(function* () {
    const flat = (count: number) => Array.from({ length: count }, (_, index) => `f${index}`);
    const { index, watch, requests, names } = yield* makeHarness({
      listing: fixedListing({ "/a": flat(3), "/b": flat(3), "/c": flat(15), "/d": flat(8) }),
      limits: {
        root: { entries: 10, pathUnits: 1_000 },
        resident: { entries: 15, pathUnits: 1_500 },
      },
    });
    const entries = Effect.map(index.inspect, (roots) =>
      Object.fromEntries(roots.map((root) => [root.root, root.entries])),
    );
    const searchOnce = (root: string) =>
      index.open(root, [root]).pipe(Effect.andThen(names(root, 1, "f")));
    yield* searchOnce("/a");
    yield* index.close("/a");
    yield* TestClock.adjust("1 second");
    yield* searchOnce("/b");
    yield* index.close("/b");
    yield* searchOnce("/c");
    // /a was idle longest, so it makes room; /c stops at the per-root bound.
    assert.equal(yield* Queue.take(watch.released), "/a");
    assert.deepEqual(yield* entries, { "/b": 3, "/c": 10 });

    yield* searchOnce("/d");
    assert.equal(yield* Queue.take(watch.released), "/b");
    // /c is still searched, so /d gets only what the resident bound leaves.
    assert.deepEqual(yield* entries, { "/c": 10, "/d": 5 });
    assert.lengthOf(requests, 4);
  }),
);

const listingError = (reason: WorkspaceFileListingError["reason"]) =>
  new WorkspaceFileListingError({ message: "Could not list workspace files", reason });

it.effect("reacquires a failed root on the next query in the same session", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const listing = fixedListing({ "/repo": ["Alpha.ts"] });
    const { index, search, requests } = yield* makeHarness({
      listing: WorkspaceFileListing.of({
        ...listing,
        list: (request) =>
          ++attempts === 1
            ? Effect.succeed({ kind: "failed", aliases: [], error: listingError("unreadable") })
            : listing.list(request),
      }),
    });
    yield* index.open("first", ["/repo"]);
    const failed = yield* search("first", 1, "alpha");
    assert.deepEqual(failed, {
      outcome: "completed",
      files: [],
      incomplete: { reason: "unreadable", root: "/repo" },
    });
    const recovered = yield* search("first", 2, "alpha");
    assert.isUndefined(recovered.incomplete);
    assert.deepEqual(
      recovered.files.map((file) => file.path),
      ["Alpha.ts"],
    );
    assert.lengthOf(requests, 2);
    assert.deepEqual(
      (yield* index.inspect).map((root) => root.sessions),
      [1],
    );
    yield* index.close("first");
    assert.deepEqual(
      (yield* index.inspect).map((root) => root.sessions),
      [0],
    );
    assert.deepEqual((yield* search("unknown", 1, "alpha")).incomplete, { reason: "unavailable" });
  }),
);

it.effect("returns healthy roots and reports the first affected root in session order", () =>
  Effect.gen(function* () {
    const listing = fixedListing({ "/repo": ["Alpha.ts"] });
    const { index, search } = yield* makeHarness({
      listing: WorkspaceFileListing.of({
        ...listing,
        list: (request) => {
          if (request.root === "/repo") return listing.list(request);
          const reason = request.root === "/missing" ? "missing" : "unreadable";
          return Effect.succeed({ kind: "failed", aliases: [], error: listingError(reason) });
        },
      }),
    });
    yield* index.open("first", ["/missing", "/repo", "/private"]);
    yield* index.open("second", ["/private", "/missing", "/repo"]);
    const first = yield* search("first", 1, "alpha");
    const second = yield* search("second", 1, "alpha");
    assert.deepEqual(first.incomplete, { reason: "missing", root: "/missing" });
    assert.deepEqual(second.incomplete, { reason: "unreadable", root: "/private" });
    assert.deepEqual(
      first.files.map((file) => [file.root, file.path]),
      [["/repo", "Alpha.ts"]],
    );
    assert.deepEqual(second.files, first.files);
  }),
);

it.effect("keeps matches from cut-short and capacity-limited listings", () =>
  Effect.gen(function* () {
    const listing = fixedListing({
      "/large": ["Alpha.ts", "Alpha-2.ts"],
      "/short": ["Alpha-3.ts"],
    });
    const { index, search } = yield* makeHarness({
      listing: WorkspaceFileListing.of({
        ...listing,
        list: (request) =>
          request.root === "/short"
            ? listing.list(request).pipe(
                Effect.as({
                  kind: "cut-short",
                  aliases: [],
                  error: listingError("unavailable"),
                } as const),
              )
            : listing.list(request),
      }),
      limits: {
        root: { entries: 1, pathUnits: 100 },
        resident: { entries: 4, pathUnits: 400 },
      },
    });
    yield* index.open("large", ["/large"]);
    yield* index.open("short", ["/short"]);
    const large = yield* search("large", 1, "alpha");
    const short = yield* search("short", 1, "alpha");
    assert.deepEqual(large.incomplete, { reason: "too-large", root: "/large" });
    assert.deepEqual(
      large.files.map((file) => file.path),
      ["Alpha.ts"],
    );
    assert.deepEqual(short.incomplete, { reason: "too-large", root: "/short" });
    assert.deepEqual(
      short.files.map((file) => file.path),
      ["Alpha-3.ts"],
    );
  }),
);

it.effect(
  "preserves the index on refresh failure and clears a capacity limit after a full relist fits",
  () =>
    Effect.gen(function* () {
      const trees = { "/repo": ["Alpha.ts"] };
      const listing = fixedListing(trees);
      let cutShort = false;
      const { index, watch, updates, search } = yield* makeHarness({
        listing: WorkspaceFileListing.of({
          ...listing,
          list: (request) =>
            listing.list(request).pipe(
              Effect.map((result) =>
                cutShort
                  ? ({
                      kind: "cut-short",
                      aliases: [],
                      error: listingError("unavailable"),
                    } as const)
                  : result,
              ),
            ),
          readDirectory: () => Effect.succeed([]),
        }),
        limits: {
          root: { entries: 2, pathUnits: 100 },
          resident: { entries: 4, pathUnits: 400 },
        },
      });
      const relist = watch
        .change("/repo")
        .pipe(
          Effect.andThen(TestClock.adjust(FILE_INDEX_TIMINGS.changeMaxDelay)),
          Effect.andThen(Queue.take(updates)),
        );
      yield* index.open("search", ["/repo"]);
      assert.isUndefined((yield* search("search", 1, "alpha")).incomplete);
      trees["/repo"] = ["folder/Alpha.ts", "folder/Alpha-2.ts"];
      yield* relist;
      assert.deepEqual((yield* search("search", 2, "alpha")).incomplete, {
        reason: "too-large",
        root: "/repo",
      });
      trees["/repo"] = ["Alpha.ts"];
      yield* relist;
      const recovered = yield* search("search", 3, "alpha");
      assert.isUndefined(recovered.incomplete);
      assert.deepEqual(
        recovered.files.map((file) => file.path),
        ["Alpha.ts"],
      );

      cutShort = true;
      trees["/repo"] = ["Alpha-after-cut-short.ts"];
      yield* relist;
      assert.deepEqual(yield* search("search", 4, "alpha"), recovered);
    }),
);

it.effect("does not keep a root it cannot watch once nobody searches it", () =>
  Effect.gen(function* () {
    const { index, names, requests } = yield* makeHarness({
      listing: fixedListing({ "/repo": ["Alpha.ts"] }),
      watchFails: true,
    });
    yield* index.open("first", ["/repo"]);
    assert.deepEqual(yield* names("first", 1, "alpha"), ["file:Alpha.ts"]);
    yield* index.close("first");
    assert.deepEqual(yield* index.inspect, []);
    yield* index.open("second", ["/repo"]);
    yield* names("second", 1, "alpha");
    assert.lengthOf(requests, 2);
  }),
);

it.live(
  "applies watched changes with ripgrep's ignore rules and without listing the root again",
  () =>
    Effect.gen(function* () {
      const root = yield* temporaryRoot({
        ".gitignore": "ignored/\n*.log\n",
        "README.md": "",
        "docs/guide.md": "",
        "ignored/skip.ts": "",
        "src/app/main.ts": "",
        "src/app/util.ts": "",
      });
      const { index, watch, updates, requests, names } = yield* makeHarness({
        timings: { changeSettle: "1 millis", changeMaxDelay: "20 millis" },
      });
      let seq = 0;
      const find = (query: string) => names("session", ++seq, query);
      const apply = (...changed: string[]) =>
        watch.change(root, ...changed).pipe(Effect.andThen(Queue.take(updates)));
      const fullListings = () =>
        requests.filter(
          (request) => request.directory === "" && request.excludedDirectories.length === 0,
        ).length;

      yield* index.open("session", [root]);
      assert.deepEqual(yield* find("main"), ["file:src/app/main.ts"]);

      yield* writeFiles(root, { "src/app/mainframe.ts": "", "src/app/debug.log": "" });
      yield* apply("src/app/mainframe.ts", "src/app/debug.log");
      assert.include(yield* find("mainframe"), "file:src/app/mainframe.ts");
      assert.deepEqual(yield* find("debug.log"), []);
      assert.equal(requests.at(-1)?.directory, "src/app");
      assert.deepEqual(requests.at(-1)?.excludedDirectories, []);

      yield* writeFiles(root, { "src/feature/deep/widget.ts": "", "ignored/more.ts": "" });
      yield* apply(
        "src/feature",
        "src/feature/deep",
        "src/feature/deep/widget.ts",
        "ignored/more.ts",
      );
      assert.deepEqual(yield* find("widget"), ["file:src/feature/deep/widget.ts"]);
      assert.include(yield* find("deep"), "directory:src/feature/deep");
      assert.deepEqual(yield* find("more"), []);
      assert.deepEqual(
        requests.slice(-2).map((request) => request.directory),
        ["src", ""],
        "the new folder walks under src; the ignored one is decided by its parent",
      );
      assert.deepEqual(requests.at(-2)?.excludedDirectories, ["src/app"]);

      const listingsBeforeRemoval = requests.length;
      yield* Effect.promise(() => rm(path.join(root, "src/feature"), { recursive: true }));
      yield* Effect.promise(() => rm(path.join(root, "src/app/mainframe.ts")));
      yield* apply(
        "src/feature/deep/widget.ts",
        "src/feature/deep",
        "src/feature",
        "src/app/mainframe.ts",
      );
      yield* writeFiles(root, { "src/app/main.ts": "edited" });
      yield* apply("src/app/main.ts");
      assert.deepEqual(yield* find("widget"), []);
      assert.deepEqual(yield* find("mainframe"), []);
      assert.notInclude(yield* find("feature"), "directory:src/feature");
      assert.lengthOf(requests, listingsBeforeRemoval, "removals and edits need no listing");
      assert.equal(fullListings(), 1);

      yield* writeFiles(root, { ".gitignore": "ignored/\n*.log\ndocs/\n" });
      yield* apply(".gitignore");
      assert.deepEqual(yield* find("guide"), []);
      assert.include(yield* find("main"), "file:src/app/main.ts");
      assert.equal(fullListings(), 2, "a root ignore file changes what every folder lists");
    }),
);
