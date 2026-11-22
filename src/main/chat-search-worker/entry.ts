import { parentPort, workerData } from "node:worker_threads";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { ChatSearchWorkerData } from "./chat-search-worker-protocol";
import { serveChatSearchWorker } from "./chat-search-worker-module";

const requirePort = (): NonNullable<typeof parentPort> => {
  if (!parentPort) throw new Error("Chat search worker requires a parent message port");
  return parentPort;
};

const readData = (): ChatSearchWorkerData => {
  const data = workerData as Partial<ChatSearchWorkerData> | undefined;
  if (typeof data?.epoch !== "number" || !Number.isSafeInteger(data.epoch) || data.epoch < 1)
    throw new Error("Chat search worker received invalid startup data");
  return { epoch: data.epoch };
};

const port = requirePort();
const data = readData();

const program = serveChatSearchWorker(
  {
    post: (message) => port.postMessage(message),
    listen: (listener) => {
      port.on("message", listener);
      return () => port.off("message", listener);
    },
  },
  data.epoch,
).pipe(
  // This is the chat search worker process composition root.
  Effect.ensuring(Effect.sync(() => port.close())),
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      const error = Cause.squash(cause);
      process.stderr.write(
        `Chat search worker failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }),
  ),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
