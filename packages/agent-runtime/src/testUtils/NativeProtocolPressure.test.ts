import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as BoundedQueue from "@t3tools/shared/BoundedQueue";
import * as Codex from "../../vendor/effect-codex-app-server/src/protocol.ts";
import * as Acp from "../../vendor/effect-acp/src/protocol.ts";
import { makeInMemoryStdio } from "../../vendor/effect-codex-app-server/src/_internal/stdio.ts";

const encoder = new TextEncoder();
const frame = (value: unknown) => encoder.encode(JSON.stringify(value) + "\n");

describe("native protocol pressure", () => {
  it.effect(
    "Codex retires on a stalled outgoing reader, fails pending requests and accepts a fresh connection",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { stdio } = yield* makeInMemoryStdio();
          const held = yield* Deferred.make<void>();
          const writing = yield* Deferred.make<void>();
          const blocked = Stdio.make({
            ...stdio,
            stdout: () =>
              Sink.forEach(() =>
                Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(held))),
              ),
          });
          const stopped = yield* Deferred.make<unknown>();
          const transport = yield* Codex.makeCodexAppServerPatchedProtocol({
            stdio: blocked,
            onTermination: (error) => Deferred.succeed(stopped, error).pipe(Effect.asVoid),
          });
          const pending = yield* transport
            .request("thread/read", { threadId: "original" })
            .pipe(Effect.forkScoped({ startImmediately: true }));
          yield* Deferred.await(writing);
          const flood = yield* Effect.exit(
            Effect.forEach(
              Array.from({ length: BoundedQueue.DEFAULT_MAX_ITEMS + 1 }),
              () => transport.notify("initialized"),
              { discard: true },
            ),
          );
          assert.isTrue(Exit.isFailure(flood));
          const terminal = yield* Deferred.await(stopped);
          const failed = yield* Fiber.await(pending);
          assert.isTrue(Exit.isFailure(failed));
          if (Exit.isFailure(failed)) assert.strictEqual(Cause.squash(failed.cause), terminal);
          assert.strictEqual(yield* transport.notify("initialized").pipe(Effect.flip), terminal);
          const fresh = yield* makeInMemoryStdio();
          const recovered = yield* Codex.makeCodexAppServerPatchedProtocol({ stdio: fresh.stdio });
          yield* recovered.notify("initialized");
          assert.equal(yield* Queue.take(fresh.output), '{"method":"initialized"}\n');
        }),
      ),
  );
  it.effect(
    "Codex rejects unfinished giant wire frames before decoding and fails an active request",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { stdio, input, output } = yield* makeInMemoryStdio();
          const stopped = yield* Deferred.make<unknown>();
          let decoded = 0;
          const transport = yield* Codex.makeCodexAppServerPatchedProtocol({
            stdio,
            logIncoming: true,
            logger: (event) =>
              Effect.sync(() => {
                if (event.stage === "decoded") decoded++;
              }),
            onTermination: (error) => Deferred.succeed(stopped, error).pipe(Effect.asVoid),
          });
          const pending = yield* transport.request("thread/read", {}).pipe(Effect.forkScoped);
          yield* Queue.take(output);
          yield* Queue.offer(input, encoder.encode("x".repeat(BoundedQueue.MAX_PROMPT_BYTES)));
          yield* Queue.offer(input, encoder.encode("x"));
          const failure = yield* Deferred.await(stopped);
          assert.equal(decoded, 0);
          const exit = yield* Fiber.await(pending);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) assert.strictEqual(Cause.squash(exit.cause), failure);
        }),
      ),
  );
  it.effect(
    "Codex and ACP accept supported multi-image-sized prompts and reject above the outbound bound",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const payload = { images: "a".repeat(28 * 1024 * 1024) };
          const codexStdio = yield* makeInMemoryStdio();
          const echo = yield* Deferred.make<unknown>();
          const codex = yield* Codex.makeCodexAppServerPatchedProtocol({
            stdio: codexStdio.stdio,
            onNotification: (notification) =>
              Deferred.succeed(echo, notification.params).pipe(Effect.asVoid),
          });
          yield* codex.notify("large-prompt", payload);
          const written = yield* Queue.take(codexStdio.output);
          assert.isAbove(written.length, 28 * 1024 * 1024);
          yield* Queue.offer(
            codexStdio.input,
            frame({ method: "item/completed", params: payload }),
          );
          assert.deepEqual(yield* Deferred.await(echo), payload);
          const acpStdio = yield* makeInMemoryStdio();
          const acp = yield* Acp.makeAcpPatchedProtocol({
            stdio: acpStdio.stdio,
            serverRequestMethods: new Set(),
          });
          yield* acp.notify("session/prompt", payload);
          assert.isAbove((yield* Queue.take(acpStdio.output)).length, 28 * 1024 * 1024);
          const oversized = { images: "a".repeat(BoundedQueue.MAX_PROMPT_BYTES) };
          assert.isTrue(
            Exit.isFailure(yield* Effect.exit(codex.notify("large-prompt", oversized))),
          );
          assert.isTrue(
            Exit.isFailure(yield* Effect.exit(acp.notify("session/prompt", oversized))),
          );
        }),
      ),
  );
  it.effect("ACP rejects a stalled native request consumer and closes pending outbound work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const stopped = yield* Deferred.make<unknown>();
        const transport = yield* Acp.makeAcpPatchedProtocol({
          stdio,
          serverRequestMethods: new Set(["fs/read_text_file"]),
          onTermination: (error) => Deferred.succeed(stopped, error).pipe(Effect.asVoid),
        });
        const pending = yield* transport.request("session/prompt", {}).pipe(Effect.forkScoped);
        yield* Queue.take(output);
        for (let i = 0; i <= BoundedQueue.DEFAULT_MAX_ITEMS; i++)
          yield* Queue.offer(
            input,
            frame({
              jsonrpc: "2.0",
              id: "native-" + i,
              method: "fs/read_text_file",
              params: { sessionId: "native-original", path: "/workspace/file" },
            }),
          );
        const failure = yield* Deferred.await(stopped);
        const exit = yield* Fiber.await(pending);
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) assert.strictEqual(Cause.squash(exit.cause), failure);
        assert.strictEqual(
          yield* transport
            .notify("session/cancel", { sessionId: "native-original" })
            .pipe(Effect.flip),
          failure,
        );
      }),
    ),
  );
});
