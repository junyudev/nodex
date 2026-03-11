import { describe, expect, test } from "bun:test";
import { resolveOccurrenceMutationStatus } from "./calendar-occurrence-status";

describe("calendar occurrence status resolution", () => {
  test("keeps canonical statuses unchanged", () => {
    expect(resolveOccurrenceMutationStatus("backlog", { status: "backlog" })).toBe("backlog");
  });

  test("maps archived display ids back to the canonical done status", () => {
    expect(resolveOccurrenceMutationStatus("archived", { status: "done" })).toBe("done");
  });
});
