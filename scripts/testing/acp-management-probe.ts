import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentRuntimeOperations } from "../../packages/agent-runtime/src/nodex/Interface";
import type { AgentRuntimeNode } from "../agent-runtime-native";
import { hasCompletePtyLine, probePtyResize } from "./pty-resize-probe";

type Auth = AgentRuntimeOperations["acp.auth.read"]["output"];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const within = async <A>(promise: Promise<A>, label: string, timeoutMs = 15_000): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Exercises the exact bundle and public pipe protocol used by Electron Main. */
export async function probeAcpManagement(input: {
  root: string;
  node: AgentRuntimeNode;
  home: string;
  peer: string;
}) {
  const fixtureHome = join(input.home, "agent credentials");
  mkdirSync(fixtureHome, { recursive: true });
  rmSync(join(fixtureHome, "authenticated"), { force: true });
  rmSync(join(fixtureHome, "observations.jsonl"), { force: true });
  const instanceId = "pty-probe";
  const ownerId = "pty-probe-owner";
  const injectedSecret = "private-split-token-fixture-394815";
  const runtime = spawn(
    input.node.executable,
    [
      join(input.root, "out/agent-runtime/entry.mjs"),
      "--home",
      join(input.home, "runtime"),
      "--cwd",
      input.home,
    ],
    { cwd: input.home, stdio: ["pipe", "pipe", "pipe"] },
  );
  let diagnostics = "";
  runtime.stderr.on("data", (data: Buffer) => {
    diagnostics = (diagnostics + data.toString()).slice(-16_384);
  });
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  const ready = deferred();
  const stopped = deferred();
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let requestSequence = 0;
  let lastFailureReason: string | undefined;
  const expectFailureReason = (expected: string) => {
    if (lastFailureReason !== expected)
      throw new Error(`Management failure lost its typed ${expected} recovery reason`);
  };
  const lines = createInterface({ input: runtime.stdout });
  lines.on("line", (line) => {
    const frame = JSON.parse(line) as {
      type?: string;
      id?: string;
      success?: boolean;
      output?: unknown;
      error?: { message?: string; acp?: { reason: string } };
    };
    if (frame.type === "ready") ready.resolve();
    if (!frame.id) return;
    const request = pending.get(frame.id);
    if (!request) return;
    pending.delete(frame.id);
    if (frame.success) request.resolve(frame.output);
    else {
      lastFailureReason = frame.error?.acp?.reason;
      request.reject(new Error(frame.error?.message ?? "Runtime request failed"));
    }
  });
  runtime.on("error", (error) => {
    ready.reject(error);
    for (const request of pending.values()) request.reject(error);
  });
  runtime.on("exit", () => {
    stopped.resolve();
    const error = new Error(`Runtime stopped: ${diagnostics}`);
    ready.reject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  const request = <M extends keyof AgentRuntimeOperations>(
    method: M,
    payload: AgentRuntimeOperations[M]["input"],
  ): Promise<AgentRuntimeOperations[M]["output"]> => {
    const id = String(++requestSequence);
    return within(
      new Promise<AgentRuntimeOperations[M]["output"]>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value as AgentRuntimeOperations[M]["output"]),
          reject,
        });
        runtime.stdin.write(`${JSON.stringify({ id, method, input: payload })}\n`);
      }),
      method,
    ).finally(() => pending.delete(id));
  };
  const read = async () => {
    const state = await request("acp.auth.read", { instanceId, ownerId });
    const visible = JSON.stringify(state);
    if (visible.includes(injectedSecret) || visible.includes(injectedSecret.slice(0, 12)))
      throw new Error("A secret escaped through authentication state");
    return state;
  };
  const wait = async (
    predicate: (state: Auth) => boolean,
    label: string,
    end = Date.now() + 20_000,
  ): Promise<Auth> => {
    while (Date.now() < end) {
      const state = await read();
      if (predicate(state)) return state;
      await delay(25);
    }
    throw new Error(`${label}: ${JSON.stringify(await read())}`);
  };
  const respond = (state: Auth, data: string, size?: { cols: number; rows: number }) => {
    if (!state.flowId || state.interaction?.type !== "terminal")
      throw new Error("No active terminal interaction");
    return request("acp.auth.respond", {
      instanceId,
      ownerId,
      flowId: state.flowId,
      interactionId: state.interaction.id,
      response: { type: "terminal", data, ...(size ? { size } : {}) },
    });
  };
  const start = async () => {
    await request("acp.auth.start", { instanceId, ownerId, methodId: "terminal" });
    return wait(
      (state) =>
        state.interaction?.type === "terminal" && state.interaction.output.includes("READY"),
      "terminal readiness",
    );
  };
  const observations = () =>
    readFileSync(join(fixtureHome, "observations.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; pid?: number; method?: string });
  try {
    const bootstrap = {
      type: "bootstrap",
      providers: {
        [instanceId]: {
          driver: "acpRegistry",
          enabled: true,
          environment: Object.entries({
            NODEX_PTY_FIXTURE_HOME: fixtureHome,
            HOME: fixtureHome,
            PATH: process.env.PATH ?? "",
            NODEX_PTY_FIXTURE_TOKEN: injectedSecret,
          }).map(([name, value]) => ({
            name,
            value,
            sensitive: name === "NODEX_PTY_FIXTURE_TOKEN",
          })),
          config: {
            source: "local",
            discovery: "explicit",
            agentId: "pty-fixture",
            commandPath: input.node.executable,
            commandArgs: [input.peer],
            inheritEnvironment: false,
          },
        },
      },
    };
    runtime.stdin.write(`${JSON.stringify(bootstrap)}\n`);
    await within(ready.promise, "Runtime startup", 30_000);
    await request("acp.operation.read", { operationId: "missing-operation" }).catch(
      () => undefined,
    );
    expectFailureReason("operation_expired");
    const first = await start();
    await respond(first, "secret\r");
    const masked = await wait(
      (state) =>
        state.interaction?.type === "terminal" && state.interaction.output.includes("SECRET_DONE"),
      "secret redaction",
    );
    if (
      masked.interaction?.type !== "terminal" ||
      !masked.interaction.output.includes("TOKEN:[redacted]")
    )
      throw new Error("Split secret was not masked");
    await probePtyResize(
      {
        resize: (cols, rows) => respond(first, "roundtrip\r", { cols, rows }),
        query: () => respond(first, "size\r"),
        waitForLine: (line, deadline) =>
          wait(
            (state) =>
              state.interaction?.type === "terminal" &&
              hasCompletePtyLine(state.interaction.output, line),
            "terminal resize",
            deadline,
          ),
      },
      109,
      37,
      20_000,
    );
    await wait(
      (state) =>
        state.interaction?.type === "terminal" &&
        state.interaction.output.includes("INPUT:roundtrip"),
      "terminal input",
    );
    await respond(first, "\u0004");
    await wait((state) => state.phase === "failed", "zero exit must not authenticate");
    const second = await start();
    await respond(second, "success\r");
    await wait((state) => state.phase === "succeeded", "credential recheck");
    rmSync(join(fixtureHome, "authenticated"), { force: true });
    const third = await start();
    await respond(third, "child\r");
    await wait(
      (state) =>
        state.interaction?.type === "terminal" && state.interaction.output.includes("CHILD:"),
      "terminal descendant",
    );
    await request("acp.auth.cancel", { instanceId, ownerId, flowId: third.flowId! });
    await wait((state) => state.phase === "cancelled", "terminal cancellation");
    let staleRejected = false;
    try {
      await respond(third, "late\r");
    } catch {
      staleRejected = true;
    }
    if (!staleRejected) throw new Error("Cancelled terminal accepted stale input");
    expectFailureReason("invalid_request");
    await request("shutdown", {});
    await within(stopped.promise, "Runtime shutdown");
    const events = observations();
    const pids = events.flatMap((event) => (event.pid ? [event.pid] : []));
    for (let attempt = 0; attempt < 100 && pids.some(isAlive); attempt++) await delay(20);
    if (pids.some(isAlive))
      throw new Error(`Login left live processes: ${pids.filter(isAlive).join(", ")}`);
    if (events.some((event) => event.method === "authenticate" || event.method === "auth/login"))
      throw new Error("Terminal login used the ACP authenticate method");
    return {
      startup: "pass",
      spawn: "pass",
      input: "pass",
      secretRedaction: "pass",
      typedFailure: "pass",
      resize: "pass",
      eof: "pass",
      zeroExitIsNotAuthenticated: "pass",
      authRecheck: "pass",
      cancel: "pass",
      staleInput: "pass",
      descendants: "pass",
      shutdown: "pass",
      residualProcesses: 0,
    };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`, {
      cause: error,
    });
  } finally {
    if (runtime.exitCode === null && runtime.signalCode === null) {
      runtime.kill("SIGTERM");
      await within(stopped.promise, "cleanup", 3000).catch(() => runtime.kill("SIGKILL"));
    }
    lines.close();
  }
}
