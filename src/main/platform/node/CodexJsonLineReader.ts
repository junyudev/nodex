import { constants } from "node:buffer";
import { Writable, type Duplex } from "node:stream";
import parser from "stream-json/parser.js";
import FlexAssembler from "stream-json/utils/flex-assembler.js";
import type {
  CodexAppServerInboundProgress,
  CodexAppServerReceiveTiming,
} from "@nodex/effect-codex-app-server/protocol";

import {
  CodexChunkedArray,
  markCodexChunkedJson,
} from "@nodex/effect-codex-app-server/transport-values";
export {
  CodexChunkedArray,
  materializeCodexJson,
} from "@nodex/effect-codex-app-server/transport-values";

function estimatedBytes(value: unknown, limit: number): number {
  type Entry =
    | { type: "value"; value: unknown }
    | { type: "leave"; value: object }
    | { type: "values"; iterator: Iterator<unknown> }
    | { type: "object"; entries: [string, unknown][]; index: number };
  const stack: Entry[] = [{ type: "value", value }];
  const active = new WeakSet<object>();
  let bytes = 0;
  while (stack.length && bytes <= limit) {
    const entry = stack.pop()!;
    if (entry.type === "leave") {
      active.delete(entry.value);
      continue;
    }
    if (entry.type === "values") {
      const next = entry.iterator.next();
      if (!next.done) stack.push(entry, { type: "value", value: next.value });
      continue;
    }
    if (entry.type === "object") {
      const next = entry.entries[entry.index++];
      if (next) {
        bytes += next[0].length * 2 + 16;
        stack.push(entry, { type: "value", value: next[1] });
      }
      continue;
    }
    const current = entry.value;
    if (typeof current === "string") {
      bytes += current.length * 2 + 16;
      continue;
    }
    if (typeof current !== "object" || current === null) {
      bytes += 16;
      continue;
    }
    if (active.has(current)) continue;
    active.add(current);
    bytes += 32;
    stack.push({ type: "leave", value: current });
    if (current instanceof CodexChunkedArray) {
      const iterator = (function* () {
        for (const chunk of current.chunks) yield* chunk;
      })();
      stack.push({ type: "values", iterator });
      continue;
    }
    if (Array.isArray(current)) {
      stack.push({ type: "values", iterator: current.values() });
      continue;
    }
    stack.push({ type: "object", entries: Object.entries(current), index: 0 });
  }
  return bytes;
}

class ArrayBuilder {
  private readonly chunks: unknown[][] = [];
  private current: unknown[] = [];
  private bytes = 0;
  private length = 0;
  constructor(private readonly target: number) {}
  add(value: unknown): void {
    const bytes = estimatedBytes(value, this.target);
    if (this.current.length && this.bytes + bytes > this.target) {
      this.chunks.push(this.current);
      this.current = [];
      this.bytes = 0;
    }
    this.current.push(value);
    this.bytes += bytes;
    this.length += 1;
  }
  finish(): unknown[] | CodexChunkedArray {
    if (this.current.length) this.chunks.push(this.current);
    return this.chunks.length <= 1
      ? (this.chunks[0] ?? [])
      : new CodexChunkedArray(this.chunks, this.length);
  }
}

