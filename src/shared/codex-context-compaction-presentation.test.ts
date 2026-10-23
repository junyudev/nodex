import { describe, expect, test } from "vite-plus/test";
import {
  formatCodexContextCompactionLabel,
  resolveCodexContextCompactionStatus,
} from "./codex-context-compaction-presentation";

describe("resolveCodexContextCompactionStatus", () => {
  test.each([
    { completed: false, turnStatus: "inProgress", expected: "inProgress" },
    { completed: false, turnStatus: "interrupted", expected: "interrupted" },
    { completed: false, turnStatus: "failed", expected: "interrupted" },
    { completed: false, turnStatus: "completed", expected: "completed" },
    { completed: true, turnStatus: "inProgress", expected: "completed" },
    { completed: true, turnStatus: "interrupted", expected: "completed" },
    { completed: undefined, turnStatus: "inProgress", expected: "completed" },
  ] as const)(
    "completed=$completed in a $turnStatus Turn is $expected",
    ({ completed, turnStatus, expected }) => {
      expect(resolveCodexContextCompactionStatus({ completed, turnStatus })).toBe(expected);
    },
  );
});

describe("formatCodexContextCompactionLabel", () => {
  test.each([
    [{ status: "inProgress", source: "automatic" }, "Compacting context"],
    [{ status: "inProgress", source: "manual" }, "Compacting context"],
    [
      { status: "inProgress", source: "automatic", showDelayNotice: true },
      "Compacting context · This can take a few minutes",
    ],
    [{ status: "interrupted", source: "automatic" }, "Compaction interrupted"],
    [{ status: "completed", source: "automatic" }, "Context automatically compacted"],
    [{ status: "completed", source: "manual" }, "Context compacted"],
    [
      { status: "inProgress", source: "automatic", proseSteps: true },
      "Optimizing the conversation",
    ],
    [
      { status: "inProgress", source: "automatic", proseSteps: true, showDelayNotice: true },
      "Optimizing the conversation · This can take a few minutes",
    ],
    [{ status: "interrupted", source: "manual", proseSteps: true }, "Optimization interrupted"],
    [{ status: "completed", source: "automatic", proseSteps: true }, "Optimized the conversation"],
    [{ status: "completed", source: "manual", proseSteps: true }, "Context compacted"],
  ] as const)("%j reads %s", (input, expected) => {
    expect(formatCodexContextCompactionLabel(input)).toBe(expected);
  });
});
