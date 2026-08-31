import { expect, it } from "vite-plus/test";
import { limitAcpNdjsonLines } from "./AcpSessionTransport";

const encoder = new TextEncoder();

const byteStream = (...chunks: readonly string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

const consume = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: Uint8Array[] = [],
): Promise<readonly Uint8Array[]> =>
  reader.read().then((next) => {
    if (next.done) return chunks;
    return consume(reader, [...chunks, next.value]);
  });

it("accepts bounded NDJSON records split across chunks", () =>
  expect(
    consume(limitAcpNdjsonLines(byteStream("ab", "cd\nef", "\n"), 4).getReader()),
  ).resolves.toHaveLength(3));

it("rejects an oversized NDJSON record before the SDK buffers it", () =>
  expect(consume(limitAcpNdjsonLines(byteStream("ab", "cde"), 4).getReader())).rejects.toThrow(
    "ACP NDJSON line exceeded 4 bytes",
  ));
