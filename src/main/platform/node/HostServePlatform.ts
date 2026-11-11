/* @effect-diagnostics asyncFunction:off newPromise:off preferSchemaOverJson:off globalTimers:off -- Bounded native lifecycle/filesystem work is a Node Adapter. */
import { withoutAgentShell } from "./agent-shell-environment";
import { spawn } from "node:child_process";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { makePrivatePaths, verifyPrivatePaths } from "./private-filesystem";

const configuration = z.strictObject({
  version: z.literal(1),
  spaceId: z.string().min(1),
  ownerMemberId: z.string().min(1),
  address: z.string().min(1),
  executionHome: z.string().refine(isAbsolute),
  repositories: z
    .record(z.string().min(1).max(2048), z.string().min(1).max(4096).refine(isAbsolute))
    .default({})
    .refine((value) => Object.keys(value).length <= 256),
  agentRunner: z
    .strictObject({
      user: z.string().trim().min(1),
      launcher: z.tuple([z.string().min(1)]).rest(z.string()),
    })
    .optional(),
});
export type HostConfiguration = z.infer<typeof configuration>;

export async function readHostConfiguration(
  coreHome: string,
  coreExecutable: string,
): Promise<HostConfiguration> {
  const file = join(coreHome, "host.json");
  await verifyPrivatePaths(
    [
      { path: coreHome, directory: true },
      { path: file, directory: false },
    ],
    coreExecutable,
  );
  const handle = await open(file, "r");
  const source = await (async () => {
    try {
      if ((await handle.stat()).size > 64 * 1024)
        throw new Error("Host configuration exceeds its byte bound");
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  })();
  const value = configuration.parse(JSON.parse(source));
  const [physicalCoreHome, executionHome] = await Promise.all([
    realpath(coreHome),
    realpath(value.executionHome),
  ]);
  if (
    containsPath(physicalCoreHome, executionHome) ||
    containsPath(executionHome, physicalCoreHome)
  )
    throw new Error("Execution state must be outside the private Core home");
  if (!(await lstat(executionHome)).isDirectory())
    throw new Error("Execution home must be a directory");
  return { ...value, executionHome };
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

/** An OS advisory lock survives stale files and releases when the Host's pipe closes. */
export async function openHostLease(input: {
  readonly cli: string;
  readonly coreHome: string;
  readonly instance: string;
  readonly pid: number;
  readonly environment: Readonly<Record<string, string>>;
}) {
  const child = spawn(
    input.cli,
    [
      "serve",
      "lock",
      "--home",
      input.coreHome,
      "--instance",
      input.instance,
      "--parent-pid",
      String(input.pid),
    ],
    {
      env: withoutAgentShell(input.environment),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdin.on("error", () => {});
  const close = () =>
    new Promise<void>((resolve) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
  try {
    await new Promise<void>((resolve, reject) => {
      let bytes = "";
      let errorBytes = "";
      const timer = setTimeout(() => finish(new Error("Host lease readiness timed out")), 10_000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        child.stdout.off("data", onData);
        child.stderr.off("data", onStderr);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) => finish(error);
      const onExit = () =>
        finish(
          new Error(
            errorBytes
              ? "Another Host owns this Space or its lease is unavailable"
              : "Host lease closed before readiness",
          ),
        );
      const onStderr = (part: Buffer) => {
        errorBytes = (errorBytes + part.toString()).slice(0, 4096);
      };
      const onData = (part: Buffer) => {
        bytes += part.toString();
        if (bytes.length > 4096) {
          finish(new Error("Host lease response exceeds its bound"));
          return;
        }
        const end = bytes.indexOf("\n");
        if (end < 0) return;
        try {
          if (JSON.parse(bytes.slice(0, end)).locked !== true)
            throw new Error("Host lease response is invalid");
          finish();
        } catch {
          finish(new Error("Host lease response is invalid"));
        }
      };
      child.once("error", onError);
      child.once("exit", onExit);
      child.stdout.on("data", onData);
      child.stderr.on("data", onStderr);
    });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    closed: new Promise<number | null>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(child.exitCode);
        return;
      }
      child.once("exit", resolve);
    }),
    close,
  };
}

export async function writeHostStatus(
  coreHome: string,
  coreExecutable: string,
  value: { readonly instance: string } & Readonly<Record<string, unknown>>,
): Promise<void> {
  const file = join(coreHome, "run/host.json");
  const pending = `${file}.${value.instance}.pending`;
  const handle = await open(pending, "wx", 0o600);
  try {
    try {
      if (process.platform === "win32")
        await makePrivatePaths([{ path: pending, directory: false }], coreExecutable);
      await handle.writeFile(JSON.stringify(value));
    } finally {
      await handle.close();
    }
    await rename(pending, file);
  } finally {
    await unlink(pending).catch(() => undefined);
  }
}

export async function clearHostStatus(coreHome: string, instance: string): Promise<void> {
  const file = join(coreHome, "run/host.json");
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return;
  try {
    if ((await handle.stat()).size > 64 * 1024) return;
    if (JSON.parse(await handle.readFile("utf8")).instance === instance) await unlink(file);
  } finally {
    await handle.close();
  }
}
