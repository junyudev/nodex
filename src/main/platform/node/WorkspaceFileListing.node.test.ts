import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import { rgPath } from "@vscode/ripgrep";
import * as Effect from "effect/Effect";
import { layer, WorkspaceFileListing } from "./WorkspaceFileListing";

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-workspace-listing-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
);

const walk = Effect.fnUntraced(function* (
  root: string,
  input: {
    readonly executable?: string;
    readonly knownAliases?: readonly string[];
    readonly keepGoing?: boolean;
  } = {},
) {
  const paths: string[] = [];
  const result = yield* Effect.gen(function* () {
    const listing = yield* WorkspaceFileListing;
    return yield* listing.list({
      root,
      directory: "",
      excludedDirectories: [],
      knownAliases: input.knownAliases ?? [],
      onPaths: (batch) =>
        Effect.sync(() => {
          paths.push(...batch);
          return input.keepGoing ?? true;
        }),
    });
  }).pipe(Effect.provide(layer({ executable: input.executable ?? rgPath, environment: {} })));
  return { result, paths: [...new Set(paths)].sort() };
});

// File symlinks on Windows need privileges that may be absent on a test host.
it.effect.skipIf(process.platform === "win32")(
  "prunes in-root directory aliases and still follows outside directories and file links",
  () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const root = path.join(directory, "workspace");
      const outside = path.join(directory, "outside");
      yield* Effect.promise(async () => {
        await mkdir(path.join(root, ".git"), { recursive: true });
        await mkdir(path.join(root, "target", "ignored"), { recursive: true });
        await mkdir(outside);
        await writeFile(path.join(root, ".gitignore"), "/target/ignored/\n");
        await writeFile(path.join(root, "target", "inside.txt"), "");
        await writeFile(path.join(root, "target", "ignored", "hidden.txt"), "");
        await writeFile(path.join(outside, "outside.txt"), "");
        await symlink("target", path.join(root, ".alias[1]"), "dir");
        await symlink(outside, path.join(root, "external"), "dir");
        await symlink(path.join(root, "target"), path.join(outside, "return"), "dir");
        await symlink("target/inside.txt", path.join(root, "file-link.txt"), "file");
        await symlink(
          path.join(outside, "outside.txt"),
          path.join(root, "external-file.txt"),
          "file",
        );
        await symlink(root, path.join(root, "loop"), "dir");
      });
      const initial = yield* walk(root);
      assert.equal(initial.result.kind, "completed");
      assert.sameMembers([...initial.result.aliases], [".alias[1]", "external/return"]);
      assert.deepEqual(initial.paths, [
        ".gitignore",
        "external-file.txt",
        "external/outside.txt",
        "file-link.txt",
        "target/inside.txt",
      ]);

      const refresh = yield* walk(root, { knownAliases: initial.result.aliases });
      assert.deepEqual(refresh.paths, initial.paths);
      assert.sameMembers([...refresh.result.aliases], [...initial.result.aliases]);

      yield* Effect.promise(async () => {
        await unlink(path.join(root, ".alias[1]"));
        await symlink(outside, path.join(root, ".alias[1]"), "dir");
      });
      const retargeted = yield* walk(root, { knownAliases: refresh.result.aliases });
      assert.include(retargeted.paths, ".alias[1]/outside.txt");
      assert.notInclude(retargeted.result.aliases, ".alias[1]");
      assert.include(retargeted.result.aliases, ".alias[1]/return");
    }),
);

it.effect("distinguishes an absent root, a file as root, and an unavailable executable", () =>
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const absent = path.join(directory, "absent");
    const file = path.join(directory, "file.txt");
    yield* Effect.promise(() => writeFile(file, ""));
    for (const root of [absent, file]) {
      const { result } = yield* walk(root);
      assert.equal(result.kind, "failed");
      if (result.kind === "failed") assert.equal(result.error.reason, "missing");
    }
    const { result } = yield* walk(directory, { executable: absent });
    assert.equal(result.kind, "failed");
    if (result.kind === "failed") assert.equal(result.error.reason, "unavailable");
  }),
);

it.effect.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "reports a root with no traversal permission as unreadable",
  () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      yield* Effect.acquireRelease(
        Effect.promise(() => chmod(root, 0o000)),
        () => Effect.promise(() => chmod(root, 0o700)),
      );
      const { result } = yield* walk(root);
      assert.equal(result.kind, "failed");
      if (result.kind === "failed") assert.equal(result.error.reason, "unreadable");
    }),
);

it.effect.skipIf(process.platform === "win32")(
  "keeps the paths delivered before an abnormal exit and distinguishes a caller stop",
  () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const root = path.join(directory, "root");
      const executable = path.join(directory, "rg");
      yield* Effect.promise(async () => {
        await mkdir(root);
        await writeFile(path.join(root, "file.txt"), "");
        await writeFile(executable, `#!/bin/sh\n${JSON.stringify(rgPath)} "$@"\nexit 3\n`, {
          mode: 0o700,
        });
      });
      const interrupted = yield* walk(root, { executable });
      assert.equal(interrupted.result.kind, "cut-short");
      assert.deepEqual(interrupted.paths, ["file.txt"]);
      const stopped = yield* walk(root, { keepGoing: false });
      assert.equal(stopped.result.kind, "stopped");
      assert.deepEqual(stopped.paths, ["file.txt"]);
    }),
);
