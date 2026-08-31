import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  ensureGeneratedImmutableArtifact,
  ensureImmutableArtifact,
  resolveImmutableArtifactPath,
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
});
