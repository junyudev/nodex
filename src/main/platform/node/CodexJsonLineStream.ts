import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  createCodexAppServerReceiveMetrics,
  type CodexAppServerDecodedMessage,
} from "@nodex/effect-codex-app-server/protocol";
import { setCodexHostSourceLineBytes } from "../../../shared/codex-host-chunked-message";
import { getLogger } from "../../logging/logger";
import { CodexJsonLineReader } from "./CodexJsonLineReader";
import { makeCodexIncomingMessages } from "./CodexIncomingMessages";
import type { CodexHostRequestMetricsState } from "../../codex-runtime/CodexHostRequestMetrics";

const attachSourceLineBytes = (value: unknown, bytes: number): void => {
  if (typeof value !== "object" || value === null) return;
  setCodexHostSourceLineBytes(value, bytes);
  if ("result" in value && typeof value.result === "object" && value.result !== null) {
    setCodexHostSourceLineBytes(value.result, bytes);
  }
  if ("params" in value && typeof value.params === "object" && value.params !== null) {
    setCodexHostSourceLineBytes(value.params, bytes);
  }
};

/** The physical reader owns parser backpressure and drains decoded messages independently. */
export function codexJsonLineMessages(
  input: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
): Stream.Stream<CodexAppServerDecodedMessage, PlatformError.PlatformError> {
  return codexJsonLineTransport(input).decodedMessages;
}

export function codexJsonLineTransport(
  input: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  hostMetrics?: CodexHostRequestMetricsState | null,
) {
  let activeReader: CodexJsonLineReader | null = null;
  let incomingQueueDepth = () => 0;
  const receiveMetrics = createCodexAppServerReceiveMetrics({
    transportKind: "stdio",
    hostKind: hostMetrics?.hostKind,
    state: hostMetrics?.receiveState,
    getInboundMessageProgress: () => activeReader?.getCurrentLineProgress() ?? null,
    getIncomingQueueDepth: () => incomingQueueDepth(),
  });
  if (hostMetrics) hostMetrics.receiver = receiveMetrics;
  const decodedMessages = Stream.unwrap(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const incoming = yield* makeCodexIncomingMessages();
      incomingQueueDepth = incoming.depth;
      let delivered = 200;
      let sliceStarted = clock.currentTimeMillisUnsafe();
      const physicalMessages = Stream.callback<
        CodexAppServerDecodedMessage,
        PlatformError.PlatformError
      >((queue) =>
        Effect.gen(function* () {
          const reader = yield* Effect.acquireRelease(
            Effect.sync(() => {
              activeReader = new CodexJsonLineReader({
                now: () => clock.currentTimeMillisUnsafe(),
                onMessage: (value, bytes, timing) => {
                  const receipt = receiveMetrics.observeIncoming(value, bytes, timing);
                  Queue.offerUnsafe(queue, { value, bytes, receipt });
                },
                onParseError: (error, bytes) => {
                  getLogger().warn("Codex app-server returned an invalid JSON line", {
                    lineBytes: bytes,
                    errorName: error.name,
                  });
                },
              });
              return activeReader;
            }),
            (reader) =>
              Effect.sync(() => {
                reader.destroy();
                if (activeReader === reader) activeReader = null;
              }),
          );
          const platformError = (cause: unknown) =>
            PlatformError.systemError({
              _tag: "Unknown",
              module: "CodexJsonLineReader",
              method: "read",
              cause,
            });
          const fail = (cause: unknown) => {
            Queue.failCauseUnsafe(queue, Cause.fail(platformError(cause)));
          };
          reader.on("error", fail);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              reader.off("error", fail);
            }),
          );
          yield* input.pipe(
            Stream.runForEach((chunk) =>
              Effect.callback<void, PlatformError.PlatformError>((resume) => {
                reader.write(Buffer.from(chunk), (error) =>
                  resume(error ? Effect.fail(platformError(error)) : Effect.void),
                );
              }),
            ),
            Effect.andThen(
              Effect.callback<void, PlatformError.PlatformError>((resume) => {
                reader.end(() => {
                  Queue.endUnsafe(queue);
                  resume(Effect.void);
                });
              }),
            ),
            Effect.catch((error) =>
              Effect.sync(() => {
                Queue.failCauseUnsafe(queue, Cause.fail(error));
              }),
            ),
          );
        }),
      ).pipe(
        Stream.mapEffect((message) =>
          Effect.gen(function* () {
            if (delivered >= 200 || clock.currentTimeMillisUnsafe() - sliceStarted >= 8) {
              yield* Effect.callback<void>((resume) => {
                const handle = setImmediate(() => resume(Effect.void));
                return Effect.sync(() => {
                  clearImmediate(handle);
                });
              });
              delivered = 0;
              sliceStarted = clock.currentTimeMillisUnsafe();
            }
            delivered += 1;
            const value = message.value;
            attachSourceLineBytes(value, message.bytes);
            return { ...message, value };
          }),
        ),
      );
      yield* physicalMessages.pipe(
        Stream.runForEach((message) => Effect.sync(() => incoming.offerParsed(message))),
        Effect.match({
          onSuccess: () => incoming.end(),
          onFailure: incoming.fail,
        }),
        Effect.forkScoped,
      );
      return incoming.messages;
    }),
  );
  return { decodedMessages, receiveMetrics };
}
