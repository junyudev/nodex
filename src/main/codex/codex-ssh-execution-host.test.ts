import { describe, afterEach, expect, test } from "vite-plus/test";
import { chmod, mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodexSshExecutionHostConfig } from "../../shared/types";
import {
  buildCodexSshArguments,
  normalizeCodexSshExecutionHostConfig,
  quotePosixShellArgument,
  CodexSshExecutionHostTransport,
} from "./codex-ssh-execution-host";
import {
  isExecutionWorkspacePathWithinRoot,
  rewriteExecutionWorkspacePath,
  rewriteExecutionWorkspaceRoots,
} from "./codex-execution-workspace-roots";
import { resolveCodexForkWorkspaceInheritance } from "./codex-fork-workspace-inheritance";
import { CodexLocalExecutionHostFileTransfer } from "./codex-execution-host-file-transfer";

describe("codex-ssh-execution-host", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map(async (root) => {
        await rm(root, { recursive: true, force: true });
      }),
    );
  });

  const CONFIG: CodexSshExecutionHostConfig = {
    id: "ssh:build",
    displayName: "Build Mac",
    kind: "ssh",
    sshAlias: "build-mac",
    port: 2202,
    managedRoot: "/Users/build/.nodex/worktrees",
    repositoryRoots: ["/Users/build/src/project"],
    codexBinary: "/Users/build/bin/codex",
    codexHome: "/Users/build/.codex",
    enabled: true,
  };

  describe("Codex SSH execution host boundary", () => {
    test("builds an argv-only OpenSSH invocation with default trust policy", () => {
      expect(
        buildCodexSshArguments(CONFIG, ["node", "/path with spaces/worker.cjs", "ssh:build"]),
      ).toEqual([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ClearAllForwardings=yes",
        "-p",
        "2202",
        "build-mac",
        "'node' '/path with spaces/worker.cjs' 'ssh:build'",
      ]);
    });

    test("quotes apostrophes without allowing another remote shell argument", () => {
      expect(quotePosixShellArgument("a'b")).toBe("'a'\"'\"'b'");
    });

    test("rejects option injection, non-POSIX roots, duplicate repositories, and local id", () => {
      expect(() =>
        normalizeCodexSshExecutionHostConfig({ ...CONFIG, sshAlias: "-ProxyCommand=bad" }),
      ).toThrow("SSH alias is invalid");
      expect(() =>
        normalizeCodexSshExecutionHostConfig({ ...CONFIG, managedRoot: "relative" }),
      ).toThrow("absolute POSIX path");
      expect(() =>
        normalizeCodexSshExecutionHostConfig({
          ...CONFIG,
          repositoryRoots: [CONFIG.repositoryRoots[0]!, CONFIG.repositoryRoots[0]!],
        }),
      ).toThrow("must be unique");
      expect(() => normalizeCodexSshExecutionHostConfig({ ...CONFIG, id: "local" })).toThrow(
        "invalid or reserved",
      );
    });

    // The loopback host executes a POSIX remote worker; argv and quoting contracts run on every host.
    test.skipIf(process.platform === "win32")(
      "describes only authorized remote files through the fixed SSH script",
      async () => {
        const root = await mkdtemp(path.join(tmpdir(), "nodex-ssh-host-test-"));
        temporaryRoots.push(root);
        const repositoryRoot = path.join(root, "repository");
        const codexHome = path.join(root, "codex-home");
        const managedRoot = path.join(root, "worktrees");
        await Promise.all([
          mkdir(repositoryRoot, { recursive: true }),
          mkdir(codexHome, { recursive: true }),
          mkdir(managedRoot, { recursive: true }),
        ]);
        const statePath = path.join(repositoryRoot, "state.bin");
        await writeFile(statePath, Buffer.from([0, 1, 2, 255]));
        const sshShim = path.join(root, "ssh-shim");
        await writeFile(
          sshShim,
          '#!/bin/sh\nfor argument in "$@"; do command=$argument; done\nexec /bin/sh -c "$command"\n',
        );
        await chmod(sshShim, 0o700);
        const transport = new CodexSshExecutionHostTransport({
          config: {
            ...CONFIG,
            sshAlias: "loopback",
            port: null,
            managedRoot,
            repositoryRoots: [repositoryRoot],
            codexBinary: "/bin/echo",
            codexHome,
          },
          sshBinary: sshShim,
          workerBundlePath: path.join(root, "unused-worker.cjs"),
        });

        await expect(transport.describe(statePath)).resolves.toMatchObject({
          path: statePath,
          size: 4,
        });
        await expect(transport.describe(path.join(root, "outside.txt"))).rejects.toThrow(
          "unauthorized",
        );
      },
    );
  });
});

