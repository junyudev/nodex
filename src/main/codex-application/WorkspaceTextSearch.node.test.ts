import { assert, it } from "@effect/vitest";
import { mkdtemp, mkdir, rm, writeFile, chmod, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rgPath } from "@vscode/ripgrep";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { TestClock } from "effect/testing";
import type {
  WorkspaceTextSearchEvent,
  WorkspaceTextSearchRequest,
} from "../../shared/workspace-text-search";
import { CodexPlatform } from "../app/CodexApplicationLive";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import {
  live as platformLive,
  WorkspaceTextSearchPlatform,
  type WorkspaceTextSearchHost,
} from "../platform/node/WorkspaceTextSearchPlatform";
import { searchWorkspaceTextOnHost } from "./WorkspaceTextSearch";

// Test the real process boundary on the test host, independently of macOS app packaging.
const rgDirectory = path.dirname(rgPath);
const request = (
  roots: readonly string[],
  options: Partial<WorkspaceTextSearchRequest> = {},
): WorkspaceTextSearchRequest => ({
  requestId: "f3ebc134-7b2b-4c8d-8758-01e7b2a87065",
  hostId: "local",
  roots,
  query: "needle",
  ...options,
});
const temp = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-text-search-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
);
const runtimeLayer = (directory = rgDirectory, environmentPath = process.env.PATH) =>
  platformLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        mainConfigLayer({ platform: process.platform, environmentPath: environmentPath ?? null }),
        Layer.succeed(CodexPlatform, {
          runtime: { additionalSearchPaths: [directory] },
        } as unknown as CodexPlatform["Service"]),
      ),
    ),
  );
const collect = Effect.fnUntraced(function* (
  host: WorkspaceTextSearchHost,
  input: WorkspaceTextSearchRequest,
) {
  const events: WorkspaceTextSearchEvent[] = [];
  yield* searchWorkspaceTextOnHost(host, input, (event) =>
    Effect.sync(() => {
      events.push(event);
    }),
  );
  return events;
});

it.effect(
  "searches real hidden workspace text with literal smart case, masks, exclusions and UTF-16 locations",
  () =>
    Effect.gen(function* () {
      const root = yield* temp;
      yield* Effect.promise(async () => {
        await mkdir(path.join(root, "node_modules"));
        await writeFile(path.join(root, "node_modules", "dependency.ts"), "needle\n");
        await writeFile(path.join(root, ".hidden.ts"), "😀 Needle [x]\nneedle [x]\n");
        await writeFile(path.join(root, "other.txt"), "needle [x]\n");
        await writeFile(path.join(root, "excluded.ts"), "needle [x]\n");
      });
      const platform = yield* WorkspaceTextSearchPlatform;
      const host = yield* platform.open({ kind: "local", roots: [root] });
      const events = yield* collect(
        host,
        request([root], { query: "needle [x]", fileMask: "*.ts,!excluded.ts" }),
      );
      const matches = events.filter((event) => event.type === "match");
      assert.deepEqual(
        matches.map((event) => [event.match.relativePath, event.match.line, event.match.column]),
        [
          [".hidden.ts", 1, 4],
          [".hidden.ts", 2, 1],
        ],
      );
      assert.deepEqual(matches[0]?.match.matchRanges, [{ start: 3, end: 13 }]);
      assert.deepEqual(events.at(-1), {
        requestId: request([]).requestId,
        type: "done",
        limited: false,
      });
      const sensitive = yield* collect(
        host,
        request([root], { query: "Needle", fileMask: "*.ts" }),
      );
      assert.equal(sensitive.filter((event) => event.type === "match").length, 1);
    }).pipe(Effect.scoped, Effect.provide(runtimeLayer())),
);

