import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { it } from "@effect/vitest";
import { expect, test } from "vitest";
import { codexIncomingLines, makeCodexIncomingMessages } from "./CodexIncomingMessages";

test("frame decoding respects view offsets, CRLF and blank lines", () => {
  const bytes = Buffer.from('skip{"id":1}\r\n \n{"id":2}tail');
  expect(codexIncomingLines(bytes.subarray(4, -4))).toEqual(['{"id":1}', '{"id":2}']);
  expect(codexIncomingLines(new TextEncoder().encode('{"id":3}').buffer)).toEqual(['{"id":3}']);
  expect(codexIncomingLines([bytes])).toEqual([]);
  expect(codexIncomingLines(null)).toEqual([]);
});

it.effect("malformed and partial frames cannot consume later responses or alter receipt time", () =>
  Effect.gen(function* () {
    const input = yield* makeCodexIncomingMessages();
    input.offerData('{"id":1,', 10);
    input.offerData('"result":false}\n{bad}\n  {"id":2,"result":"中文"} \n', 20);
    const messages = yield* input.messages.pipe(Stream.take(1), Stream.runCollect);
    expect(messages).toEqual([
      {
        value: { id: 2, result: "中文" },
        bytes: Buffer.byteLength('{"id":2,"result":"中文"}'),
        receivedAtMs: 20,
      },
    ]);
    expect(input.depth()).toBe(0);
  }),
);

it.effect("a 19999-line batch is admitted but a 20000-line batch overflows inclusively", () =>
  Effect.gen(function* () {
    const input = yield* makeCodexIncomingMessages();
    input.offerData('{"id":1}\n'.repeat(19_999), 0);
    expect(input.depth()).toBe(19_999);
    input.offerData('{"id":2}', 0);
    const result = yield* input.messages.pipe(Stream.runCollect, Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result))
      expect(Cause.pretty(result.cause)).toContain("Incoming line queue overflow");
    expect(input.depth()).toBe(0);
  }),
);

it.effect("draining yields after 200 lines without moving the queue depth ahead of dispatch", () =>
  Effect.gen(function* () {
    const input = yield* makeCodexIncomingMessages();
    input.offerData(Array.from({ length: 450 }, (_, id) => JSON.stringify({ id })).join("\n"), 0);
    let count = 0;
    let countAtYield = 0;
    const messages = yield* input.messages.pipe(
      Stream.tap(() =>
        Effect.sync(() => {
          count += 1;
          expect(input.depth()).toBe(450 - count);
          if (count === 1)
            setImmediate(() => {
              countAtYield = count;
            });
        }),
      ),
      Stream.take(450),
      Stream.runCollect,
    );
    expect(messages.map(({ value }) => value)).toEqual(
      Array.from({ length: 450 }, (_, id) => ({ id })),
    );
    expect(countAtYield).toBeGreaterThan(0);
    expect(countAtYield).toBeLessThanOrEqual(200);
  }),
);

it.effect(
  "the elapsed-time budget yields before the count limit and close flushes pending lines",
  () =>
    Effect.gen(function* () {
      const input = yield* makeCodexIncomingMessages();
      input.offerData('{"id":1}\n{"id":2}\n{"id":3}', 10);
      let yielded = false;
      const messages = yield* input.messages.pipe(
        Stream.tap(({ value }) =>
          Effect.gen(function* () {
            const id = (value as { id: number }).id;
            if (id === 1) {
              setImmediate(() => {
                yielded = true;
              });
              yield* TestClock.adjust(8);
            }
            if (id === 2) {
              expect(yielded).toBe(true);
              input.end();
            }
          }),
        ),
        Stream.runCollect,
      );
      expect(messages.map(({ value }) => value)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    }),
);

it.effect("retiring the queue wakes a pending consumer and rejects later input", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const input = yield* makeCodexIncomingMessages().pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    const reader = yield* input.messages.pipe(Stream.runCollect, Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Scope.close(scope, Exit.void);
    input.offerData('{"id":1}', 1);
    expect(yield* Fiber.join(reader)).toEqual([]);
    expect(input.depth()).toBe(0);
  }),
);
