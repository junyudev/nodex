import { parentPort, workerData } from "node:worker_threads";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  GIT_WORKER_PROTOCOL_VERSION,
  isGitWorkerMessageFromHost,
  type GitWorkerMessageFromHost,
  type GitWorkerMessageFromThread,
  type GitWorkerResponse,
} from "../../shared/git-worker-protocol";
import * as GitCommandPlatformNode from "../platform/node/GitCommandPlatformNode";
import { makeGitWorkerModule } from "./git-worker-module";

interface GitWorkerEntryData {
  epoch?: unknown;
}

class GitWorkerEntryError extends Schema.TaggedError<GitWorkerEntryError>()("GitWorkerEntryError", {
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

const requirePort = (): NonNullable<typeof parentPort> => {
  if (!parentPort) throw new Error("Git worker requires a parent message port");
  return parentPort;
};

const readEpoch = (): number => {
  const entryData = workerData as GitWorkerEntryData | undefined;
  return typeof entryData?.epoch === "number" &&
    Number.isInteger(entryData.epoch) &&
    entryData.epoch >= 1
    ? entryData.epoch
    : 1;
};

const program = Effect.scoped(
  Effect.gen(function* () {
    const port = requirePort();
    const epoch = readEpoch();
    yield* Effect.addFinalizer(() => Effect.sync(() => port.close()));
    const worker = yield* makeGitWorkerModule({
      environment: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      publish: (message) => port.postMessage(message),
    });
    const shutdown = yield* Deferred.make<void, GitWorkerEntryError>();
    const requests = yield* FiberMap.make<string, void>();
    const runRequest = yield* FiberMap.runtime(requests)<Scope.Scope>();
    const runControl = yield* FiberSet.makeRuntime<never, void, never>();
    const post = (message: GitWorkerMessageFromThread): void => port.postMessage(message);
    const fail = (cause: unknown): void => {
      const error = new GitWorkerEntryError({
        cause,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      runControl(Deferred.fail(shutdown, error));
    };
    const execute = (message: Extract<GitWorkerMessageFromHost, { type: "worker-request" }>) =>
      worker.execute(message.request).pipe(
        Effect.tap((value) =>
          Effect.sync(() =>
            post({
              type: "worker-response",
              workerId: "git",
              id: message.request.id,
              method: message.request.method,
              result: { type: "ok", value },
            } as GitWorkerResponse),
          ),
        ),
        Effect.catchCause((cause) =>
          cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason)
            ? Effect.void
            : Effect.sync(() => fail(Cause.squash(cause))),
        ),
        Effect.asVoid,
      );
    const onMessage = (rawMessage: unknown): void => {
      if (!isGitWorkerMessageFromHost(rawMessage)) {
        fail(new Error("Git worker received an invalid host message"));
        return;
      }
      if (rawMessage.type === "worker-shutdown") {
        runControl(Deferred.succeed(shutdown, undefined));
        return;
      }
      if (rawMessage.type === "worker-request-cancel") {
        runControl(FiberMap.remove(requests, rawMessage.id));
        return;
      }
      if (FiberMap.hasUnsafe(requests, rawMessage.request.id)) {
        fail(new Error("Git worker received a duplicate active request id"));
        return;
      }
      runRequest(rawMessage.request.id, execute(rawMessage), {
        onlyIfMissing: true,
      });
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => port.on("message", onMessage)),
      () => Effect.sync(() => port.off("message", onMessage)),
    );
    post({
      type: "worker-ready",
      workerId: "git",
      epoch,
      protocolVersion: GIT_WORKER_PROTOCOL_VERSION,
    });
    yield* Deferred.await(shutdown);
  }),
).pipe(
  // this is the Git worker process composition root.
  Effect.provide(GitCommandPlatformNode.nodeLive),
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      const error = Cause.squash(cause);
      process.stderr.write(
        `Git worker failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }),
  ),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