it.effect.each([false, true])(
  "keeps dot-ignore, Git-ignore and explicit mask precedence with priority search %s",
  (prioritizeRecent) =>
    Effect.gen(function* () {
      const root = yield* temp;
      yield* Effect.promise(async () => {
        await Promise.all(
          [".git", "recent", "node_modules"].map((directory) => mkdir(path.join(root, directory))),
        );
        const files = {
          ".ignore": "dot-ignored.ts\n",
          ".rgignore": "rg-ignored.ts\n",
          ".gitignore": "git-ignored.ts\n",
          "visible.ts": "needle\n",
          "recent/dot-ignored.ts": "needle\n",
          "recent/rg-ignored.ts": "needle\n",
          "recent/git-ignored.ts": "needle\n",
          "recent/mask-excluded.ts": "needle\n",
          "node_modules/dependency.ts": "needle\n",
        };
        await Promise.all(
          Object.entries(files).map(([file, content]) => writeFile(path.join(root, file), content)),
        );
      });
      const platform = yield* WorkspaceTextSearchPlatform;
      const host = yield* platform.open({ kind: "local", roots: [root] });
      const priorityFolders = prioritizeRecent ? [path.join(root, "recent")] : [];
      const unfiltered = yield* collect(host, request([root], { priorityFolders }));
      assert.deepEqual(
        unfiltered
          .filter((event) => event.type === "match")
          .map((event) => event.match.relativePath)
          .sort(),
        ["recent/dot-ignored.ts", "recent/mask-excluded.ts", "recent/rg-ignored.ts", "visible.ts"],
      );
      const filtered = yield* collect(
        host,
        request([root], { priorityFolders, fileMask: "*.ts,!mask-excluded.ts" }),
      );
      assert.deepEqual(
        filtered
          .filter((event) => event.type === "match")
          .map((event) => event.match.relativePath)
          .sort(),
        ["recent/dot-ignored.ts", "recent/git-ignored.ts", "recent/rg-ignored.ts", "visible.ts"],
      );
    }).pipe(Effect.scoped, Effect.provide(runtimeLayer())),
);

it.effect(
  "searches priority folders first from the same root and stops at 100 matching lines across all roots",
  () =>
    Effect.gen(function* () {
      const root = yield* temp;
      yield* Effect.promise(async () => {
        await mkdir(path.join(root, "recent"));
        await writeFile(path.join(root, "recent", "active.ts"), "needle\n");
        await writeFile(path.join(root, "large.ts"), "needle\n".repeat(150));
      });
      const platform = yield* WorkspaceTextSearchPlatform;
      const host = yield* platform.open({ kind: "local", roots: [root] });
      const events = yield* collect(
        host,
        request([root, "/must-not-be-read"], { priorityFolders: [path.join(root, "recent")] }),
      );
      const matches = events.filter((event) => event.type === "match");
      assert.equal(matches.length, 100);
      assert.equal(matches[0]?.match.relativePath, "recent/active.ts");
      assert.deepEqual(events.at(-1), {
        requestId: request([]).requestId,
        type: "done",
        limited: true,
      });
    }).pipe(Effect.scoped, Effect.provide(runtimeLayer())),
);

it.effect("interrupting a live search terminates its process without a terminal result", () =>
  Effect.gen(function* () {
    const root = yield* temp;
    const started = yield* Deferred.make<number>();
    yield* Effect.promise(async () => {
      const executable = path.join(root, "rg");
      await writeFile(
        executable,
        `#!${process.execPath}\nconsole.log(process.pid);setInterval(()=>{},1000);\n`,
      );
      await chmod(executable, 0o700);
    });
    yield* Effect.gen(function* () {
      const platform = yield* WorkspaceTextSearchPlatform;
      const host = yield* platform.open({ kind: "local", roots: [root] });
      const fiber = yield* host
        .search(root, [], (line) => Deferred.succeed(started, Number(line)).pipe(Effect.as(true)))
        .pipe(Effect.forkChild);
      const pid = yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      assert.throws(() => process.kill(pid, 0), /ESRCH/u);
    }).pipe(Effect.provide(runtimeLayer(root)));
  }).pipe(Effect.scoped),
);

