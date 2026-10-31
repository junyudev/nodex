import { describe, expect, test } from "vite-plus/test";
import { resolveOccurrenceMutationStatus } from "./calendar-occurrence-status";

describe("calendar occurrence status resolution", () => {
  test("keeps canonical statuses unchanged", () => {
    expect(resolveOccurrenceMutationStatus("plan", { status: "plan" })).toBe("plan");
  });

  test("maps archived display ids back to the canonical done status", () => {
    expect(resolveOccurrenceMutationStatus("archived", { status: "done" })).toBe("done");
  });
});
