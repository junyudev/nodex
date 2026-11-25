import { describe, afterEach, expect, test, vi } from "vite-plus/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile, chmod, mkdir, unlink } from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readRuntimeArtifactSha256,
  readRuntimeInspectionCommand,
  verifyRuntimeArtifacts,
} from "./RuntimeArtifactVerification";
import { assert, it } from "@effect/vitest";
import { rgPath } from "@vscode/ripgrep";
import * as Effect from "effect/Effect";
import { layer, WorkspaceFileListing } from "./WorkspaceFileListing";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { makeTemporarySqlite } from "./TemporarySqlite";
import { gzipSync } from "node:zlib";
import { it as itWorkspaceTextSearchPlatform } from "vitest";
import { decodePinnedRipgrepArchive } from "./WorkspaceTextSearchPlatform";

describe("RuntimeArtifactVerification", () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
      resolve = complete;
    });
    return { promise, resolve };
  }

  const roots: string[] = [];
  const temporaryRoot = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nodex-runtime-verification-"));
    roots.push(root);
    return root;
  };
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("verifies concurrently within a fixed resource budget and preserves manifest order", async () => {
    const gate = deferred();
    const firstWave = deferred();
    let active = 0;
    let peak = 0;
    const pending = verifyRuntimeArtifacts(
      Array.from({ length: 24 }, (_, index) => index),
      async (index) => {
        active++;
        peak = Math.max(peak, active);
        if (active === 8) firstWave.resolve();
        await gate.promise;
        active--;
        return index * 2;
      },
    );
    try {
      await firstWave.promise;
      expect(active).toBe(8);
    } finally {
      gate.resolve();
    }
    expect(await pending).toEqual(Array.from({ length: 24 }, (_, index) => index * 2));
    expect(peak).toBe(8);
    expect(active).toBe(0);
  });

  test("cancellation stops admission and waits for every in-flight operation", async () => {
    const controller = new AbortController();
    const gate = deferred();
    const firstWave = deferred();
    let started = 0;
    let finished = 0;
    let settled = false;
    const pending = verifyRuntimeArtifacts(
      Array.from({ length: 24 }, (_, index) => index),
      async () => {
        if (++started === 8) firstWave.resolve();
        await gate.promise;
        finished++;
      },
      controller.signal,
    );
    const outcome = pending
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await firstWave.promise;
      controller.abort(new Error("startup stopped"));
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(started).toBe(8);
    } finally {
      gate.resolve();
    }
    expect(await outcome).toBe(controller.signal.reason);
    expect(finished).toBe(8);
    expect(started).toBe(8);
  });

  test("hashes the complete payload and refuses symlink substitution", async () => {
    const root = await temporaryRoot();
    const artifact = path.join(root, "artifact");
    const payload = Buffer.alloc(3 * 1024 * 1024 + 7, 0x6b);
    await writeFile(artifact, payload);
    expect(await readRuntimeArtifactSha256(artifact)).toBe(
      createHash("sha256").update(payload).digest("hex"),
    );
    const linked = path.join(root, "linked");
    await symlink(artifact, linked);
    await expect(readRuntimeArtifactSha256(linked)).rejects.toThrow();
  });

  test("cancels a native inspector and joins its exit before rejecting", async () => {
    const root = await temporaryRoot();
    const pidFile = path.join(root, "pid");
    const controller = new AbortController();
    const pending = readRuntimeInspectionCommand(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
        pidFile,
      ],
      controller.signal,
    );
    const outcome = pending.catch((error: unknown) => error);
    let pid = 0;
    try {
      await vi.waitFor(async () => {
        pid = Number(await readFile(pidFile, "utf8"));
        expect(pid).toBeGreaterThan(0);
      });
      controller.abort(new Error("startup stopped"));
      expect(await outcome).toBe(controller.signal.reason);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      await outcome;
    }
  });

  test("reports an inspector spawn failure without leaving a pending operation", async () => {
    await expect(
      readRuntimeInspectionCommand("/nonexistent/nodex-inspector", []),
    ).rejects.toThrow();
  });

  test("names why an inspector failed: its own last words or the time limit", async () => {
    await expect(
      readRuntimeInspectionCommand(process.execPath, [
        "-e",
        "process.stderr.write('artifact: invalid signature (code or signature have been modified)'); process.exit(3)",
      ]),
    ).rejects.toThrow(/exited with 3: artifact: invalid signature \(code or signature/);
    await expect(
      readRuntimeInspectionCommand(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        undefined,
        200,
      ),
    ).rejects.toThrow(/did not finish within 0\.2s/);
  });
});

