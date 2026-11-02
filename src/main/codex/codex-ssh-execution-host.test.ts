import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { CodexSshExecutionHostConfig } from "../../shared/types";
import {
  buildCodexSshArguments,
  normalizeCodexSshExecutionHostConfig,
  quotePosixShellArgument,
  CodexSshExecutionHostTransport,
} from "./codex-ssh-execution-host";

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
