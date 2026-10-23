import { describe, expect, test } from "vite-plus/test";
import { resolveSidebarGroupStatus, resolveSidebarRowStatus } from "./sidebar-status";

describe("resolveSidebarRowStatus", () => {
  const idle = { unread: false, running: false, background: false, needsAttention: false };

  test.each([
    [{ ...idle }, null],
    [{ ...idle, unread: true }, "unread"],
    [{ ...idle, unread: true, running: true }, "running"],
    [{ ...idle, unread: true, background: true }, "background"],
    [{ ...idle, running: true, background: true }, "running"],
    [{ ...idle, running: true, needsAttention: true }, "attention"],
    [{ ...idle, unread: true, needsAttention: true }, "attention"],
  ] as const)("%j shows %s", (input, expected) => {
    expect(resolveSidebarRowStatus(input)).toBe(expected);
  });
});

describe("resolveSidebarGroupStatus", () => {
  test.each([
    [{ needsReading: false, running: false }, null],
    [{ needsReading: false, running: true }, "running"],
    [{ needsReading: true, running: false }, "unread"],
    [{ needsReading: true, running: true }, "unread"],
  ] as const)("%j shows %s", (input, expected) => {
    expect(resolveSidebarGroupStatus(input)).toBe(expected);
  });
});
