import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import type { CodexAppServerReceiveTiming } from "@nodex/effect-codex-app-server/protocol";
import {
  CodexChunkedArray,
  CodexJsonLineReader,
  materializeCodexJson,
} from "./CodexJsonLineReader";

const read = (chunks: readonly Buffer[], threshold = 32, chunkBytes = 80) =>
  Effect.callback<
    { values: { message: Record<string, unknown>; bytes: number }[]; errors: string[] },
    Error
  >((resume) => {
    const values: { message: Record<string, unknown>; bytes: number }[] = [];
    const errors: string[] = [];
    const reader = new CodexJsonLineReader({
      maxBufferedLineBytes: threshold,
      arrayChunkBytes: chunkBytes,
      onMessage: (message, bytes) => values.push({ message, bytes }),
      onParseError: (error) => errors.push(error.message),
    });
    reader.once("error", (error: Error) => resume(Effect.fail(error)));
    reader.once("finish", () => resume(Effect.succeed({ values, errors })));
    for (const chunk of chunks) reader.write(chunk);
    reader.end();
    return Effect.sync(() => {
      reader.destroy();
    });
  });

it.effect(
  "live progress retains its identity through split UTF-8, delimiter receipt and final EOF",
  () =>
    Effect.gen(function* () {
      for (const threshold of [1, 1024]) {
        let now = 10;
        const delivered: { bytes: number; timing: CodexAppServerReceiveTiming }[] = [];
        const reader = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new CodexJsonLineReader({
                maxBufferedLineBytes: threshold,
                now: () => now,
                onMessage: (_message, bytes, timing) => {
                  delivered.push({ bytes, timing });
                },
                onParseError: (error) => {
                  throw error;
                },
              }),
          ),
          (reader) =>
            Effect.sync(() => {
              reader.destroy();
            }),
        );
        const write = (bytes: Buffer) =>
          Effect.callback<void, Error>((resume) => {
            reader.write(bytes, (error) => resume(error ? Effect.fail(error) : Effect.void));
          });
        const bytes = Buffer.from('{"id":1,"result":"中文"}\r\n');
        const splitAt = bytes.indexOf(Buffer.from("中")) + 1;
        yield* write(bytes.subarray(0, splitAt));
        const progress = reader.getCurrentLineProgress();
        expect(progress).toEqual({ startedAtMs: 10, bytesReceived: splitAt });
        now = 25;
        yield* write(bytes.subarray(splitAt, -1));
        expect(reader.getCurrentLineProgress()).toBe(progress);
        expect(progress?.bytesReceived).toBe(bytes.length - 1);
        now = 30;
        yield* write(bytes.subarray(-1));
        expect(progress).toEqual({
          startedAtMs: 10,
          bytesReceived: bytes.length,
          receivedAtMs: 30,
        });
        expect(reader.getCurrentLineProgress()).toBeNull();
        now = 40;
        const final = Buffer.from('{"id":2,"result":null}');
        yield* write(final);
        now = 50;
        yield* Effect.callback<void>((resume) => {
          reader.end(() => resume(Effect.void));
        });
        expect(delivered).toEqual([
          { bytes: bytes.length, timing: { receiveStartedAtMs: 10, receivedAtMs: 30 } },
          { bytes: final.length, timing: { receiveStartedAtMs: 40, receivedAtMs: 50 } },
        ]);
      }
    }),
);

it.effect("streams oversized arrays across UTF-8 chunk boundaries", () =>
  Effect.gen(function* () {
    const value = {
      id: "1",
      result: { items: Array.from({ length: 20 }, (_, i) => ({ text: `中文-${i}` })) },
    };
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value);
    const bytes = Buffer.from(`${encoded}\n`);
    const chunks = Array.from(bytes, (_, index) => bytes.subarray(index, index + 1));
    const result = yield* read(chunks);
    expect(result.errors).toEqual([]);
    expect(result.values[0]!.bytes).toBe(bytes.length);
    expect((result.values[0]!.message.result as { items: unknown }).items).toBeInstanceOf(
      CodexChunkedArray,
    );
    expect(materializeCodexJson(result.values[0]!.message)).toEqual(value);
  }),
);

it.effect("a malformed streamed line does not prevent the next complete object", () =>
  Effect.gen(function* () {
    const result = yield* read([
      Buffer.from(
        '{"padding":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",bad}\n{"id":2,"result":{}}\n',
      ),
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.values.map(({ message }) => materializeCodexJson(message))).toEqual([
      { id: 2, result: {} },
    ]);
  }),
);

it.effect(
  "rejects multiple values and array roots while accepting the final unterminated line",
  () =>
    Effect.gen(function* () {
      const result = yield* read([Buffer.from('{} {}\n[]\n{"id":3,"result":true}')], 1);
      expect(result.errors).toHaveLength(2);
      expect(result.values.map(({ message }) => materializeCodexJson(message))).toEqual([
        { id: 3, result: true },
      ]);
    }),
);

it.effect("retains own prototype-named keys in both parsing paths", () =>
  Effect.gen(function* () {
    for (const threshold of [1, 1000]) {
      const result = yield* read(
        [Buffer.from('{"id":1,"result":{"__proto__":{"safe":true}}}\n')],
        threshold,
      );
      const value = materializeCodexJson(result.values[0]!.message) as { result: object };
      expect(Object.hasOwn(value.result, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(value.result)).toBe(Object.prototype);
    }
  }),
);

it.effect("drains many buffered lines without recursive stack growth", () =>
  Effect.gen(function* () {
    const result = yield* read([Buffer.from('{"id":1}\n'.repeat(20_000))], 1000);
    expect(result.errors).toEqual([]);
    expect(result.values).toHaveLength(20_000);
  }),
);
