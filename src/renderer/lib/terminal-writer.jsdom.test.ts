import { afterEach, expect, test, vi } from "vite-plus/test";
import { createWriter, patchWrappedErase } from "./terminal-writer";

const ERASE = "\r\x1b[2K";
const UP_ERASE = "\x1b[1A" + ERASE;
const BARRIER = "\x00";

function createTarget(type: "normal" | "alternate" = "normal") {
  const issued: string[] = [];
  const parsed: string[] = [];
  const pending: (() => void)[] = [];
  const target = {
    buffer: {
      active: {
        type,
        baseY: 7,
        cursorY: 2,
        getLine: (index: number) => ({ isWrapped: index === 9 || index === 8 }),
      },
    },
    write(data: string | Uint8Array, done?: () => void) {
      if (typeof data !== "string") throw new Error("Expected PTY text");
      issued.push(data);
      pending.push(() => {
        parsed.push(data);
        done?.();
      });
    },
    reset() {
      parsed.push("reset");
    },
  };
  return {
    target,
    issued,
    parsed,
    parseNext: () => pending.shift()?.(),
    parseAll: () => {
      while (pending.length) pending.shift()?.();
    },
  };
}

afterEach(() => vi.useRealTimers());

test("repairs wrapped prompt rows in the normal buffer", () => {
  expect(patchWrappedErase(createTarget().target, ERASE + "prompt")).toBe(
    ERASE + UP_ERASE.repeat(2) + "prompt",
  );
  expect(patchWrappedErase(createTarget("alternate").target, ERASE + "prompt")).toBe(
    ERASE + "prompt",
  );
});

test("joins split erase prefixes and waits for the previous data to parse", () => {
  vi.useFakeTimers();
  const { target, issued, parseNext, parseAll } = createTarget();
  const writer = createWriter(target);

  writer.write("before\r");
  vi.advanceTimersByTime(7);
  writer.write("\x1b[2");
  vi.advanceTimersByTime(7);
  writer.write("Kprompt");

  expect(issued).toEqual(["before", "", BARRIER]);
  parseNext();
  parseNext();
  expect(issued.at(-1)).toBe(BARRIER);
  parseAll();
  expect(issued.at(-1)).toBe(ERASE + UP_ERASE.repeat(2) + "prompt");
});

test("writes a trailing possible erase prefix verbatim after eight idle milliseconds", () => {
  vi.useFakeTimers();
  const { target, issued } = createTarget();
  const writer = createWriter(target);

  writer.write("text\r\x1b[");
  vi.advanceTimersByTime(7);
  expect(issued).toEqual(["text"]);
  vi.advanceTimersByTime(1);
  expect(issued).toEqual(["text", "\r\x1b["]);
});

test.each([
  ["unit", "z".repeat(1_048_576)],
  ["part", ERASE.repeat(4_096)],
])("bypasses prompt repair beyond the %s limit in FIFO order", (_limit, overflow) => {
  const { target, issued, parsed, parseNext, parseAll } = createTarget();
  const writer = createWriter(target);
  writer.write("before" + ERASE + "redraw");
  parseNext();
  writer.write(overflow + "\r");
  writer.flush(() => parsed.push("done"));

  expect(issued).toEqual([BARRIER, "before", ERASE + "redraw" + overflow + "\r", "", BARRIER]);
  parseAll();
  expect(parsed.at(-1)).toBe("done");
});

test("supersedes queued writes and flush callbacks while keeping prior parse boundaries", () => {
  const { target, issued, parsed, parseAll } = createTarget();
  const writer = createWriter(target);
  writer.write("already submitted");
  writer.replaceOutput(
    "superseded",
    () => parsed.push("stale ready"),
    () => parsed.push("stale reset"),
  );
  writer.flush(() => parsed.push("stale flush"));
  writer.replaceOutput(
    "replacement\r",
    () => parsed.push("ready"),
    () => parsed.push("replay"),
  );
  writer.flush(() => parsed.push("first flush"));
  writer.flush(() => parsed.push("second flush"));

  expect(issued).toEqual(["already submitted", BARRIER, BARRIER]);
  parseAll();
  expect(parsed).toEqual([
    "already submitted",
    BARRIER,
    BARRIER,
    "reset",
    "replay",
    "replacement",
    "\r",
    "ready",
    BARRIER,
    "first flush",
    BARRIER,
    "second flush",
  ]);
});

test("resets behind a parse barrier even when replay exceeds the rewrite budget", () => {
  const { target, issued, parsed, parseAll } = createTarget();
  const writer = createWriter(target);
  const replay = ERASE.repeat(4_096);
  writer.write("before");
  writer.replaceOutput(
    replay,
    () => parsed.push("ready"),
    () => parsed.push("replay"),
  );
  expect(issued).toEqual(["before", BARRIER]);

  parseAll();
  expect(parsed).toEqual(["before", BARRIER, "reset", "replay", replay, "ready"]);
});
