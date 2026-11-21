import { parentPort, workerData } from "node:worker_threads";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { localFileWatchHost } from "../file-watch-host";
import * as WorkspaceFileListing from "../platform/node/WorkspaceFileListing";
import { makeFileIndexModule } from "./file-index-module";
import {
  isFileIndexWorkerHostMessage,
  type FileIndexWorkerData,
  type FileIndexWorkerHostMessage,
  type FileIndexWorkerThreadMessage,
} from "./file-index-worker-protocol";

class FileIndexWorkerEntryError extends Schema.TaggedError<FileIndexWorkerEntryError>()(
  "FileIndexWorkerEntryError",
  { message: Schema.String },
) {}

/** Main sends one message per keystroke; far more than this means the protocol broke. */
const INBOX_CAPACITY = 1_024;

const requirePort = (): NonNullable<typeof parentPort> => {
  if (!parentPort) throw new Error("File index worker requires a parent message port");
  return parentPort;
};

const readData = (): FileIndexWorkerData => {
  const data = workerData as Partial<FileIndexWorkerData> | undefined;
  if (
    typeof data?.epoch !== "number" ||
    !Number.isSafeInteger(data.epoch) ||
    data.epoch < 1 ||
    typeof data.ripgrepPath !== "string" ||
    !data.ripgrepPath ||
    typeof data.environment !== "object" ||
    data.environment === null
  )
    throw new Error("File index worker received invalid startup data");
  return { epoch: data.epoch, ripgrepPath: data.ripgrepPath, environment: data.environment };
};

const port = requirePort();
const data = readData();

const program = Effect.scoped(
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => port.close()));
    const post = (message: FileIndexWorkerThreadMessage): void => port.postMessage(message);
    const index = yield* makeFileIndexModule({
      platform: process.platform,
      watchHost: localFileWatchHost,
      publish: post,
    });
    const inbox = yield* Queue.bounded<FileIndexWorkerHostMessage, FileIndexWorkerEntryError>(
      INBOX_CAPACITY,
    );
    const reject = (message: string) =>
      Queue.failCauseUnsafe(inbox, Cause.fail(new FileIndexWorkerEntryError({ message })));
    const onMessage = (raw: unknown): void => {
      if (!isFileIndexWorkerHostMessage(raw)) {
        reject("File index worker received an invalid host message");
        return;
      }
      if (!Queue.offerUnsafe(inbox, raw)) reject("File index worker inbox overflowed");
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => port.on("message", onMessage)),
      () => Effect.sync(() => port.off("message", onMessage)),
    );
    post({ type: "ready", epoch: data.epoch });
    // One consumer keeps open, query and close in the order Main sent them.
    while (true) {
      const message = yield* Queue.take(inbox);
      if (message.type === "shutdown") return;
      if (message.type === "open") yield* index.open(message.sessionId, message.roots);
      else if (message.type === "query")
        yield* index.query(message.sessionId, message.seq, message.query);
      else yield* index.close(message.sessionId);
    }
  }),
).pipe(
  // This is the file index worker process composition root.
  Effect.provide(
    WorkspaceFileListing.layer({ executable: data.ripgrepPath, environment: data.environment }),
  ),
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      const error = Cause.squash(cause);
      process.stderr.write(
        `File index worker failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }),
  ),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
