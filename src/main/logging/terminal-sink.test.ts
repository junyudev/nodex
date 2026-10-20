import { Writable } from "node:stream";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { describe, expect, test } from "vite-plus/test";
import { createTerminalLogSink, MAX_TERMINAL_RECORD_BYTES } from "./terminal-sink";

describe("terminal log sink", () => {
  test.each(["EIO", "EPIPE"])(
    "contains asynchronous %s without retrying the failed stream",
    async (code) => {
      const writes: string[] = [];
      const stream = new Writable({
        autoDestroy: false,
        write(chunk, _encoding, callback) {
          writes.push(String(chunk));
          setImmediate(() => callback(Object.assign(new Error(`write ${code}`), { code })));
        },
      });
      const write = createTerminalLogSink(stream);

      write("first record");
      await nextImmediate();
      for (let index = 0; index < 1_000; index += 1) write("later record");
      stream.emit("drain");
      write("after drain");

      expect(writes).toEqual(["first record\n"]);
      stream.destroy();
    },
  );

  test("permanently disables a sink after a synchronous write failure", () => {
    let attempts = 0;
    const stream = new Writable({
      write() {
        attempts += 1;
        throw new Error("broken terminal");
      },
    });
    const write = createTerminalLogSink(stream);

    expect(() => write("first record")).not.toThrow();
    write("later record");
    stream.emit("drain");
    write("after drain");

    expect(attempts).toBe(1);
    stream.destroy();
  });

  test("disables a writable stream on an error event without closing it", () => {
    const writes: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        writes.push(String(chunk));
        callback();
      },
    });
    const write = createTerminalLogSink(stream);

    stream.emit("error", new Error("terminal detached"));
    stream.emit("drain");
    write("later record");
    stream.emit("error", new Error("delayed error"));

    expect(stream.destroyed).toBe(false);
    expect(writes).toEqual([]);
    stream.destroy();
  });

  test("drops pressure without buffering or replaying records, then resumes after drain", async () => {
    const writes: string[] = [];
    const completions: Array<() => void> = [];
    const stream = new Writable({
      highWaterMark: 8,
      write(chunk, _encoding, callback) {
        writes.push(String(chunk));
        completions.push(callback);
      },
    });
    const write = createTerminalLogSink(stream);

    write("initial");
    for (let index = 0; index < 10_000; index += 1) write("dropped");
    expect(stream.writableLength).toBe(8);
    expect(writes).toEqual(["initial\n"]);

    completions.shift()?.();
    await nextImmediate();
    write("resumed");
    expect(writes).toEqual(["initial\n", "resumed\n"]);

    completions.shift()?.();
    stream.destroy();
  });

  test("respects pressure from another writer before accepting a record", async () => {
    const writes: string[] = [];
    const completions: Array<() => void> = [];
    const stream = new Writable({
      highWaterMark: 8,
      write(chunk, _encoding, callback) {
        writes.push(String(chunk));
        completions.push(callback);
      },
    });
    const write = createTerminalLogSink(stream);

    stream.write("external");
    write("dropped");
    expect(stream.writableLength).toBe(8);
    completions.shift()?.();
    await nextImmediate();
    write("resumed");
    expect(writes).toEqual(["external", "resumed\n"]);

    completions.shift()?.();
    stream.destroy();
  });

  test("rejects records after closure and still absorbs delayed errors", async () => {
    const writes: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        writes.push(String(chunk));
        callback();
      },
    });
    const write = createTerminalLogSink(stream);

    stream.destroy();
    await nextImmediate();
    write("later record");
    stream.emit("error", new Error("delayed terminal error"));
    stream.emit("drain");
    write("after drain");

    expect(writes).toEqual([]);
  });

  test("caps each admitted record by UTF-8 bytes including its newline", () => {
    const writes: Buffer[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        writes.push(Buffer.from(chunk));
        callback();
      },
    });
    const write = createTerminalLogSink(stream);

    write("x".repeat(MAX_TERMINAL_RECORD_BYTES));
    write("界".repeat(Math.ceil(MAX_TERMINAL_RECORD_BYTES / 3)));
    write("x".repeat(MAX_TERMINAL_RECORD_BYTES - 1));
    write("small");

    expect(writes.map((chunk) => chunk.byteLength)).toEqual([MAX_TERMINAL_RECORD_BYTES, 6]);
    expect(writes[1]?.toString()).toBe("small\n");
    stream.destroy();
  });
});
