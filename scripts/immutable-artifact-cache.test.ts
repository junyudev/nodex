import childProcess, { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  cloneImmutableDirectory,
  cloneImmutableFile,
  ensureGeneratedImmutableArtifact,
  ensureImmutableArtifact,
  ensureImmutableDirectory,
  immutableDirectoryDigest,
  resolveImmutableArtifactPath,
  resolveImmutableDirectoryPath,
} from "./immutable-artifact-cache";

const temporaryRoots: string[] = [];
const HASH = "a".repeat(64);

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-immutable-cache-"));
  temporaryRoots.push(root);
  return root;
}

function contentValidator(expected: Buffer): (archivePath: string) => void {
  return (archivePath) => {
    if (!fs.readFileSync(archivePath).equals(expected)) {
      throw new Error("artifact content mismatch");
    }
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("immutable artifact cache", () => {
  test("isolates all runtime families under an explicit build cache root", () => {
    const root = makeRoot();
    vi.stubEnv("NODEX_BUILD_CACHE_DIR", root);
    try {
      const input = { archiveSha256: HASH, assetName: "runtime.zip", projectRoot: "/repo/nodex" };
      expect(resolveImmutableArtifactPath({ ...input, family: "electron" })).toBe(
        path.join(root, "electron", HASH, "runtime.zip"),
      );
      expect(resolveImmutableArtifactPath({ ...input, family: "rust-dev-runtime" })).toBe(
        path.join(root, "rust-dev-runtime", HASH, "runtime.zip"),
      );
      expect(
        resolveImmutableArtifactPath({
          ...input,
          family: "electron",
          cachePath: path.join(root, "explicit"),
        }),
      ).toBe(path.join(root, "explicit", HASH, "runtime.zip"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("output identities follow content, mode and link changes while allowing independent clones", () => {
    const root = makeRoot();
    const source = path.join(root, "source");
    const clone = path.join(root, "clone");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "binary"), "runtime", { mode: 0o755 });
    const identity = immutableDirectoryDigest(source);
    cloneImmutableDirectory(source, clone);
    expect(immutableDirectoryDigest(clone)).toBe(identity);
    fs.chmodSync(path.join(clone, "binary"), 0o644);
    expect(immutableDirectoryDigest(clone)).not.toBe(identity);
    fs.chmodSync(path.join(clone, "binary"), 0o755);
    fs.writeFileSync(path.join(clone, "binary"), "changed");
    expect(immutableDirectoryDigest(clone)).not.toBe(identity);
    expect(immutableDirectoryDigest(source)).toBe(identity);
    fs.symlinkSync("binary", path.join(source, "alias"));
    expect(immutableDirectoryDigest(source)).not.toBe(identity);
  });

  test("resolves SHA-addressed archives under cache.local by default", () => {
    expect(
      resolveImmutableArtifactPath({
        archiveSha256: HASH,
        assetName: "runtime.tar.gz",
        family: "browser-runtime",
        projectRoot: "/repo/nodex",
      }),
    ).toBe(`/repo/nodex/cache.local/browser-runtime/${HASH}/runtime.tar.gz`);

    expect(
      resolveImmutableArtifactPath({
        archiveSha256: HASH,
        assetName: "runtime.tar.gz",
        cachePath: "/shared/browser",
        family: "browser-runtime",
        projectRoot: "/repo/nodex",
      }),
    ).toBe(`/shared/browser/${HASH}/runtime.tar.gz`);
  });

  test("shares the primary checkout cache from linked Git worktrees while honoring overrides", () => {
    const root = makeRoot();
    const primaryRoot = path.join(root, "primary checkout");
    const linkedRoot = path.join(root, "linked checkout");
    fs.mkdirSync(primaryRoot);
    execFileSync("git", ["init", "--quiet", primaryRoot]);
    execFileSync(
      "git",
      [
        "-C",
        primaryRoot,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        "Initial",
      ],
      { stdio: "pipe" },
    );
    execFileSync("git", ["-C", primaryRoot, "worktree", "add", "--quiet", "--detach", linkedRoot]);
    const identity = {
      archiveSha256: HASH,
      assetName: "runtime.tar.gz",
      family: "browser-runtime" as const,
    };

    expect(resolveImmutableArtifactPath({ ...identity, projectRoot: linkedRoot })).toBe(
      resolveImmutableArtifactPath({ ...identity, projectRoot: primaryRoot }),
    );
    expect(
      resolveImmutableDirectoryPath({
        ...identity,
        directoryName: "source-v1",
        projectRoot: linkedRoot,
      }),
    ).toBe(
      path.join(fs.realpathSync(primaryRoot), "cache.local", "browser-runtime", HASH, "source-v1"),
    );
    expect(
      resolveImmutableArtifactPath({
        ...identity,
        projectRoot: linkedRoot,
        cachePath: path.join(root, "override"),
      }),
    ).toBe(path.join(root, "override", HASH, "runtime.tar.gz"));
    expect(resolveImmutableArtifactPath({ ...identity, projectRoot: root })).toBe(
      path.join(root, "cache.local", "browser-runtime", HASH, "runtime.tar.gz"),
    );
  });

  test("publishes one verified download across concurrent callers", async () => {
    const root = makeRoot();
    const destinationPath = path.join(root, "cache", HASH, "runtime.tar.gz");
    const contents = Buffer.from("verified runtime");
    const fetchArchive = vi.fn(
      async () =>
        new Response(contents, {
          headers: { "content-length": String(contents.length) },
          status: 200,
        }),
    );
    const input = {
      destinationPath,
      expectedSize: contents.length,
      fetch: fetchArchive,
      label: "Test runtime",
      url: "https://example.test/runtime.tar.gz",
      validate: contentValidator(contents),
    };

    await Promise.all([ensureImmutableArtifact(input), ensureImmutableArtifact(input)]);

    expect(fetchArchive).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(destinationPath)).toEqual(contents);
    expect(fs.existsSync(`${destinationPath}.lock`)).toBe(false);
  });

  test("publishes one verified build across concurrent callers", async () => {
    const root = makeRoot();
    const destinationPath = path.join(root, "cache", HASH, "runtime.tar.gz");
    const contents = Buffer.from("reproducible runtime");
    const generate = vi.fn(async (temporaryPath: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(temporaryPath, contents);
    });
    const input = {
      destinationPath,
      generate,
      label: "Test source build",
      validate: contentValidator(contents),
    };

    await Promise.all([
      ensureGeneratedImmutableArtifact(input),
      ensureGeneratedImmutableArtifact(input),
    ]);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(destinationPath)).toEqual(contents);
    expect(fs.existsSync(`${destinationPath}.lock`)).toBe(false);
  });

  test("repairs invalid cache entries and removes abandoned partial downloads", async () => {
    const root = makeRoot();
    const destinationPath = path.join(root, "cache", HASH, "runtime.tar.gz");
    const contents = Buffer.from("repaired runtime");
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, "corrupt");
    fs.writeFileSync(`${destinationPath}.part-123`, "partial");
    fs.mkdirSync(`${destinationPath}.lock`);
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(`${destinationPath}.lock`, staleTime, staleTime);

    await ensureImmutableArtifact({
      destinationPath,
      expectedSize: contents.length,
      fetch: async () =>
        new Response(contents, {
          headers: { "content-length": String(contents.length) },
          status: 200,
        }),
      label: "Test runtime",
      url: "https://example.test/runtime.tar.gz",
      validate: contentValidator(contents),
    });

    expect(fs.readFileSync(destinationPath)).toEqual(contents);
    expect(fs.existsSync(`${destinationPath}.part-123`)).toBe(false);
    expect(fs.existsSync(`${destinationPath}.lock`)).toBe(false);
  });

  test("does not replace an explicitly supplied invalid archive", async () => {
    const root = makeRoot();
    const destinationPath = path.join(root, "runtime.tar.gz");
    fs.writeFileSync(destinationPath, "corrupt");
    const fetchArchive = vi.fn();

    await expect(
      ensureImmutableArtifact({
        destinationPath,
        expectedSize: 8,
        fetch: fetchArchive,
        label: "Test runtime",
        replaceInvalid: false,
        url: "https://example.test/runtime.tar.gz",
        validate: contentValidator(Buffer.from("expected")),
      }),
    ).rejects.toThrow("artifact content mismatch");
    expect(fetchArchive).not.toHaveBeenCalled();
    expect(fs.readFileSync(destinationPath, "utf8")).toBe("corrupt");
  });

  test("publishes one verified directory across independent processes", async () => {
    const root = makeRoot();
    const destinationPath = path.join(root, "source-v1");
    const counterPath = path.join(root, "generations");
    const moduleUrl = new URL("./immutable-artifact-cache.ts", import.meta.url).href;
    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { ensureImmutableDirectory } from ${JSON.stringify(moduleUrl)};
      await ensureImmutableDirectory({
        destinationPath: ${JSON.stringify(destinationPath)},
        label: "Test extraction",
        generate: async (directoryPath) => {
          fs.appendFileSync(${JSON.stringify(counterPath)}, "generation\\n");
          await new Promise(resolve => setTimeout(resolve, 50));
          fs.mkdirSync(directoryPath);
          fs.writeFileSync(path.join(directoryPath, "binary"), "runtime", { mode: 0o755 });
        },
        validate: directoryPath => {
          if (fs.readFileSync(path.join(directoryPath, "binary"), "utf8") !== "runtime") throw new Error("invalid runtime");
        }
      });
    `;
    const execute = (): Promise<unknown> =>
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", script],
        { timeout: 10_000 },
      );

    await Promise.all([execute(), execute()]);

    expect(fs.readFileSync(counterPath, "utf8")).toBe("generation\n");
    expect(fs.existsSync(`${destinationPath}.lock`)).toBe(false);
  });

  test("seals exact contents and executable modes, repairs damage, and cleans partial directories", async () => {
    const root = makeRoot();
    const destinationPath = path.join(root, "source-v1");
    const generate = vi.fn((directoryPath: string) => {
      fs.mkdirSync(directoryPath);
      fs.writeFileSync(path.join(directoryPath, "binary"), "runtime", { mode: 0o755 });
    });
    const input = { destinationPath, generate, label: "Test extraction", validate: async () => {} };
    await ensureImmutableDirectory(input);

    const contentPath = path.join(destinationPath, "content");
    fs.writeFileSync(path.join(contentPath, "binary"), "damaged");
    fs.mkdirSync(`${destinationPath}.part-abandoned`);
    fs.writeFileSync(path.join(`${destinationPath}.part-abandoned`, "partial"), "partial");
    await ensureImmutableDirectory(input);
    expect(fs.readFileSync(path.join(contentPath, "binary"), "utf8")).toBe("runtime");
    expect(fs.existsSync(`${destinationPath}.part-abandoned`)).toBe(false);

    fs.chmodSync(path.join(contentPath, "binary"), 0o644);
    await ensureImmutableDirectory(input);
    expect(fs.statSync(path.join(contentPath, "binary")).mode & 0o777).toBe(0o755);

    fs.writeFileSync(path.join(contentPath, "unexpected"), "unsealed");
    await ensureImmutableDirectory(input);
    expect(fs.existsSync(path.join(contentPath, "unexpected"))).toBe(false);
    expect(generate).toHaveBeenCalledTimes(4);
  });

  test("failed extraction or validation never publishes a partial directory", async () => {
    const root = makeRoot();
    const destinationPath = path.join(root, "source-v1");
    await expect(
      ensureImmutableDirectory({
        destinationPath,
        generate: (directoryPath) => {
          fs.mkdirSync(directoryPath);
          fs.writeFileSync(path.join(directoryPath, "partial"), "partial");
        },
        label: "Test extraction",
        validate: () => {
          throw new Error("missing executable");
        },
      }),
    ).rejects.toThrow("missing executable");
    expect(fs.readdirSync(root)).toEqual([]);
  });

  test("holds the cache lock through asynchronous consumption", async () => {
    const root = makeRoot();
    const destinationPath = path.join(root, "source-v1");
    const generate = vi.fn((directoryPath: string) => {
      fs.mkdirSync(directoryPath);
    });
    const input = { destinationPath, generate, label: "Test extraction", validate: () => {} };
    let releaseConsumer: () => void = () => {};
    let enterConsumer: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enterConsumer = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseConsumer = resolve;
    });
    const first = ensureImmutableDirectory(input, async () => {
      enterConsumer();
      await released;
    });
    await entered;
    const secondConsumer = vi.fn();
    const second = ensureImmutableDirectory(input, secondConsumer);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondConsumer).not.toHaveBeenCalled();
    releaseConsumer();
    await Promise.all([first, second]);
    expect(secondConsumer).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test("clones independent executable files and preserves internal relative symlinks", () => {
    const root = makeRoot();
    const sourcePath = path.join(root, "source");
    const outputPath = path.join(root, "output");
    fs.mkdirSync(path.join(sourcePath, "versions"), { recursive: true });
    const sourceBinary = path.join(sourcePath, "versions", "binary");
    fs.writeFileSync(sourceBinary, "runtime", { mode: 0o755 });
    fs.symlinkSync("versions/binary", path.join(sourcePath, "binary"));

    cloneImmutableDirectory(sourcePath, outputPath);
    const outputBinary = path.join(outputPath, "versions", "binary");
    expect(fs.readlinkSync(path.join(outputPath, "binary"))).toBe("versions/binary");
    expect(fs.statSync(outputBinary).mode & 0o777).toBe(0o755);
    expect(fs.statSync(outputBinary).ino).not.toBe(fs.statSync(sourceBinary).ino);
    fs.writeFileSync(outputBinary, "changed");
    expect(fs.readFileSync(sourceBinary, "utf8")).toBe("runtime");

    const dereferencedOutput = path.join(root, "file-clone");
    cloneImmutableFile(path.join(sourcePath, "binary"), dereferencedOutput);
    expect(fs.lstatSync(dereferencedOutput).isFile()).toBe(true);
    expect(fs.statSync(dereferencedOutput).mode & 0o777).toBe(0o755);
    fs.chmodSync(dereferencedOutput, 0o644);
    expect(fs.statSync(sourceBinary).mode & 0o777).toBe(0o755);
  });

  test("clones contents into an existing empty root and preserves its source permissions", () => {
    const root = makeRoot();
    const sourcePath = path.join(root, "source");
    const outputPath = path.join(root, "output");
    fs.mkdirSync(sourcePath, { mode: 0o751 });
    fs.writeFileSync(path.join(sourcePath, "binary"), "runtime", { mode: 0o751 });
    fs.mkdirSync(outputPath, { mode: 0o700 });

    cloneImmutableDirectory(sourcePath, outputPath);

    expect(fs.readdirSync(outputPath)).toEqual(["binary"]);
    expect(fs.statSync(outputPath).mode & 0o777).toBe(0o751);
    expect(fs.statSync(path.join(outputPath, "binary")).mode & 0o777).toBe(0o751);
  });

  test.skipIf(process.platform !== "darwin")(
    "uses one native macOS clone process for a whole tree",
    () => {
      const root = makeRoot();
      const sourcePath = path.join(root, "source");
      const outputPath = path.join(root, "output");
      fs.mkdirSync(sourcePath);
      for (let index = 0; index < 10; index += 1) {
        fs.writeFileSync(path.join(sourcePath, `file-${index}`), `runtime-${index}`);
      }
      const execute = vi.spyOn(childProcess, "execFileSync");
      syncBuiltinESMExports();
      try {
        cloneImmutableDirectory(sourcePath, outputPath);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute.mock.calls[0]?.[0]).toBe("/bin/cp");
        expect(fs.readdirSync(outputPath)).toHaveLength(10);
        for (const name of fs.readdirSync(sourcePath)) {
          expect(fs.readFileSync(path.join(outputPath, name))).toEqual(
            fs.readFileSync(path.join(sourcePath, name)),
          );
        }
      } finally {
        execute.mockRestore();
        syncBuiltinESMExports();
      }
    },
  );

  test("file cloning replaces destination aliases without changing their other owners", () => {
    const root = makeRoot();
    const sourcePath = path.join(root, "source");
    const otherPath = path.join(root, "other");
    const outputPath = path.join(root, "output");
    fs.writeFileSync(sourcePath, "runtime");
    fs.writeFileSync(otherPath, "other data");
    fs.linkSync(otherPath, outputPath);

    cloneImmutableFile(sourcePath, outputPath);

    expect(fs.readFileSync(otherPath, "utf8")).toBe("other data");
    expect(fs.readFileSync(outputPath, "utf8")).toBe("runtime");
    expect(fs.statSync(outputPath).ino).not.toBe(fs.statSync(otherPath).ino);
    expect(() => cloneImmutableFile(sourcePath, sourcePath)).toThrow("different files");
    expect(fs.readFileSync(sourcePath, "utf8")).toBe("runtime");
  });

  test("rejects nonempty, symlink, or nested directory destinations", () => {
    const root = makeRoot();
    const sourcePath = path.join(root, "source");
    const outputPath = path.join(root, "output");
    fs.mkdirSync(sourcePath);
    fs.writeFileSync(path.join(sourcePath, "binary"), "runtime");
    fs.mkdirSync(outputPath);
    fs.writeFileSync(path.join(outputPath, "existing"), "keep");
    expect(() => cloneImmutableDirectory(sourcePath, outputPath)).toThrow("absent or empty");
    fs.symlinkSync(outputPath, path.join(root, "output-alias"));
    expect(() => cloneImmutableDirectory(sourcePath, path.join(root, "output-alias"))).toThrow(
      "absent or empty",
    );
    expect(() => cloneImmutableDirectory(sourcePath, path.join(sourcePath, "nested"))).toThrow(
      "outside its source tree",
    );
    expect(fs.readFileSync(path.join(outputPath, "existing"), "utf8")).toBe("keep");
  });

  test("rejects symlink roots and symlinks escaping a sealed directory", async () => {
    const root = makeRoot();
    const sourcePath = path.join(root, "source");
    fs.mkdirSync(sourcePath);
    fs.symlinkSync(sourcePath, path.join(root, "root-alias"));
    expect(() =>
      cloneImmutableDirectory(path.join(root, "root-alias"), path.join(root, "output")),
    ).toThrow("real directory");

    await expect(
      ensureImmutableDirectory({
        destinationPath: path.join(root, "cache-entry"),
        generate: (directoryPath) => {
          fs.mkdirSync(directoryPath);
          fs.symlinkSync("../outside", path.join(directoryPath, "escape"));
        },
        label: "Test extraction",
        validate: () => {},
      }),
    ).rejects.toThrow("symlink escapes");
    expect(fs.existsSync(path.join(root, "cache-entry"))).toBe(false);
  });
});
