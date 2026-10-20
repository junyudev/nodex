import type { Writable } from "node:stream";
import type { ActiveLogLevelName } from "./log-level";

export const MAX_TERMINAL_RECORD_BYTES = 64 * 1024;

type TerminalLogSink = (line: string) => void;

const processSinks = new WeakMap<Writable, TerminalLogSink>();

/**
 * Borrows a stream for its lifetime without closing it or retaining a log queue.
 * Sink errors stay local: reporting them through logging would repeat the failure.
 */
export function createTerminalLogSink(stream: Writable): TerminalLogSink {
  let disabled = false;
  let blocked = stream.writableNeedDrain;
  const disable = () => {
    disabled = true;
  };
  const onWrite = (error: Error | null | undefined) => {
    if (error) disable();
  };

  // Keep the error listener after failure/close to absorb delayed write errors.
  stream.on("error", disable);
  stream.on("close", disable);
  stream.on("drain", () => {
    blocked = false;
  });

  return (line) => {
    if (disabled || blocked) return;
    if (stream.destroyed || !stream.writable || stream.errored) {
      disable();
      return;
    }
    if (stream.writableNeedDrain) {
      blocked = true;
      return;
    }
    // Reject whole records so JSON lines remain valid; include the newline budget.
    if (
      line.length >= MAX_TERMINAL_RECORD_BYTES ||
      Buffer.byteLength(line, "utf8") >= MAX_TERMINAL_RECORD_BYTES
    ) {
      return;
    }

    try {
      if (!stream.write(`${line}\n`, onWrite)) blocked = true;
    } catch {
      disable();
    }
  };
}

/** All Main terminal logging shares failure and backpressure state per stream. */
export function writeTerminalLog(level: ActiveLogLevelName, line: string): void {
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  let sink = processSinks.get(stream);
  if (!sink) {
    sink = createTerminalLogSink(stream);
    processSinks.set(stream, sink);
  }
  sink(line);
}
