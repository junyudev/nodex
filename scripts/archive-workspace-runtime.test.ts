import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import runtimeLock from "../resources/workspace-runtime/workspace-runtime.lock.json";
import { writeDocumentToolsFixture } from "../src/main/platform/node/document-tools-test-fixture";
import { archiveWorkspaceRuntime } from "./archive-workspace-runtime";
import { verifyWorkspaceRuntimePublishInput } from "./release/workspace-runtime";
import {
  workspaceRuntimeLockSchema,
  workspaceRuntimeSourceDigest,
} from "./workspace-runtime-release-lock";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixtureLock = () => ({
  ...runtimeLock,
  distributionId: "fixture-python",
  release: {
    repository: "example/nodex",
    tag: "workspace-runtime-vfixture-python",
    assets: { "darwin-arm64": null },
  },
});

test("workspace lock binds a published asset to its distribution and release", () => {
  const lock = fixtureLock();
  const parsed = workspaceRuntimeLockSchema.parse(lock);
  const assetName = "nodex-workspace-runtime-fixture-python-darwin-arm64.tar.gz";
  const asset = {
    assetName,
    url: null,
    archiveSize: 123,
    archiveSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    unpackedBytes: 456,
  };
  const withAsset = (candidate: unknown) => ({
    ...lock,
    release: { ...lock.release, assets: { "darwin-arm64": candidate } },
  });
  expect(workspaceRuntimeSourceDigest(workspaceRuntimeLockSchema.parse(withAsset(asset)))).toBe(
    workspaceRuntimeSourceDigest(parsed),
  );
  expect(workspaceRuntimeLockSchema.safeParse({ ...lock, schemaVersion: 1 }).success).toBe(false);
  for (const invalid of [
    { ...asset, assetName: "different.tar.gz" },
    { ...asset, url: "https://example.com/elsewhere.tar.gz" },
    { ...asset, archiveSize: 0 },
    { ...asset, manifestSha256: "not a digest" },
    { ...asset, unpackedBytes: -1 },
  ])
    expect(workspaceRuntimeLockSchema.safeParse(withAsset(invalid)).success).toBe(false);
});

test.skipIf(process.platform !== "darwin")(
  "seals a deterministic archive and proves the exact signed payload before publishing",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "nodex-workspace-archive-"));
    roots.push(root);
    const lock = fixtureLock();
    const sourceLockSha256 = workspaceRuntimeSourceDigest(workspaceRuntimeLockSchema.parse(lock));
    const sourceRoot = join(root, "source");
    const { manifest } = writeDocumentToolsFixture(sourceRoot, sourceLockSha256);
    const python = join(sourceRoot, manifest.pythonExecutable);
    const sign = vi.fn((file: string) => appendFileSync(file, "signed fixture"));
    const first = await archiveWorkspaceRuntime({
      sourceRoot,
      sourceLockSha256,
      outputDirectory: join(root, "first"),
      sign,
    });
    utimesSync(python, 100, 100);
    const second = await archiveWorkspaceRuntime({
      sourceRoot,
      sourceLockSha256,
      outputDirectory: join(root, "second"),
      sign,
    });
    expect(first).toEqual(second);
    expect(sign).toHaveBeenCalledTimes(2);
    const opts = {
      lockPath: join(root, "candidate.json"),
      archivePath: join(root, "first", first.assetName),
    };
    expect(readFileSync(opts.archivePath)).toEqual(
      readFileSync(join(root, "second", first.assetName)),
    );
    const { submissionId: _, ...candidate } = first;
    const withAsset = (url: string | null) => ({
      ...lock,
      release: { ...lock.release, assets: { "darwin-arm64": { ...candidate, url } } },
    });
    writeFileSync(opts.lockPath, JSON.stringify(withAsset(null)));
    await expect(verifyWorkspaceRuntimePublishInput(opts)).rejects.toThrow("final asset URL");
    writeFileSync(
      opts.lockPath,
      JSON.stringify(
        withAsset(
          `https://github.com/${lock.release.repository}/releases/download/${lock.release.tag}/${candidate.assetName}`,
        ),
      ),
    );
    await expect(verifyWorkspaceRuntimePublishInput(opts)).resolves.toMatchObject({
      tag: lock.release.tag,
    });
    const tampered = readFileSync(opts.archivePath);
    tampered[0] = tampered[0]! ^ 0xff;
    writeFileSync(opts.archivePath, tampered);
    await expect(verifyWorkspaceRuntimePublishInput(opts)).rejects.toThrow(
      "archive checksum mismatch",
    );
  },
);
