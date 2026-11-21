import { assert, it } from "@effect/vitest";
import { rgPath } from "@vscode/ripgrep";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type { FileSearchEvent } from "../../shared/file-search";
import { createFuzzyQueryScorer } from "../../shared/fuzzy-query-match";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import { RipgrepExecutionRuntime } from "../platform/node/RipgrepExecutionRuntime";
import {
  live as platformLive,
  WorkspaceTextSearchPlatform,
} from "../platform/node/WorkspaceTextSearchPlatform";
import { makeLocalFileSearchSession } from "./FileSearch";

it.effect(
  "lists real files and inferred directories using repository ignores and the shared name matcher",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-file-search-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      );
      const files = [
        ".hidden/Alpha.ts",
        "docs/alpha-guide.md",
        "docs/RemoteAlpha.ts",
        "folder-alpha/index.ts",
        "ignored-alpha.ts",
        "ignored-by-dot-alpha.ts",
        "normal.txt",
        "node_modules/alpha/index.js",
      ];
      yield* Effect.promise(async () => {
        await mkdir(path.join(root, ".git"));
        await writeFile(path.join(root, ".gitignore"), "ignored-alpha.ts\n");
        await writeFile(path.join(root, ".ignore"), "ignored-by-dot-alpha.ts\n");
        await Promise.all(
          files.map(async (file) => {
            await mkdir(path.dirname(path.join(root, file)), { recursive: true });
            await writeFile(path.join(root, file), "");
          }),
        );
      });
      const events: FileSearchEvent[] = [];
      const done = yield* Deferred.make<void>();
      const session = yield* makeLocalFileSearchSession(
        { hostId: "local", roots: [root], sessionId: "local-fixture" },
        (event) =>
          Effect.sync(() => {
            events.push(event);
          }).pipe(
            Effect.andThen(
              event.method === "fuzzyFileSearch/sessionUpdated"
                ? Effect.void
                : Deferred.succeed(done, undefined),
            ),
            Effect.asVoid,
          ),
        process.platform === "win32",
      ).pipe(
        Effect.provide(
          platformLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                mainConfigLayer({ platform: process.platform, arch: process.arch }),
                Layer.succeed(RipgrepExecutionRuntime, { resolve: Effect.succeed(rgPath) }),
              ),
            ),
          ),
        ),
      );
      yield* session.update("alpha");
      yield* Deferred.await(done);
      assert.equal(events.at(-1)?.method, "fuzzyFileSearch/sessionCompleted");
      const filesEvent = events.findLast(
        (event) => event.method === "fuzzyFileSearch/sessionUpdated",
      );
      const score = createFuzzyQueryScorer("alpha");
      const visible = filesEvent?.params.files.filter((file) => score(file.file_name) > 0) ?? [];
      const names = ["Alpha.ts", "alpha-guide.md", "RemoteAlpha.ts", "folder-alpha"].sort(
        (left, right) => score(right) - score(left) || (left < right ? -1 : 1),
      );
      assert.deepEqual(
        visible.map((file) => file.file_name),
        names,
      );
      assert.deepEqual(
        visible.map((file) => file.score),
        names.map(score),
      );
      assert.deepEqual(
        visible.find((file) => file.file_name === "Alpha.ts")?.indices,
        [8, 9, 10, 11, 12],
      );
      assert.equal(
        visible.find((file) => file.file_name === "folder-alpha")?.match_type,
        "directory",
      );
      assert.isFalse(
        filesEvent?.params.files.some(
          (file) => file.path.includes("ignored") || file.path.includes("node_modules"),
        ),
      );
    }),
);

it.effect(
  "publishes during indexing, supersedes the old query, and interrupts enumeration on close",
  () =>
    Effect.gen(function* () {
      const firstBatch = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const events = yield* Queue.unbounded<FileSearchEvent>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeLocalFileSearchSession(
            { hostId: "local", roots: ["/root"], sessionId: "incremental" },
            (event) => Queue.offer(events, event).pipe(Effect.asVoid),
            false,
          ).pipe(
            Effect.provideService(WorkspaceTextSearchPlatform, {
              open: () => Effect.die("unexpected text search"),
              listLocalFiles: (_root, onPaths) =>
                Deferred.await(firstBatch).pipe(
                  Effect.andThen(onPaths(["Alpha.ts", "folder/Bravo.ts"])),
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
                ),
            }),
          );
          yield* session.update("alpha");
          yield* Deferred.succeed(firstBatch, undefined);
          const incremental = yield* Queue.take(events);
          assert.equal(incremental.method, "fuzzyFileSearch/sessionUpdated");
          assert.deepEqual(
            incremental.method === "fuzzyFileSearch/sessionUpdated" &&
              incremental.params.files.map((file) => file.file_name),
            ["Alpha.ts"],
          );
          yield* session.update("bravo");
          const replacement = yield* Queue.take(events);
          assert.equal(replacement.method, "fuzzyFileSearch/sessionUpdated");
          assert.deepEqual(
            replacement.method === "fuzzyFileSearch/sessionUpdated" &&
              replacement.params.files.map((file) => file.file_name),
            ["Bravo.ts"],
          );
        }),
      );
      assert.isTrue(yield* Deferred.isDone(stopped));
    }),
);