interface Line {
  chunks: Buffer[];
  bytes: number;
  contentBytes: number;
  nonWhitespace: boolean;
  parser: Duplex | null;
  error: Error | null;
  value: Record<string, unknown> | null;
  count: number;
  chunked: boolean;
  progress: CodexAppServerInboundProgress | null;
}
const newLine = (): Line => ({
  chunks: [],
  bytes: 0,
  contentBytes: 0,
  nonWhitespace: false,
  parser: null,
  error: null,
  value: null,
  count: 0,
  chunked: false,
  progress: null,
});
const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/** JSONL keeps large lines in a streaming parser instead of imposing a rejection quota. */
export class CodexJsonLineReader extends Writable {
  private line = newLine();
  private readonly threshold: number;
  constructor(
    private readonly options: {
      readonly maxBufferedLineBytes?: number;
      readonly arrayChunkBytes?: number;
      readonly now?: () => number;
      readonly onMessage: (
        message: Record<string, unknown>,
        bytes: number,
        timing: CodexAppServerReceiveTiming,
      ) => void;
      readonly onParseError: (error: Error, bytes: number) => void;
    },
  ) {
    super();
    this.threshold =
      options.maxBufferedLineBytes ??
      Math.min(256 * 1024 * 1024, Math.floor(constants.MAX_STRING_LENGTH / 2));
  }
  getCurrentLineProgress(): CodexAppServerInboundProgress | null {
    return this.line.progress;
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    let offset = 0;
    const advance = () => {
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        offset = end + (newline < 0 ? 0 : 1);
        if (newline < 0) {
          this.append(part, callback);
          return;
        }
        this.line.bytes += 1;
        let synchronous = true;
        let processed = false;
        this.append(part, () =>
          this.finishLine(() => {
            if (synchronous) {
              processed = true;
              return;
            }
            advance();
          }),
        );
        synchronous = false;
        if (!processed) return;
      }
      callback();
    };
    advance();
  }
  override _final(callback: (error?: Error | null) => void): void {
    this.finishLine(callback);
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.line.parser?.destroy();
    callback(error);
  }
  private append(chunk: Buffer, done: () => void): void {
    const line = this.line;
    line.bytes += chunk.length;
    line.contentBytes += chunk.length;
    if (chunk.length > 0) {
      line.progress ??= { startedAtMs: (this.options.now ?? Date.now)(), bytesReceived: 0 };
      line.progress.bytesReceived = line.bytes;
    }
    if (!line.nonWhitespace)
      line.nonWhitespace = chunk.some((byte) => byte !== 32 && byte !== 9 && byte !== 13);
    if (line.error || !chunk.length) {
      done();
      return;
    }
    if (line.parser) {
      this.writeParser(line, [chunk], done);
      return;
    }
    line.chunks.push(chunk);
    if (line.contentBytes <= this.threshold) {
      done();
      return;
    }
    const chunks = line.chunks;
    line.chunks = [];
    try {
      const stream = parser.asStream({
        jsonStreaming: true,
        packValues: true,
        streamValues: false,
      });
      line.parser = stream;
      const assembler = FlexAssembler.connectTo(stream, {
        objectRules: [
          {
            filter: () => true,
            create: () => ({}),
            add: (object: Record<string, unknown>, key: string, value: unknown) => {
              Object.defineProperty(object, key, {
                configurable: true,
                enumerable: true,
                writable: true,
                value,
              });
            },
          },
        ],
        arrayRules: [
          {
            filter: () => true,
            create: () => new ArrayBuilder(this.options.arrayChunkBytes ?? 4 * 1024 * 1024),
            add: (array: ArrayBuilder, value: unknown) => {
              array.add(value);
            },
            finalize: (array: ArrayBuilder) => {
              const value = array.finish();
              if (value instanceof CodexChunkedArray) line.chunked = true;
              return value;
            },
          },
        ],
      });
      assembler.on("done", () => {
        line.count += 1;
        if (line.count > 1) {
          line.error = new Error("App-server stdout line contained multiple JSON values");
          line.value = null;
          return;
        }
        this.acceptValue(line, assembler.current);
      });
      stream.on("error", (error: Error) => {
        line.error = error;
        line.value = null;
      });
      this.writeParser(line, chunks, done);
    } catch (error) {
      line.error = asError(error);
      done();
    }
  }
  private writeParser(line: Line, chunks: readonly Buffer[], done: () => void): void {
    const stream = line.parser!;
    let index = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      stream.off("drain", write);
      stream.off("error", finish);
      done();
    };
    const write = () => {
      stream.off("drain", write);
      stream.off("error", finish);
      try {
        while (index < chunks.length && !line.error) {
          const accepted = stream.write(chunks[index++]!);
          if (line.error) {
            finish();
            return;
          }
          if (!accepted) {
            stream.once("drain", write);
            stream.once("error", finish);
            return;
          }
        }
        finish();
      } catch (error) {
        line.error = asError(error);
        line.value = null;
        finish();
      }
    };
    write();
  }
  private acceptValue(line: Line, value: unknown): void {
    if (
      typeof value !== "object" ||
      !value ||
      Array.isArray(value) ||
      value instanceof CodexChunkedArray
    ) {
      line.error = new Error("App-server stdout line did not contain a JSON-RPC object");
      line.value = null;
      return;
    }
    line.value = value as Record<string, unknown>;
  }
  private finishLine(done: () => void): void {
    const line = this.line;
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      if (line.error) this.options.onParseError(line.error, line.bytes);
      else if (line.value) {
        if (line.chunked) markCodexChunkedJson(line.value);
        const receivedAtMs = (this.options.now ?? Date.now)();
        if (line.progress) {
          line.progress.bytesReceived = line.bytes;
          line.progress.receivedAtMs = receivedAtMs;
        }
        this.options.onMessage(line.value, line.bytes, {
          receiveStartedAtMs: line.progress?.startedAtMs ?? receivedAtMs,
          receivedAtMs,
        });
      } else if (line.nonWhitespace)
        this.options.onParseError(
          new Error("App-server stdout line did not contain a complete JSON value"),
          line.bytes,
        );
      this.line = newLine();
      done();
    };
    if (line.error) {
      line.parser?.destroy();
      finish();
      return;
    }
    if (line.parser) {
      line.parser.once("error", finish);
      try {
        line.parser.end(finish);
      } catch (error) {
        line.error = asError(error);
        finish();
      }
      return;
    }
    if (line.nonWhitespace) {
      try {
        this.acceptValue(
          line,
          JSON.parse(Buffer.concat(line.chunks, line.contentBytes).toString("utf8")),
        );
      } catch (error) {
        line.error = asError(error);
      }
    }
    line.chunks = [];
    finish();
  }
}
