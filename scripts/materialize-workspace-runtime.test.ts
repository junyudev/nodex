import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { resolveImmutableArtifactPath } from "./immutable-artifact-cache";
import {
  materializeWorkspaceRuntime,
  validateWorkspaceArchiveEntries,
} from "./materialize-workspace-runtime";

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Fixture downloads are forbidden")));
});
afterEach(() => vi.unstubAllGlobals());

function createWorkspaceFixture(root: string) {
  const source = path.join(root, "source");
  mkdirSync(path.join(source, "python/bin"), { recursive: true });
  writeFileSync(path.join(source, "python/bin/python3.13"), "python executable\n");
  chmodSync(path.join(source, "python/bin/python3.13"), 0o755);
  symlinkSync("python3.13", path.join(source, "python/bin/python3"));
  const wheelSource = path.join(root, "wheel");
  mkdirSync(wheelSource);
  writeFileSync(path.join(wheelSource, "example.py"), "example = True\n");
  const assets = [
    { name: "python.tar.gz", source, members: ["python"] },
    { name: "example.whl", source: wheelSource, members: ["example.py"] },
  ].map((input) => {
    const archive = path.join(root, input.name);
    execFileSync("tar", ["-czf", archive, "-C", input.source, ...input.members]);
    const asset = {
      name: input.name,
      sha256: sha256(archive),
      size: lstatSync(archive).size,
      url: `https://example.invalid/${input.name}`,
    };
    const cache = resolveImmutableArtifactPath({
      family: "workspace-runtime",
      projectRoot: root,
      archiveSha256: asset.sha256,
      assetName: asset.name,
    });
    mkdirSync(path.dirname(cache), { recursive: true });
    copyFileSync(archive, cache);
    return { asset, cache };
  });
  const python = assets[0]!;
  const wheel = assets[1]!;
  const license = path.join(root, "resources/workspace-runtime/python-licenses/LICENSE");
  mkdirSync(path.dirname(license), { recursive: true });
  writeFileSync(license, "Python license\n");
  const lockPath = path.join(root, "workspace.lock.json");
  writeFileSync(
    lockPath,
    JSON.stringify({
      schemaVersion: 1,
      distributionId: "fixture-python",
      pythonVersion: "3.13.15",
      pythonRelease: "fixture",
      targets: {
        arm64: {
          python: python.asset,
          wheels: [{ ...wheel.asset, package: "example", version: "1.0.0" }],
        },
      },
    }),
  );
  return { assets, license, lockPath };
}

test("rejects archive members that can escape or ambiguously address the staging root", () => {
  expect(() =>
    validateWorkspaceArchiveEntries(["python/bin/python3.13", "python/lib/"]),
  ).not.toThrow();
  for (const member of [
    "/etc/file",
    "../file",
    "python/../../file",
    "python\\file",
    "python//file",
    "python/./file",
  ]) {
    expect(() => validateWorkspaceArchiveEntries([member])).toThrow(
      "Invalid workspace archive path",
    );
  }
});

test("reuses verified extraction without archives and keeps worktree outputs independent", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nodex-workspace-cache-"));
  try {
    const fixture = createWorkspaceFixture(root);
    const options = { projectRoot: root, lockPath: fixture.lockPath, targetArch: "arm64" as const };
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await materializeWorkspaceRuntime({ ...options, outputPath: first });
    for (const { cache } of fixture.assets) rmSync(cache);
    await materializeWorkspaceRuntime({ ...options, outputPath: second });
    const executable = "python/bin/python3.13";
    expect(readFileSync(path.join(second, executable), "utf8")).toBe("python executable\n");
    expect(lstatSync(path.join(second, "python/bin/python3")).isSymbolicLink()).toBe(false);
    expect(lstatSync(path.join(first, executable)).ino).not.toBe(
      lstatSync(path.join(second, executable)).ino,
    );
    writeFileSync(path.join(first, executable), "changed by signing\n");
    expect(readFileSync(path.join(second, executable), "utf8")).toBe("python executable\n");
    await materializeWorkspaceRuntime({ ...options, outputPath: first });
    expect(readFileSync(path.join(first, executable), "utf8")).toBe("python executable\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("includes committed Python notices in extraction identity and local reuse validation", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nodex-workspace-licenses-"));
  try {
    const fixture = createWorkspaceFixture(root);
    const options = {
      projectRoot: root,
      lockPath: fixture.lockPath,
      targetArch: "arm64" as const,
      outputPath: path.join(root, "output"),
    };
    await materializeWorkspaceRuntime(options);
    writeFileSync(fixture.license, "Updated Python license\n");
    await materializeWorkspaceRuntime(options);
    expect(readFileSync(path.join(options.outputPath, "licenses/python/LICENSE"), "utf8")).toBe(
      "Updated Python license\n",
    );
    for (const { cache } of fixture.assets) rmSync(cache);
    writeFileSync(fixture.license, "Python license\n");
    const previousNoticeOutput = path.join(root, "previous-notice");
    await materializeWorkspaceRuntime({ ...options, outputPath: previousNoticeOutput });
    expect(readFileSync(path.join(previousNoticeOutput, "licenses/python/LICENSE"), "utf8")).toBe(
      "Python license\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
