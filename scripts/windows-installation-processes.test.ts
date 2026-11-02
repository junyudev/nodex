import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";

const execute = promisify(execFile);

test.skipIf(process.platform !== "win32")(
  "maintenance stops only images within its installation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nodex-maintenance-"));
    const installation = join(root, "Nodex 用户's app");
    const sibling = `${installation}-other`;
    const profileMarker = join(root, "profile.txt");
    const children: ChildProcess[] = [];
    try {
      await writeFile(profileMarker, "preserved");
      for (const directory of [installation, sibling]) {
        await mkdir(directory);
        const executable = join(directory, "node.exe");
        await copyFile(process.execPath, executable);
        const child = spawn(
          executable,
          ["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        children.push(child);
        await once(child.stdout!, "data");
      }
      const stopped = once(children[0]!, "exit");
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
          installation,
          "-CoreHelper",
          process.execPath,
          "-InstallerPid",
          String(process.pid),
        ],
        { timeout: 25_000 },
      );
      await stopped;
      expect(children[0]!.exitCode).toBe(0);
      expect(children[1]!.exitCode).toBeNull();
      process.kill(children[1]!.pid!, 0);
      expect(await readFile(profileMarker, "utf8")).toBe("preserved");
    } finally {
      for (const child of children) {
        if (child.exitCode !== null) continue;
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await rm(root, { force: true, recursive: true });
    }
  },
);
