import { parentPort, workerData } from "node:worker_threads";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import {
  runWorktreeWorkerApplication,
  type WorktreeWorkerTransport,
} from "./WorktreeWorkerApplication";

const requirePort = (): NonNullable<typeof parentPort> => {
  if (!parentPort) throw new Error("Worktree worker requires a parent message port");
  return parentPort;
};

const readEntryData = (): { readonly epoch: number; readonly hostId: string } => {
  const data = workerData as { epoch?: unknown; hostId?: unknown } | undefined;
  return {
    epoch: typeof data?.epoch === "number" ? data.epoch : 1,
    hostId: typeof data?.hostId === "string" && data.hostId.trim() ? data.hostId.trim() : "local",
  };
};

const port = requirePort();
const data = readEntryData();
const shellEnvironment = {
  baseEnvironment: { ...process.env },
  platform: process.platform,
} as const;
const transport: WorktreeWorkerTransport = {
  close: () => port.close(),
  post: (message) => port.postMessage(message),
  subscribe: (listener, onClose) => {
    port.on("message", listener);
    port.on("close", onClose);
    return () => {
      port.off("message", listener);
      port.off("close", onClose);
    };
  },
};

NodeRuntime.runMain(
  runWorktreeWorkerApplication({ ...data, shellEnvironment, transport }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        const error = Cause.squash(cause);
        process.stderr.write(
          `Worktree worker failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }),
    ),
  ),
  { disableErrorReporting: true },
);
