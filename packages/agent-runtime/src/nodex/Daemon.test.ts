// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { AgentRuntimeBootstrap } from "./Bootstrap.ts";
import type { AgentRuntimeResponse, AgentStorageSnapshot } from "./Interface.ts";

async function startProcess(
  home: string,
  bootstrap: AgentRuntimeBootstrap | null = { type: "bootstrap", providers: {}, hostTools: [] },
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./entry.ts", import.meta.url)),
      "--home",
      home,
      "--cwd",
      home,
    ],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (bootstrap) child.stdin.write(`${JSON.stringify(bootstrap)}\n`);
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const waiting = new Map<
    string,
    { resolve: (response: AgentRuntimeResponse) => void; reject: (cause: Error) => void }
  >();
  let stderr = "";
  const invalidLines: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let readyResolve!: () => void;
  let readyReject!: (cause: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const input = readline.createInterface({ input: child.stdout });
  input.on("line", (line) => {
    try {
      const frame = JSON.parse(line) as AgentRuntimeResponse | { readonly type: string };
      if ("type" in frame && frame.type === "ready") {
        readyResolve();
        return;
      }
      if ("id" in frame) {
        waiting.get(frame.id)?.resolve(frame);
        waiting.delete(frame.id);
      }
    } catch {
      invalidLines.push(line);
      const error = new Error("The execution process emitted a non-JSON stdout line.");
      readyReject(error);
      for (const pending of waiting.values()) pending.reject(error);
      waiting.clear();
    }
  });
  child.once("error", readyReject);
  child.once("exit", () => {
    const error = new Error(`Execution process closed: ${stderr}`);
    readyReject(error);
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
  });
  let nextId = 0;
  const request = (method: string, input: unknown = {}) =>
    new Promise<AgentRuntimeResponse>((resolve, reject) => {
      const id = String(nextId++);
      waiting.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, input })}\n`);
    });
  try {
    await ready;
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  const waitForDiagnostic = (message: string) =>
    new Promise<void>((resolve, reject) => {
      if (stderr.includes(message)) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        child.stderr.off("data", inspect);
        reject(new Error(`Expected provider diagnostic was not emitted: ${stderr}`));
      }, 15_000);
      const inspect = () => {
        if (!stderr.includes(message)) return;
        clearTimeout(timeout);
        child.stderr.off("data", inspect);
        resolve();
      };
      child.stderr.on("data", inspect);
    });
  return {
    child,
    exit,
    request,
    invalidLines,
    waitForDiagnostic,
    close: async () => {
      child.stdin.end();
      return await exit;
    },
  };
}

it("preserves actionable search cursor failures through real stdio", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-search-cursor-process-"));
  const runtime = await startProcess(home);
  try {
    expect(
      await runtime.request("sessions.search", { query: "history", cursor: "invalid-cursor" }),
    ).toMatchObject({
      success: false,
      error: { tag: "SessionSearchError", reason: "invalid_cursor" },
    });
    expect(runtime.invalidLines).toEqual([]);
    expect(await runtime.close()).toBe(0);
  } finally {
    runtime.child.kill("SIGKILL");
    await runtime.exit;
    await fs.rm(home, { recursive: true, force: true });
  }
});

it("releases a snapshot ahead of 32 blocked reads and closes an unreleased lease on EOF", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-snapshot-process-"));
  const runtime = await startProcess(home);
  try {
    const acquired = await runtime.request("storage.snapshot.acquire");
    expect(acquired.success).toBe(true);
    if (!acquired.success) return;
    const snapshot = acquired.output as AgentStorageSnapshot;
    const reads = Array.from({ length: 32 }, () =>
      runtime.request("thread.read", { threadId: "thread:absent" }),
    );
    const released = await runtime.request("storage.snapshot.release", {
      leaseId: snapshot.leaseId,
    });
    expect(released).toMatchObject({ success: true, output: { released: true } });
    expect(
      (await Promise.all(reads)).every((response) => response.success && response.output === null),
    ).toBe(true);
    const second = await runtime.request("storage.snapshot.acquire");
    expect(second.success).toBe(true);
    const code = await runtime.close();
    expect(code).toBe(0);
    if (second.success) {
      expect(
        await fs.stat((second.output as AgentStorageSnapshot).databasePath).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    }
    expect(runtime.invalidLines).toEqual([]);
  } finally {
    runtime.child.kill("SIGKILL");
    await runtime.exit;
    await fs.rm(home, { recursive: true, force: true });
  }
});

it("shuts down ahead of a full lane of reads waiting behind an unreleased snapshot", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-snapshot-shutdown-"));
  const runtime = await startProcess(home);
  try {
    expect((await runtime.request("storage.snapshot.acquire")).success).toBe(true);
    const reads = Array.from({ length: 32 }, () =>
      runtime.request("thread.read", { threadId: "thread:absent" }).catch(() => undefined),
    );
    expect(await runtime.request("shutdown")).toMatchObject({
      success: true,
      output: { stopped: true },
    });
    expect(await runtime.exit).toBe(0);
    await Promise.all(reads);
    expect(runtime.invalidLines).toEqual([]);
  } finally {
    runtime.child.kill("SIGKILL");
    await runtime.exit;
    await fs.rm(home, { recursive: true, force: true });
  }
});

it("keeps provider refresh warnings after readiness off the JSON protocol stream", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-runtime-logging-"));
  const binary = path.join(home, "codex-fixture.mjs");
  await fs.writeFile(
    binary,
    `#!${process.execPath}