describe("WorkspaceFileListing", () => {
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
});

describe("TemporarySqlite", () => {
  it.effect("rolls back incomplete index admission after failure or cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeTemporarySqlite;
        yield* db.execute("CREATE TABLE facts(id TEXT PRIMARY KEY)");
        yield* db.transaction(db.execute("INSERT INTO facts VALUES(?)", ["confirmed"]));
        const failed = yield* db
          .transaction(
            db
              .execute("INSERT INTO facts VALUES(?)", ["failed"])
              .pipe(Effect.andThen(Effect.fail("rejected"))),
          )
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        const admitted = yield* Deferred.make<void>();
        const writer = yield* db
          .transaction(
            db
              .execute("INSERT INTO facts VALUES(?)", ["cancelled"])
              .pipe(
                Effect.andThen(Deferred.succeed(admitted, undefined)),
                Effect.andThen(Effect.never),
              ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(admitted);
        yield* Fiber.interrupt(writer);
        assert.deepEqual(yield* db.rows<{ id: string }>("SELECT id FROM facts ORDER BY id"), [
          { id: "confirmed" },
        ]);
        yield* db.transaction(db.execute("INSERT INTO facts VALUES(?)", ["resumed"]));
        assert.equal((yield* db.rows("SELECT id FROM facts")).length, 2);
      }),
    ),
  );

  it.effect("releases each private index with its lexical scope", () =>
    Effect.gen(function* () {
      const closed = yield* Effect.scoped(
        Effect.gen(function* () {
          const db = yield* makeTemporarySqlite;
          yield* db.execute("CREATE TABLE facts(id TEXT)");
          return db;
        }),
      );
      assert.equal((yield* closed.rows("SELECT * FROM facts").pipe(Effect.result))._tag, "Failure");
      const isolated = yield* Effect.scoped(
        makeTemporarySqlite.pipe(
          Effect.flatMap((db) => db.rows("SELECT name FROM sqlite_master WHERE name='facts'")),
        ),
      );
      assert.isEmpty(isolated);
    }),
  );
});

describe("WorkspaceTextSearchPlatform", () => {
  const it = itWorkspaceTextSearchPlatform;
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  function fixture(type: number = 48, duplicate = false) {
    const binary = Buffer.from("verified-executable");
    const header = Buffer.alloc(512);
    header.write("ripgrep-15.2.0-test-target/rg");
    header.write(binary.length.toString(8).padStart(11, "0"), 124);
    header[156] = type;
    const entry = Buffer.concat([header, binary, Buffer.alloc(512 - binary.length)]);
    const archive = gzipSync(
      Buffer.concat([entry, ...(duplicate ? [entry] : []), Buffer.alloc(1024)]),
    );
    return {
      archive,
      binary,
      pin: {
        archive: {
          sha256: sha256(archive),
          size: archive.length,
          member: "ripgrep-15.2.0-test-target/rg",
          url: "",
        },
        binarySha256: sha256(binary),
        binarySize: binary.length,
      },
    };
  }

  it("extracts only the pinned executable and verifies both the archive and extracted bytes", async () => {
    const { archive, binary, pin } = fixture();
    expect(await decodePinnedRipgrepArchive(archive, pin)).toEqual(binary);
    await expect(
      decodePinnedRipgrepArchive(archive, {
        ...pin,
        archive: { ...pin.archive, size: archive.length + 1 },
      }),
    ).rejects.toThrow("archive verification");
    await expect(
      decodePinnedRipgrepArchive(archive, { ...pin, archive: { ...pin.archive, sha256: "bad" } }),
    ).rejects.toThrow("archive verification");
    await expect(
      decodePinnedRipgrepArchive(archive, { ...pin, binarySha256: "bad" }),
    ).rejects.toThrow("executable verification");
    await expect(
      decodePinnedRipgrepArchive(archive, { ...pin, binarySize: binary.length + 1 }),
    ).rejects.toThrow("executable verification");
  });

  it("rejects archive links and duplicate executable entries", async () => {
    for (const { archive, pin } of [fixture(49), fixture(50), fixture(48, true)])
      await expect(decodePinnedRipgrepArchive(archive, pin)).rejects.toThrow("not a regular file");
  });
});
