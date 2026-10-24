import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";

type FixtureMethod =
  | "initialize"
  | "thread/start"
  | "thread/fork"
  | "thread/read"
  | "thread/turns/list"
  | "thread/items/list"
  | "thread/name/set"
  | "thread/archive"
  | "thread/delete"
  | "turn/start";
interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Creates and removes native fixture history through the same pinned public protocol. */
export async function createCodexThreadImportFixtureClient(input: {
  readonly executable: string;
  readonly codexHome: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const child = spawn(input.executable, ["app-server", "--listen", "stdio://"], {
    cwd: input.cwd,
    env: { ...process.env, ...input.environment, CODEX_HOME: input.codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, PendingRequest>();
  const completed = new Map<string, Turn>();
  const turnWaiters = new Map<string, PendingRequest>();
  let sequence = 0;
  let stderr = "";
  child.stderr.on("data", (bytes: Buffer) => {
    stderr = (stderr + bytes.toString("utf8")).slice(-12_000);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "turn/completed") {
      const turn = message.params.turn as Turn;
      completed.set(turn.id, turn);
      const waiter = turnWaiters.get(turn.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      turnWaiters.delete(turn.id);
      waiter.resolve(turn);
      return;
    }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message));
      return;
    }
    request.resolve(message.result);
  });
  const rejectPending = (error: Error) => {
    for (const entry of [...pending.values(), ...turnWaiters.values()]) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    turnWaiters.clear();
  };
  child.on("error", rejectPending);
  child.on("exit", () => rejectPending(new Error(`Owned native fixture exited\n${stderr}`)));
  const call = <K extends FixtureMethod>(
    method: K,
    params: ClientRequestParamsByMethod[K],
  ): Promise<ClientRequestResponsesByMethod[K]> => {
    if (child.exitCode !== null || child.signalCode !== null)
      return Promise.reject(new Error("Native fixture has stopped"));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Native fixture ${method} timed out\n${stderr}`));
      }, 30_000);
      pending.set(id, {
        resolve: (value) => resolve(value as ClientRequestResponsesByMethod[K]),
        reject,
        timer,
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };
  const waitForTurn = async (turnId: string): Promise<Turn> => {
    const previous = completed.get(turnId);
    if (previous) return previous;
    return await new Promise((resolve, reject) => {
      turnWaiters.set(turnId, {
        resolve: (value) => resolve(value as Turn),
        reject,
        timer: setTimeout(() => {
          turnWaiters.delete(turnId);
          reject(new Error(`Native fixture Turn ${turnId} timed out\n${stderr}`));
        }, 30_000),
      });
    });
  };
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      lines.close();
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.kill("SIGTERM");
    try {
      await exited;
    } finally {
      clearTimeout(timer);
      lines.close();
    }
  };
  try {
    await call("initialize", {
      clientInfo: { name: "nodex_import_fixture", version: "1.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return { call, waitForTurn, close };
  } catch (error) {
    await close();
    throw error;
  }
}
