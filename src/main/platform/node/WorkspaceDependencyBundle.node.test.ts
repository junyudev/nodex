/* oxlint-disable effecttsgo/async-function -- These Node boundary tests exercise real filesystem integrity and symlink behavior. */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import {
  WORKSPACE_RUNTIME_MANIFEST,
  type WorkspaceRuntimeManifest,
} from "../../../shared/workspace-dependency-runtime";
import { readWorkspaceDependencyBundle } from "./WorkspaceDependencyBundle";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "nodex-workspace-bundle-"));
  roots.push(root);
  const artifacts = [
    { path: "python/bin/python3.13", content: "python", executable: true },
    { path: "python/lib/site-packages/docx/__init__.py", content: "document", executable: false },
  ];
  for (const artifact of artifacts) {
    const file = path.join(root, artifact.path);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, artifact.content);
    chmodSync(file, artifact.executable ? 0o755 : 0o644);
  }
  const manifest: WorkspaceRuntimeManifest = {
    schemaVersion: 1,
    targetPlatform: "darwin",
    targetArch: "arm64",
    distributionId: "test",
    sourceLockSha256: "a".repeat(64),
    pythonVersion: "3.13.15",
    pythonExecutable: artifacts[0]!.path,
    pythonSitePackages: "python/lib/site-packages",
    libraries: [{ name: "python-docx", version: "1.2.0" }],
    artifacts: artifacts.map(({ path, content, executable }) => ({
      path,
      executable,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
  };
  const write = () =>
    writeFileSync(path.join(root, WORKSPACE_RUNTIME_MANIFEST), JSON.stringify(manifest));
  write();
  const input = {
    root,
    platform: "darwin",
    arch: "arm64",
    node: { executable: "/verified/node", version: "24.19.0" },
  };
  return { root, manifest, input, write };
};

test("returns executable and import paths only after checking the selected architecture and complete manifest", async () => {
  const subject = fixture();
  expect(await readWorkspaceDependencyBundle(subject.input)).toMatchObject({
    status: "available",
    node: subject.input.node,
    python: {
      executable: path.join(subject.root, "python/bin/python3.13"),
      recommendedArgs: ["-I", "-B"],
    },
    libraries: subject.manifest.libraries,
  });
  expect(await readWorkspaceDependencyBundle({ ...subject.input, arch: "x64" })).toEqual({
    status: "unavailable",
    reason: "invalid_bundle",
  });
  expect(await readWorkspaceDependencyBundle({ ...subject.input, node: null })).toEqual({
    status: "unavailable",
    reason: "node_unavailable",
  });
});

test("rejects changed library bytes, missing executables and paths outside the bundle", async () => {
  const subject = fixture();
  writeFileSync(path.join(subject.root, subject.manifest.artifacts[1]!.path), "tampered");
  expect(await readWorkspaceDependencyBundle(subject.input)).toEqual({
    status: "unavailable",
    reason: "invalid_bundle",
  });
  subject.manifest.artifacts = [subject.manifest.artifacts[0]!];
  subject.manifest.pythonExecutable = "missing";
  subject.write();
  expect(await readWorkspaceDependencyBundle(subject.input)).toEqual({
    status: "unavailable",
    reason: "invalid_bundle",
  });
  subject.manifest.artifacts[0]!.path = "../external";
  subject.write();
  expect(await readWorkspaceDependencyBundle(subject.input)).toEqual({
    status: "unavailable",
    reason: "invalid_bundle",
  });
});

test("never follows a runtime symlink or substitutes an uninstalled system Python", async () => {
  const subject = fixture();
  const executable = path.join(subject.root, subject.manifest.pythonExecutable);
  rmSync(executable);
  symlinkSync(process.execPath, executable);
  expect(await readWorkspaceDependencyBundle(subject.input)).toEqual({
    status: "unavailable",
    reason: "invalid_bundle",
  });
  rmSync(path.join(subject.root, WORKSPACE_RUNTIME_MANIFEST));
  expect(await readWorkspaceDependencyBundle(subject.input)).toEqual({
    status: "unavailable",
    reason: "not_installed",
  });
});
