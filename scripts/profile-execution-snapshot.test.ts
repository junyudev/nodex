import { expect, test } from "vite-plus/test";
import { parseProfileExecutionSnapshot } from "./profile-execution-snapshot";

const receipt = {
  capturedAt: "2026-09-22T00:00:00Z",
  databaseBytes: 4096,
  attachmentFiles: 2,
  attachmentBytes: 1024,
};

test("accepts capture evidence and an absent source execution store", () => {
  expect(parseProfileExecutionSnapshot(receipt)).toEqual(receipt);
  expect(parseProfileExecutionSnapshot(null)).toBeNull();
});

test("rejects missing or invalid execution capture evidence", () => {
  for (const invalid of [
    undefined,
    {},
    [],
    { ...receipt, capturedAt: "yesterday" },
    { ...receipt, databaseBytes: -1 },
    { ...receipt, attachmentFiles: 1.5 },
    { ...receipt, attachmentBytes: Number.POSITIVE_INFINITY },
  ])
    expect(() => parseProfileExecutionSnapshot(invalid)).toThrow("invalid or unsupported");
});