it.effect("times out a stalled search and terminates its child process", () =>
  Effect.gen(function* () {
    const root = yield* temp;
    const started = yield* Deferred.make<number>();
    yield* Effect.promise(async () => {
      const executable = path.join(root, "rg");
      await writeFile(
        executable,
        `#!${process.execPath}\nconsole.log(process.pid);setInterval(()=>{},1000);\n`,
      );
      await chmod(executable, 0o700);
    });
    yield* Effect.gen(function* () {
      const platform = yield* WorkspaceTextSearchPlatform;
      const host = yield* platform.open({ kind: "local", roots: [root] });
      const fiber = yield* host
        .search(root, [], (line) => Deferred.succeed(started, Number(line)).pipe(Effect.as(true)))
        .pipe(Effect.result, Effect.forkChild);
      const pid = yield* Deferred.await(started);
      yield* TestClock.adjust(30_001);
      const result = yield* Fiber.join(fiber);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.message, "File search timed out");
      assert.throws(() => process.kill(pid, 0), /ESRCH/u);
    }).pipe(Effect.provide(runtimeLayer(root)));
  }).pipe(Effect.scoped),
);

it.effect("bounds complete stderr output even after its retained diagnostic preview is full", () =>
  Effect.gen(function* () {
    const root = yield* temp;
    const started = yield* Deferred.make<number>();
    yield* Effect.promise(async () => {
      const executable = path.join(root, "rg");
      await writeFile(
        executable,
        `#!${process.execPath}\nconsole.log(process.pid); const chunk=Buffer.alloc(1024*1024,65); let count=0; function pump(){ while(count++<129){ if(!process.stderr.write(chunk)) return process.stderr.once('drain',pump); } } pump(); setInterval(()=>{},1000);\n`,
      );
      await chmod(executable, 0o700);
    });
    yield* Effect.gen(function* () {
      const platform = yield* WorkspaceTextSearchPlatform;
      const host = yield* platform.open({ kind: "local", roots: [root] });
      const fiber = yield* host
        .search(root, [], (line) => Deferred.succeed(started, Number(line)).pipe(Effect.as(true)))
        .pipe(Effect.result, Effect.forkChild);
      const pid = yield* Deferred.await(started);
      const result = yield* Fiber.join(fiber);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result))
        assert.equal(result.failure.message, "File search exceeded its output limit");
      assert.throws(() => process.kill(pid, 0), /ESRCH/u);
    }).pipe(Effect.provide(runtimeLayer(root)));
  }).pipe(Effect.scoped),
);

it.effect(
  "connected search excludes a project-controlled PATH executable and follows the trusted executable",
  () =>
    Effect.gen(function* () {
      const directory = yield* temp;
      const root = path.join(directory, "project");
      const trusted = path.join(directory, "trusted");
      const client = path.join(directory, "client");
      yield* Effect.promise(async () => {
        await mkdir(root);
        await mkdir(trusted);
        await mkdir(client);
        await writeFile(path.join(root, "text.txt"), "needle\n");
        await writeFile(path.join(root, "rg"), "#!/bin/sh\nexit 93\n");
        await chmod(path.join(root, "rg"), 0o700);
        await symlink(path.join(rgDirectory, "rg"), path.join(trusted, "untrusted-link"));
        const { copyFile } = await import("node:fs/promises");
        await copyFile(path.join(rgDirectory, "rg"), path.join(trusted, "rg"));
        await chmod(path.join(trusted, "rg"), 0o700);
        await writeFile(
          path.join(client, "ssh"),
          '#!/bin/sh\nfor arg do command=$arg; done\nexec /bin/sh -c "$command"\n',
        );
        await chmod(path.join(client, "ssh"), 0o700);
      });
      yield* Effect.gen(function* () {
        const platform = yield* WorkspaceTextSearchPlatform;
        const host = yield* platform.open({
          kind: "ssh",
          roots: [root],
          codexHome: path.join(directory, "codex"),
          config: {
            id: "ssh:test",
            kind: "ssh",
            displayName: "Test",
            sshAlias: "test",
            port: null,
            managedRoot: root,
            repositoryRoots: [root],
            codexBinary: null,
            codexHome: null,
            enabled: true,
          },
        });
        assert.equal(
          host.executable,
          yield* Effect.promise(() => realpath(path.join(trusted, "rg"))),
        );
        const events = yield* collect(host, request([root]));
        assert.equal(events.filter((event) => event.type === "match").length, 1);
      }).pipe(
        Effect.provide(
          runtimeLayer(rgDirectory, [client, root, trusted, "/usr/bin", "/bin"].join(":")),
        ),
      );
    }).pipe(Effect.scoped),
);