describe("codex-execution-workspace-roots", () => {
  describe("codex-execution-workspace-roots", () => {
    describe("execution workspace root rewriting", () => {
      test("replaces only the primary root and preserves additional root order", () => {
        expect(
          rewriteExecutionWorkspaceRoots({
            sourcePrimary: "/repo/primary",
            targetPrimary: "/worktrees/a1b2/primary",
            workspaceRoots: ["/repo/primary", "/repo/shared-a", "/repo/shared-b", "/repo/primary/"],
          }),
        ).toEqual(["/worktrees/a1b2/primary", "/repo/shared-a", "/repo/shared-b"]);
      });

      test("retains an external custom cwd as an explicit permission root", () => {
        expect(
          rewriteExecutionWorkspaceRoots({
            sourcePrimary: "/repo/primary",
            targetPrimary: "/worktrees/a1b2/primary",
            workspaceRoots: ["/repo/primary", "/repo/shared"],
            explicitRoots: ["/repo/primary/packages/app", "/scratch/custom-cwd"],
          }),
        ).toEqual(["/worktrees/a1b2/primary", "/repo/shared", "/scratch/custom-cwd"]);
      });

      test("compares Windows and UNC roots path-equivalently", () => {
        expect(isExecutionWorkspacePathWithinRoot("C:\\Repo\\src", "c:/repo/")).toBe(true);
        expect(
          rewriteExecutionWorkspacePath({
            path: "C:\\Repo\\src",
            sourcePrimary: "c:/repo",
            targetPrimary: "D:/worktrees/a1b2/repo",
          }),
        ).toBe("D:/worktrees/a1b2/repo/src");
        expect(
          rewriteExecutionWorkspaceRoots({
            sourcePrimary: "//HOST/Repo",
            targetPrimary: "//host/Worktrees/a1b2/Repo",
            workspaceRoots: ["//host/repo/", "//host/shared", "//HOST/SHARED/"],
          }),
        ).toEqual(["//host/Worktrees/a1b2/Repo", "//host/shared"]);
      });
    });
  });

  describe("codex-fork-workspace-inheritance", () => {
    describe("Codex fork workspace inheritance", () => {
      test("copies the projectless identity and both workspace hints as one boundary", () => {
        const inherited = resolveCodexForkWorkspaceInheritance({
          projectId: null,
          projectlessOutputDirectory: "/outputs/thread",
          projectlessWorkspaceBrowserRoot: "/workspace/browser",
        });

        expect(inherited.projectId).toBe(null);
        expect(inherited.projectlessOutputDirectory).toBe("/outputs/thread");
        expect(inherited.projectlessWorkspaceBrowserRoot).toBe("/workspace/browser");
      });

      test("normalizes absent project workspace metadata to explicit nulls", () => {
        const inherited = resolveCodexForkWorkspaceInheritance({ projectId: "project-1" });

        expect(inherited.projectId).toBe("project-1");
        expect(inherited.projectlessOutputDirectory).toBe(null);
        expect(inherited.projectlessWorkspaceBrowserRoot).toBe(null);
      });
    });
  });
});

describe("codex-execution-host-file-transfer", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(async (root) => {
        await rm(root, { recursive: true, force: true });
      }),
    );
  });

  describe("CodexLocalExecutionHostFileTransfer", () => {
    test("hashes and copies only authorized regular files through private staging", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "nodex-handoff-transfer-"));
      roots.push(root);
      const authorized = path.join(root, "authorized");
      const staging = path.join(root, "staging");
      const source = path.join(authorized, "state.bin");
      await mkdir(authorized, { recursive: true });
      await writeFile(source, Buffer.from([0, 1, 2, 3, 255]));
      const transfer = new CodexLocalExecutionHostFileTransfer({
        hostId: "local",
        stagingRoot: staging,
        allowedReadRoots: [authorized],
      });

      const descriptor = await transfer.describe(source);
      expect(descriptor).toMatchObject({ path: source, size: 5 });
      expect(descriptor.sha256).toMatch(/^[a-f0-9]{64}$/u);
      const uploaded = await transfer.upload({
        localPath: source,
        operationId: "operation-1",
        fileName: "state.bin",
        sha256: descriptor.sha256,
        size: descriptor.size,
      });
      expect(await readFile(uploaded.path)).toEqual(Buffer.from([0, 1, 2, 3, 255]));
      await transfer.cleanup("operation-1");
      await expect(readFile(uploaded.path)).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("rejects paths outside the host roots and changed source descriptors", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "nodex-handoff-transfer-"));
      roots.push(root);
      const authorized = path.join(root, "authorized");
      const source = path.join(authorized, "state.txt");
      const outside = path.join(root, "outside.txt");
      await mkdir(authorized, { recursive: true });
      await writeFile(source, "before");
      await writeFile(outside, "outside");
      const transfer = new CodexLocalExecutionHostFileTransfer({
        hostId: "local",
        stagingRoot: path.join(root, "staging"),
        allowedReadRoots: [authorized],
      });
      const descriptor = await transfer.describe(source);
      await writeFile(source, "after");

      await expect(transfer.describe(outside)).rejects.toThrow("outside the authorized host roots");
      await expect(
        transfer.download({
          source: descriptor,
          destinationPath: path.join(root, "copy.txt"),
        }),
      ).rejects.toThrow("changed before transfer");
    });
  });
});
