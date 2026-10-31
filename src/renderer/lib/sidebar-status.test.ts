import { describe, expect, test } from "vite-plus/test";
import {
  nativeThreadWaitsOnPerson,
  resolveSidebarGroupStatus,
  resolveSidebarRowStatus,
} from "./sidebar-status";

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
  const quiet = { needsAttention: false, unread: false, running: false };

  test.each([
    [{ ...quiet }, null],
    [{ ...quiet, running: true }, "running"],
    [{ ...quiet, unread: true, running: true }, "unread"],
    [{ ...quiet, needsAttention: true, unread: true, running: true }, "attention"],
  ] as const)("%j shows %s", (input, expected) => {
    expect(resolveSidebarGroupStatus(input)).toBe(expected);
  });
});

describe("nativeThreadWaitsOnPerson", () => {
  test.each([
    [[], false],
    [["waitingOnApproval"], true],
    [["waitingOnUserInput"], true],
  ] as const)("%j waits: %s", (flags, expected) => {
    expect(nativeThreadWaitsOnPerson(flags)).toBe(expected);
  });
});
