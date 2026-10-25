import { describe, expect, it } from "vitest";
import {
  isWorkspaceTextSearchQueryValid,
  parseWorkspaceTextSearchFileMask,
} from "./workspace-text-search";
import { WorkspaceTextSearchStartSchema } from "./schemas/workspace-text-search";

describe("workspace text search input", () => {
  it("accepts literal single-line queries and bounds input before starting a process", () => {
    expect(isWorkspaceTextSearchQueryValid(" [literal].* ")).toBe(true);
    expect(isWorkspaceTextSearchQueryValid("x".repeat(256))).toBe(true);
    for (const query of ["", " ", "x".repeat(257), "one\ntwo", "one\rtwo", "one\0two"])
      expect(isWorkspaceTextSearchQueryValid(query)).toBe(false);
  });
  it("splits only top-level mask commas and orders inclusive masks ahead of exclusions", () => {
    expect(
      parseWorkspaceTextSearchFileMask("!dist/**,*.{ts,tsx},[a,b]*,name\\,part, , !vendor/**"),
    ).toEqual({
      include: ["*.{ts,tsx}", "[a,b]*", "name\\,part"],
      exclude: ["!dist/**", "!vendor/**"],
    });
    expect(parseWorkspaceTextSearchFileMask(" ")).toEqual({ include: [], exclude: [] });
    for (const mask of [
      "*.{ts,tsx",
      "*.ts}",
      "[ab",
      "*.ts]",
      "trailing\\",
      "x".repeat(257),
      "a\nb",
      "a\0b",
    ])
      expect(parseWorkspaceTextSearchFileMask(mask)).toBeNull();
  });
  it("accepts local and connected absolute roots but rejects unbounded and relative ingress", () => {
    const valid = {
      requestId: "f3ebc134-7b2b-4c8d-8758-01e7b2a87065",
      hostId: "ssh:work",
      roots: ["/work"],
      query: "needle",
    };
    expect(WorkspaceTextSearchStartSchema.safeParse(valid).success).toBe(true);
    for (const patch of [
      { roots: ["relative"] },
      { roots: [] },
      { roots: Array(33).fill("/work") },
      { fileMask: "x".repeat(257) },
      { priorityFolders: Array(21).fill("/work/src") },
    ])
      expect(WorkspaceTextSearchStartSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
