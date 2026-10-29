import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PtyAdapter, type PtyProcess } from "@t3tools/shared/PtyAdapter";
import { NodePtyAdapterLive, NodePtyModuleLoaderRef } from "../src/nodex/NodePtyAdapter.ts";
import { hasCompletePtyLine, probePtyResize } from "../../../scripts/testing/pty-resize-probe.ts";

const [packageRoot, peer, home] = process.argv.slice(2);
if (!packageRoot || !peer || !home) throw new Error("PTY probe requires package, peer and home");
const require = createRequire(import.meta.url);
const adapter = await Effect.runPromise(
  PtyAdapter.pipe(
    Effect.provide(
      NodePtyAdapterLive.pipe(
        Layer.provide(
          Layer.succeed(
            NodePtyModuleLoaderRef,
            async () => require(packageRoot) as typeof import("node-pty"),
          ),
        ),
      ),
    ),
  ),
);
const live = new Set<PtyProcess>();
const start = async () => {
  const pty = await Effect.runPromise(
    adapter.spawn({
      shell: process.execPath,
      args: [peer, "login"],
      cwd: home,
      cols: 80,
      rows: 24,
      env: { ...process.env, NODEX_PTY_FIXTURE_HOME: home },
    }),
  );
  live.add(pty);
  let output = "";
  const observers = new Set<() => void>();
  const exited = Promise.withResolvers<number>();
  pty.onData((data) => {
    output = (output + data).slice(-16_384);
    for (const observe of observers) observe();
  });
  pty.onExit(({ exitCode }) => {
    live.delete(pty);
    exited.resolve(exitCode);
  });
  const waitForOutput = (
    text: string,
    matches: (output: string) => boolean,
    deadline = Date.now() + 10_000,
  ) =>
    new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        observers.delete(check);
      };
      const check = () => {
        if (!matches(output)) return;
        cleanup();
        resolve();
      };
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(new Error(`PTY output missing ${text}: ${output}`));
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`PTY output missing ${text}: ${output}`));
      }, remaining);
      observers.add(check);
      check();
    });
  const wait = (text: string) => waitForOutput(text, (output) => output.includes(text));
  const waitForLine = (text: string, deadline: number) =>
    waitForOutput(text, (output) => hasCompletePtyLine(output, text), deadline);
  const exit = () =>
    Promise.race([
      exited.promise,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("PTY exit timed out")), 10_000);
        timer.unref();
      }),
    ]);
  await wait("READY");
  return { pty, wait, waitForLine, exit };
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
try {
  const roundtrip = await start();
  roundtrip.pty.write("echo-probe\r");
  await roundtrip.wait("INPUT:echo-probe");
  await probePtyResize(
    {
      resize: (cols, rows) => roundtrip.pty.resize(cols, rows),
      query: () => roundtrip.pty.write("size\r"),
      waitForLine: roundtrip.waitForLine,
    },
    109,
    37,
  );
  roundtrip.pty.write("\u0004");
  if ((await roundtrip.exit()) !== 0) throw new Error("EOF did not produce a successful exit");
  const cancel = await start();
  cancel.pty.write("child\r");
  await cancel.wait("CHILD:");
  cancel.pty.kill("SIGKILL");
  await cancel.exit();
  const observations = readFileSync(join(home, "observations.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { pid?: number });
  const pids = observations.flatMap((entry) => (entry.pid ? [entry.pid] : []));
  for (let attempt = 0; attempt < 100 && pids.some(alive); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  if (pids.some(alive))
    throw new Error(`PTY left live processes: ${pids.filter(alive).join(", ")}`);
  process.stdout.write(
    `${JSON.stringify({ nativeLoad: "pass", spawn: "pass", input: "pass", resize: "pass", eof: "pass", exit: "pass", cancel: "pass", descendants: "pass", residualProcesses: 0 })}\n`,
  );
} finally {
  for (const pty of live) pty.kill("SIGKILL");
}
