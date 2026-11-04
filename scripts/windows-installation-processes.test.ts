import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import { installationListenerAddresses } from "./ci/probe-windows-installer";

const execute = promisify(execFile);

test.skipIf(process.platform !== "win32")(
  "maintenance records why an unsafe installation root was refused",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nodex-maintenance-refusal-"));
    const log = join(root, "maintenance.log");
    try {
      await expect(
        execute("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve("resources/windows/stop-installation.ps1"),
          "-InstallationDirectory",
          parse(root).root,
          "-HelperDirectory",
          root,
          "-InstallerPid",
          String(process.pid),
          "-LogPath",
          log,
        ]),
      ).rejects.toMatchObject({ code: 1 });
      expect(await readFile(log, "utf8")).toMatch(
        /step=native-boundary failed: Refusing a drive root as an installation/,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
  30_000,
);

test.skipIf(process.platform !== "win32")(
  "maintenance stops only images within its installation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nodex-maintenance-"));
    const installation = join(root, "Nodex 用户's app");
    const sibling = `${installation}-other`;
    const installationAlias = join(root, "installation-junction");
    const profileMarker = join(root, "profile.txt");
    const children: ChildProcess[] = [];
    let phase = "fixture startup";
    try {
      await writeFile(profileMarker, "preserved");
      for (const directory of [installation, sibling]) {
        await mkdir(directory);
        const executable = join(directory, "node.exe");
        await copyFile(process.execPath, executable);
        const child = spawn(
          executable,
          [
            "-e",
            directory === installation
              ? "require('node:net').createServer().listen(0, '127.0.0.1', () => console.log('ready'))"
              : "console.log('ready'); setInterval(() => {}, 1000)",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        children.push(child);
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", (error) => {
          stderr += error.message;
        });
        try {
          await once(child.stdout!, "data", { signal: AbortSignal.timeout(5_000) });
        } catch (cause) {
          throw new Error(
            `Fixture did not start: ${executable} (exit ${child.exitCode}, ${stderr})`,
            { cause },
          );
        }
      }
      phase = "listener audit";
      expect(installationListenerAddresses(installation)).toEqual(["127.0.0.1"]);
      await symlink(installation, installationAlias, "junction");
      phase = "maintenance";
      await execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve("resources/windows/stop-installation.ps1"),
          "-InstallationDirectory",
          installationAlias,
          "-HelperDirectory",
          root,
          "-InstallerPid",
          String(process.pid),
        ],
        { timeout: 25_000 },
      );
      phase = "installed process exit";
      if (children[0]!.exitCode === null)
        await once(children[0]!, "exit", { signal: AbortSignal.timeout(5_000) });
      expect(children[0]!.exitCode).toBe(0);
      expect(children[1]!.exitCode).toBeNull();
      process.kill(children[1]!.pid!, 0);
      expect(await readFile(profileMarker, "utf8")).toBe("preserved");
    } catch (cause) {
      throw new Error(`Installation isolation failed during ${phase}`, { cause });
    } finally {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
        child.kill();
        await exited;
      }
      await rm(root, { force: true, recursive: true });
    }
  },
  45_000,
);
