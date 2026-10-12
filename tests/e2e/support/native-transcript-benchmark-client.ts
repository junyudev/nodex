import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import { nativeReadOnlyBenchmarkEnvironment } from "./native-transcript-benchmark-preflight";

type Method =
  | "initialize"
  | "thread/resume"
  | "thread/read"
  | "thread/turns/list"
  | "thread/items/list"
  | "thread/searchOccurrences";
const methods = new Set<Method>([
  "initialize",
  "thread/resume",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "thread/searchOccurrences",
]);
export interface NativeBenchmarkRequestSample {
  readonly requestId: number;
  readonly pid: number;
  readonly method: Method;
  readonly phase: string;
  readonly startedAtEpochMs: number;
  readonly pipeWriteCompletedAtEpochMs: number | null;
  readonly completedAtEpochMs: number;
  readonly durationMs: number;
  readonly responseBytes: number;
}
interface Pending {
  readonly method: Method;
  readonly phase: string;
  readonly startedAtMs: number;
  readonly startedAtEpochMs: number;
  pipeWriteCompletedAtEpochMs: number | null;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** A separate official stdio process observes reads only and never overlaps the app's native process. */
export async function createNativeTranscriptBenchmarkClient(input: {
  executable: string;
  codexHome: string;
  cwd: string;
}) {
  const environment = {
    ...process.env,
    ...nativeReadOnlyBenchmarkEnvironment(process.env),
    CODEX_HOME: input.codexHome,
  };
  const child = spawn(input.executable, ["app-server", "--listen", "stdio://"], {
    cwd: input.cwd,
    env: Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, Pending>();
  const samples: NativeBenchmarkRequestSample[] = [];
  let sequence = 0;
  let closed = false;
  let stderrBytes = 0;
  child.stderr.on("data", (bytes: Buffer) => {
    stderrBytes += bytes.byteLength;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (
      !message ||
      typeof message !== "object" ||
      !("id" in message) ||
      typeof message.id !== "number"
    )
      return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    samples.push({
      requestId: message.id,
      pid: child.pid!,
      method: request.method,
      phase: request.phase,
      startedAtEpochMs: request.startedAtEpochMs,
      pipeWriteCompletedAtEpochMs: request.pipeWriteCompletedAtEpochMs,
      completedAtEpochMs: Date.now(),
      durationMs: performance.now() - request.startedAtMs,
      responseBytes: Buffer.byteLength(line) + 1,
    });
    if ("error" in message) {
      const error = message.error;
      const detail =
        error &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string"
          ? error.message
          : "Native request failed";
      request.reject(new Error(`Official native ${request.method}: ${detail}`));
      return;
    }
    if (!("result" in message)) {
      request.reject(new Error("Native response has no result"));
      return;
    }
    request.resolve(message.result);
  });
  const rejectPending = (error: Error) => {
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  child.on("error", rejectPending);
  child.on("exit", () => rejectPending(new Error("Owned official native process exited")));
  const call = <M extends Method>(
    method: M,
    params: ClientRequestParamsByMethod[M],
    phase: string,
  ): Promise<ClientRequestResponsesByMethod[M]> => {
    if (closed || !methods.has(method))
      return Promise.reject(new Error("Read-only native request is unavailable"));
    const requestId = ++sequence;
    return new Promise((resolve, reject) => {
      const request: Pending = {
        method,
        phase,
        startedAtMs: performance.now(),
        startedAtEpochMs: Date.now(),
        pipeWriteCompletedAtEpochMs: null,
        resolve: (value) => resolve(value as ClientRequestResponsesByMethod[M]),
        reject,
        timer: setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Official native ${method} timed out`));
        }, 60_000),
      };
      pending.set(requestId, request);
      child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`, (error) => {
        if (error) {
          pending.delete(requestId);
          clearTimeout(request.timer);
          reject(error);
          return;
        }
        request.pipeWriteCompletedAtEpochMs = Date.now();
      });
    });
  };
  const close = async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      lines.close();
      return;
    }
    const completion = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.kill("SIGTERM");
    try {
      await completion;
    } finally {
      clearTimeout(timer);
      lines.close();
    }
  };
  try {
    await call(
      "initialize",
      {
        clientInfo: { name: "nodex_native_history_benchmark", version: "1.0" },
        capabilities: { experimentalApi: true },
      },
      "initialize",
    );
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return { call, close, samples, pid: child.pid!, getStderrByteCount: () => stderrBytes };
  } catch (error) {
    await close();
    throw error;
  }
}
