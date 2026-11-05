import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { expect, test } from "vite-plus/test";
import { installationListenerAddresses } from "./ci/probe-windows-installer";

const execute = promisify(execFile);
import { requiredNativeExecutable } from "./testing/native-artifacts";

test.skipIf(process.platform !== "win32")(
  "maintenance joins installation children exiting with their desktop host",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nodex-maintenance-family-"));
    const installation = join(root, "Nodex 用户's app");
    let desktop: ChildProcess | undefined;
    let childPids: number[] = [];
    try {
      await mkdir(installation);
      const executable = join(installation, "Nodex.exe");
      const fixture = join(root, "desktop-family.cjs");
      await copyFile(process.execPath, executable);
      await writeFile(
        fixture,
        `const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
if (process.argv[2] === "child") {
  process.stdin.resume();
  process.stdin.on("end", () => setTimeout(() => process.exit(0), Number(process.argv[3])));
  console.log("ready");
} else {
  const children = [0, 1, 4, 16].map(delay => spawn(process.execPath, [__filename, "child", String(delay)], {stdio:["pipe","pipe","inherit"]}));
  Promise.all(children.map(async child => {
    const lines = createInterface({input:child.stdout});
    await once(lines, "line");
    lines.close();
  })).then(() => console.log(JSON.stringify(children.map(child => child.pid))));
  setInterval(() => {}, 1000);
}
`,
      );
      desktop = spawn(executable, [fixture], { stdio: ["ignore", "pipe", "pipe"] });
      const lines = createInterface({ input: desktop.stdout! });
      try {
        const [ready] = await once(lines, "line", { signal: AbortSignal.timeout(15_000) });
        childPids = JSON.parse(String(ready)) as number[];
        expect(childPids).toHaveLength(4);
      } finally {
        lines.close();
      }
      await execute(
        requiredNativeExecutable("windows-maintenance"),
        [
          "--installation-directory",
          installation,
          "--helper-directory",
          root,
          "--installer-pid",
          String(process.pid),
          "--log-path",
          join(root, "maintenance.log"),
        ],
        { timeout: 60_000 },
      );
      if (desktop.exitCode === null)
        await once(desktop, "exit", { signal: AbortSignal.timeout(5_000) });
      for (const pid of childPids) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (desktop?.exitCode === null && desktop.signalCode === null) {
        const exited = once(desktop, "exit", { signal: AbortSignal.timeout(5_000) });
        desktop.kill();
        await exited;
      }
      const deadline = Date.now() + 5_000;
      const running = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      while (childPids.some(running) && Date.now() < deadline)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      await rm(root, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 });
    }
  },
  120_000,
);

// Exercise root rejection through read-only inspection so a regression cannot
// turn this boundary test into a request to stop every process on the volume.
test.skipIf(process.platform !== "win32")(
  "maintenance refuses a volume root before inspecting its processes",
  async () => {
    await expect(
      execute(requiredNativeExecutable("windows-maintenance"), ["--inspect", parse(tmpdir()).root]),
    ).rejects.toMatchObject({ code: 1 });
  },
  30_000,
);

test.skipIf(process.platform !== "win32")(
  "maintenance records why a relative installation was refused",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nodex-maintenance-refusal-"));
    const log = join(root, "maintenance.log");
    try {
      await expect(
        execute(requiredNativeExecutable("windows-maintenance"), [
          "--installation-directory",
          ".",
          "--helper-directory",
          root,
          "--installer-pid",
          String(process.pid),
          "--log-path",
          log,
        ]),
      ).rejects.toMatchObject({ code: 1 });
      expect(await readFile(log, "utf8")).toMatch(
        /step=initialize failed: Installation directory must be absolute/,
      );
    } finally {
      await rm(root, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 });
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
        requiredNativeExecutable("windows-maintenance"),
        [
          "--installation-directory",
          installationAlias,
          "--helper-directory",
          root,
          "--installer-pid",
          String(process.pid),
        ],
        { timeout: 60_000 },
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
      await rm(root, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 });
    }
  },
  120_000,
);
