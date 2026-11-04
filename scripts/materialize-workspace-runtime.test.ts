import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
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

function writeFixtureFile(root: string, relativePath: string, content = "fixture\n") {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function createWorkspaceFixture(root: string, missingPythonPath?: string) {
  const source = path.join(root, "source");
  mkdirSync(path.join(source, "python/bin"), { recursive: true });
  writeFileSync(path.join(source, "python/bin/python3.13"), "python executable\n");
  chmodSync(path.join(source, "python/bin/python3.13"), 0o755);
  for (const alias of ["python", "python3"]) {
    symlinkSync("python3.13", path.join(source, "python/bin", alias));
  }
  writeFixtureFile(source, "python/bin/pydoc3.13");
  symlinkSync("pydoc3.13", path.join(source, "python/bin/pydoc3"));
  const pythonFiles = [
    "bin/idle3",
    "bin/idle3.13",
    "bin/pip",
    "bin/pip3",
    "bin/pip3.13",
    "bin/python3-config",
    "bin/python3.13-config",
    "include/python3.13/Python.h",
    "lib/itcl4.3.8/pkgIndex.tcl",
    "lib/libpython3.13.dylib",
    "lib/libtcl9.0.dylib",
    "lib/libtcl9tk9.0.dylib",
    "lib/pkgconfig/python-3.13.pc",
    "lib/tcl9/pkgIndex.tcl",
    "lib/tcl9.0/init.tcl",
    "lib/thread3.0.6/pkgIndex.tcl",
    "lib/tk9.0/tk.tcl",
    "lib/python3.13/config-3.13-darwin/Makefile",
    "lib/python3.13/ensurepip/__init__.py",
    "lib/python3.13/idlelib/__init__.py",
    "lib/python3.13/lib-dynload/_tkinter.cpython-313-darwin.so",
    "lib/python3.13/site-packages/pip/__init__.py",
    "lib/python3.13/site-packages/pip-26.2.1.dist-info/METADATA",
    "lib/python3.13/tkinter/__init__.py",
    "lib/python3.13/turtle.py",
    "lib/python3.13/turtledemo/__init__.py",
  ];
  for (const file of pythonFiles) {
    if (file !== missingPythonPath) writeFixtureFile(source, `python/${file}`);
  }
  const wheelSource = path.join(root, "wheel");
  writeFixtureFile(wheelSource, "example/__init__.py", "example = True\n");
  writeFixtureFile(wheelSource, "example/include/example.h");
  writeFixtureFile(wheelSource, "example-1.0.0.dist-info/licenses/LICENSE");
  writeFixtureFile(wheelSource, "example-1.0.0.dist-info/licenses/notice.h");
  const assets = [
    { name: "python.tar.gz", source, members: ["python"] },
    {
      name: "example.whl",
      source: wheelSource,
      members: ["example", "example-1.0.0.dist-info"],
    },
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

test.skipIf(process.platform === "win32")(
  "rejects archive members that can escape or ambiguously address the staging root",
  () => {
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
  },
);

test.skipIf(process.platform === "win32")(
  "reuses verified extraction without archives and keeps worktree outputs independent",
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "nodex-workspace-cache-"));
    try {
      const fixture = createWorkspaceFixture(root);
      const options = {
        projectRoot: root,
        lockPath: fixture.lockPath,
        targetArch: "arm64" as const,
      };
      const first = path.join(root, "first");
      const second = path.join(root, "second");
      await materializeWorkspaceRuntime({ ...options, outputPath: first });
      for (const { cache } of fixture.assets) rmSync(cache);
      await materializeWorkspaceRuntime({ ...options, outputPath: second });
      const executable = "python/bin/python3.13";
      expect(readFileSync(path.join(second, executable), "utf8")).toBe("python executable\n");
      expect(lstatSync(path.join(second, "python/bin/pydoc3")).isFile()).toBe(true);
      const sitePackages = path.join(second, "python/lib/python3.13/site-packages");
      for (const removed of [
        "python/bin/python",
        "python/bin/python3",
        "python/lib/libpython3.13.dylib",
        "python/lib/tk9.0",
        "python/include",
      ]) {
        expect(existsSync(path.join(second, removed)), removed).toBe(false);
      }
      expect(existsSync(path.join(sitePackages, "pip"))).toBe(false);
      expect(existsSync(path.join(sitePackages, "example/include/example.h"))).toBe(false);
      expect(readFileSync(path.join(sitePackages, "example/__init__.py"), "utf8")).toBe(
        "example = True\n",
      );
      expect(
        readFileSync(path.join(sitePackages, "example-1.0.0.dist-info/licenses/notice.h"), "utf8"),
      ).toBe("fixture\n");
      expect(lstatSync(path.join(first, executable), { bigint: true }).ino).not.toBe(
        lstatSync(path.join(second, executable), { bigint: true }).ino,
      );
      writeFileSync(path.join(first, executable), "changed by signing\n");
      expect(readFileSync(path.join(second, executable), "utf8")).toBe("python executable\n");
      await materializeWorkspaceRuntime({ ...options, outputPath: first });
      expect(readFileSync(path.join(first, executable), "utf8")).toBe("python executable\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "includes committed Python notices in extraction identity and local reuse validation",
  async () => {
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
  },
);

test.skipIf(process.platform === "win32")(
  "refuses to publish a runtime when the pinned Python layout changes",
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "nodex-workspace-prune-"));
    try {
      const { lockPath } = createWorkspaceFixture(root, "bin/pip3");
      const outputPath = path.join(root, "output");
      await expect(
        materializeWorkspaceRuntime({
          projectRoot: root,
          lockPath,
          targetArch: "arm64",
          outputPath,
        }),
      ).rejects.toThrow("Workspace Python prune path is missing: python/bin/pip3");
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
