import { assert, it } from "@effect/vitest";
import { MessageId, ProviderDriverKind, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeProviderEventBuffer } from "./ProviderEventBuffer.ts";

const driver = ProviderDriverKind.make("codex");
const event = (thread: string, text: string): ProviderAdapter.ProviderAdapterV2Event => ({
  type: "message.updated",
  driver,
  message: {
    id: MessageId.make(`${thread}:${text}`),
    threadId: ThreadId.make(thread),
    runId: null,
    nodeId: null,
    role: "assistant",
    createdBy: "agent",
    creationSource: "provider",
    text,
    attachments: [],
    streaming: false,
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
  },
});
const makeBuffer = (maxItems = 2) =>
  makeProviderEventBuffer({
    maxItems,
    mapOverflow: (cause) =>
      new ProviderAdapter.ProviderAdapterEventStreamError({
        driver,
        providerSessionId: ProviderSessionId.make("shared"),
        cause,
      }),
  });

it.effect("preserves FIFO causality across threads with independent admission budgets", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const buffer = yield* makeBuffer();
      const events = [
        event("parent", "started"),
        event("child", "started"),
        event("child", "finished"),
        event("parent", "finished"),
      ];
      for (const value of events) yield* buffer.offer(value);
      assert.deepEqual(
        Array.from(yield* buffer.events.pipe(Stream.take(4), Stream.runCollect)),
        events,
      );
    }),
  ),
);

it.effect(
  "collapses a lost thread's backlog to one signal and never replays stale lane tokens",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const buffer = yield* makeBuffer();
        yield* buffer.offer(event("hot", "first"));
        yield* buffer.offer(event("sibling", "first"));
        yield* buffer.offer(event("hot", "second"));
        yield* buffer.offer(event("hot", "overflow"));
        for (let i = 0; i < 20; i++) yield* buffer.offer(event("hot", "discarded"));
        const lost = Array.from(
          yield* buffer.observations.pipe(Stream.take(1), Stream.runCollect),
        )[0]!;
        assert.equal(lost.type, "observation_loss");
        if (lost.type === "observation_loss") assert.equal(lost.threadId, "hot");
        const fresh = event("hot", "fresh");
        yield* buffer.offer(fresh);
        const observed = Array.from(yield* buffer.events.pipe(Stream.take(2), Stream.runCollect));
        assert.deepEqual(observed, [event("sibling", "first"), fresh]);
      }),
    ),
);
