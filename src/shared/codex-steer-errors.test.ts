import { expect, test } from "vitest";
import { normalizeSteerTurnError, parseSteerTurnMismatchActualTurnId } from "./codex-steer-errors";

test.each([
  ["expected active turn id old but found new", "new"],
  ["expected active turn id `old` but found `new`", "new"],
  ['ExpectedTurnMismatch { expected: "old", actual: "new" }', "new"],
  ["expected active turn id 'old' but found 'new'", "'new'"],
  ["Expected active turn id old but found new", null],
  ["expected active turn id old but found", null],
  ["no active turn to steer", null],
])("decodes the native steering mismatch %s", (message, expected) => {
  const native = new Error(message);
  expect(parseSteerTurnMismatchActualTurnId(native)).toBe(expected);
  expect(
    parseSteerTurnMismatchActualTurnId(new Error("Peer action failed", { cause: native })),
  ).toBe(expected);
});

test("normalizes an ended native Turn while preserving other error identities", () => {
  const native = new Error("no active turn to steer");
  expect(
    normalizeSteerTurnError(new Error("Request failed", { cause: native }), "thread-a"),
  ).toMatchObject({
    name: "SteerTurnInactiveError",
    message: "Cannot steer conversation thread-a because its active turn already ended",
  });
  const denied = new Error("steering denied");
  expect(normalizeSteerTurnError(denied, "thread-a")).toBe(denied);
});
