/* @effect-diagnostics asyncFunction:off newPromise:off preferSchemaOverJson:off -- Verifies the native Host lease and administration lifecycle with disposable files and Core. */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import { requiredNativeExecutable } from "../../../../scripts/testing/native-artifacts";
import {
  clearHostStatus,
  openHostLease,
  readHostConfiguration,
  writeHostStatus,
} from "./HostServePlatform";
import { verifyHostSecrets } from "./HostSecurity";

const exec = promisify(execFile);
const instance = () => randomBytes(16).toString("hex");

test("initialization prepares identity without listening and the native lease fences duplicate Hosts", async () => {
  const root = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ndx-srv-"));
  const reserved = createServer();
  await new Promise<void>((resolve, reject) => {
    reserved.once("error", reject);
    reserved.listen(0, "127.0.0.1", resolve);
  });
  const address = reserved.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  const cli = requiredNativeExecutable("cli");
  const core = requiredNativeExecutable("core-server");
  const home = join(root, "space");
  const environment = { PATH: process.env.PATH ?? "", NODEX_CORE_BINARY: core };
  const run = (args: readonly string[]) =>
    exec(cli, ["--json", "serve", ...args, "--home", home], { env: environment, timeout: 30_000 });
  try {
    const clone = join(root, "clone");
    await mkdir(clone);
    await exec("git", ["init", "-b", "main"], { cwd: clone });
    const remote = "https://git.example/acme/team";
    await exec("git", ["remote", "add", "origin", remote + ".git"], { cwd: clone });
    // The chosen port stays occupied: init must prepare a certificate without binding it.
    const initialized = JSON.parse(
      (
        await run([
          "init",
          "--address",
          `127.0.0.1:${address.port}`,
          "--repository",
          remote,
          "--clone",
          clone,
        ])
      ).stdout,
    ).result;
    expect(initialized.spaceId).toEqual(expect.any(String));
    expect(initialized.ownerMemberId).toEqual(expect.any(String));
    expect(initialized.fingerprint).toMatch(/^[a-f\d]{64}$/u);
    const config = await readHostConfiguration(initialized.home, core);
    expect(config.spaceId).toBe(initialized.spaceId);
    expect(config.ownerMemberId).toBe(initialized.ownerMemberId);
    expect(config.executionHome).toBe(await realpath(initialized.executionHome));
    expect(Object.keys(config.repositories)).toEqual([remote]);
    expect(await realpath(config.repositories[remote]!)).toBe(await realpath(clone));
    expect(initialized.projectId).toEqual(expect.any(String));
    await verifyHostSecrets(initialized.home, core, { running: false });
    expect(JSON.parse((await run(["status"])).stdout).result).toMatchObject({
      state: "stopped",
      running: false,
    });
    const lease = await openHostLease({
      cli,
      coreHome: initialized.home,
      instance: instance(),
      pid: process.pid,
      environment,
    });
    try {
      await expect(
        openHostLease({
          cli,
          coreHome: initialized.home,
          instance: instance(),
          pid: process.pid,
          environment,
        }),
      ).rejects.toThrow(/owns this Space/u);
    } finally {
      await lease.close();
    }
    await lease.closed;
    const replacement = await openHostLease({
      cli,
      coreHome: initialized.home,
      instance: instance(),
      pid: process.pid,
      environment,
    });
    await replacement.close();
    await replacement.closed;
    const old = instance();
    const current = instance();
    await writeHostStatus(initialized.home, { instance: current, state: "starting" });
    await clearHostStatus(initialized.home, old);
    expect(JSON.parse(await readFile(join(initialized.home, "run/host.json"), "utf8"))).toEqual({
      instance: current,
      state: "starting",
    });
    await clearHostStatus(initialized.home, current);
    await expect(readFile(join(initialized.home, "run/host.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const configurationPath = join(initialized.home, "host.json");
    const rawConfiguration = await readFile(configurationPath, "utf8");
    const nestedExecution = join(initialized.home, "..execution");
    await mkdir(nestedExecution);
    await writeFile(
      configurationPath,
      JSON.stringify({ ...JSON.parse(rawConfiguration), executionHome: nestedExecution }),
    );
    await expect(readHostConfiguration(initialized.home, core)).rejects.toThrow(
      "Execution state must be outside the private Core home",
    );
    await writeFile(configurationPath, rawConfiguration);
    if (process.platform !== "win32") {
      await chmod(configurationPath, 0o640);
      await expect(readHostConfiguration(initialized.home, core)).rejects.toThrow();
    }
  } finally {
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
