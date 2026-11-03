import { createInterface } from "node:readline";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import {
  runWorktreeWorkerApplication,
  type WorktreeWorkerTransport,
} from "./WorktreeWorkerApplication";

const hostId = process.argv[2]?.trim();
if (!hostId) throw new Error("Remote worktree worker requires an execution host id");
const shellEnvironment = {
  baseEnvironment: { ...process.env },
  platform: process.platform,
} as const;

const transport: WorktreeWorkerTransport = {
  close: () => {
    process.exitCode = 0;
    process.stdin.pause();
    process.stdin.destroy();
  },
  post: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  subscribe: (listener, onClose) => {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const onLine = (line: string): void => {
      if (!line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        listener(null);
        return;
      }
      listener(message);
    };
    lines.on("line", onLine);
    lines.on("close", onClose);
    return () => {
      lines.off("line", onLine);
      lines.off("close", onClose);
      lines.close();
    };
  },
};

NodeRuntime.runMain(
  runWorktreeWorkerApplication({ epoch: 1, hostId, shellEnvironment, transport }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        const error = Cause.squash(cause);
        process.stderr.write(
          `Remote worktree worker failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }),
    ),
  ),
  { disableErrorReporting: true },
);