import readline from 'node:readline';
for await (const line of readline.createInterface({ input: process.stdin })) {
  const {id,method} = JSON.parse(line);
  if (id === undefined) continue;
  const result = method === 'initialize' ? { userAgent: 'codex-app-server/0.145.0', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos' }
    : method === 'account/read' ? { account: { type: 'chatgpt', email: 'fixture@example.com', planType: 'plus' }, requiresOpenaiAuth: false }
    : method === 'model/list' ? { data: [], nextCursor: null }
    : method === 'skills/list' ? { data: [] }
    : { rateLimits: null };
  process.stdout.write(JSON.stringify({id,result})+'\\n');
}
`,
    { mode: 0o700 },
  );
  const runtime = await startProcess(home);
  try {
    expect(
      (
        await runtime.request("providers.configure", {
          providers: {
            codex: {
              driver: "codex",
              config: { binaryPath: binary, homePath: path.join(home, "codex") },
            },
          },
        })
      ).success,
    ).toBe(true);
    const refreshed = await runtime.request("providers.read", { refresh: true });
    expect(refreshed.success).toBe(true);
    await runtime.waitForDiagnostic("Codex did not refresh its model catalog in time");
    expect((await runtime.request("runtime.identity")).success).toBe(true);
    expect(await runtime.close()).toBe(0);
    expect(runtime.invalidLines).toEqual([]);
  } finally {
    runtime.child.kill("SIGKILL");
    await runtime.exit;
    await fs.rm(home, { recursive: true, force: true });
  }
});

it("admits one physical writer, removes ownership on EOF, and recovers a killed writer", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-writer-process-"));
  let runtime = await startProcess(home);
  try {
    const lock = path.join(home, ".writer.lock");
    const firstOwner = JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")) as {
      pid: number;
      token: string;
    };
    expect(firstOwner.pid).toBe(runtime.child.pid);
    await expect(startProcess(home)).rejects.toThrow("Another execution writer");
    expect(JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8"))).toEqual(
      firstOwner,
    );
    expect((await runtime.request("runtime.identity")).success).toBe(true);
    expect(await runtime.close()).toBe(0);
    expect(
      await fs.stat(lock).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    runtime = await startProcess(home);
    const killedOwner = JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")) as {
      pid: number;
      token: string;
    };
    runtime.child.kill("SIGKILL");
    await runtime.exit;
    expect(JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8"))).toEqual(
      killedOwner,
    );
    runtime = await startProcess(home);
    const recovered = JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")) as {
      pid: number;
      token: string;
    };
    expect(recovered.pid).toBe(runtime.child.pid);
    expect(recovered.token).not.toBe(killedOwner.token);
    expect(await runtime.close()).toBe(0);
    expect(
      await fs.stat(lock).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    runtime.child.kill("SIGKILL");
    await runtime.exit;
    await fs.rm(home, { recursive: true, force: true });
  }
});

it("starts only from a stdin bootstrap whose provider instances stay out of the environment", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-runtime-bootstrap-"));
  const runtime = await startProcess(home, {
    type: "bootstrap",
    providers: {
      codex: {
        driver: "codex",
        enabled: false,
        environment: [{ name: "OPENAI_API_KEY", value: "bootstrap-secret", sensitive: true }],
        config: { binaryPath: path.join(home, "codex"), homePath: path.join(home, "codex-home") },
      },
    },
  });
  try {
    const providers = await runtime.request("providers.read");
    expect(providers.success).toBe(true);
    if (providers.success)
      expect(
        (providers.output as ReadonlyArray<{ readonly instanceId: string }>).map(
          (provider) => provider.instanceId,
        ),
      ).toContain("codex");
    expect(await runtime.close()).toBe(0);
  } finally {
    runtime.child.kill("SIGKILL");
    await runtime.exit;
    await fs.rm(home, { recursive: true, force: true });
  }
  const unconfigured = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-runtime-no-bootstrap-"));
  try {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./entry.ts", import.meta.url)),
        "--home",
        unconfigured,
      ],
      { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
    child.stdin.write(`${JSON.stringify({ id: "1", method: "runtime.identity", input: {} })}\n`);
    expect(await exit).toBe(1);
    expect(stdout).toBe("");
  } finally {
    await fs.rm(unconfigured, { recursive: true, force: true });
  }
});
