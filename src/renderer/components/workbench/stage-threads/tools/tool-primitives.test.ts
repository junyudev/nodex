import { describe, expect, test } from "bun:test";
import {
  resolveInlineToolLeadingLabel,
  shouldCollapseInlineToolOnStatusSettle,
  shouldShimmerInlineToolLeadingLabel,
  splitInlineToolLabel,
} from "./tool-primitives";

describe("splitInlineToolLabel", () => {
  test("splits labels when the leading phrase matches", () => {
    const result = splitInlineToolLabel("Explored 2 files, 1 search", "Explored");
    expect(result.leading).toBe("Explored");
    expect(result.trailing).toBe("2 files, 1 search");
  });

  test("normalizes colon separators between leading and trailing segments", () => {
    const result = splitInlineToolLabel("Ran: bun run lint", "Ran");
    expect(result.leading).toBe("Ran");
    expect(result.trailing).toBe("bun run lint");
  });

  test("does not split when the label does not start with the leading phrase", () => {
    const result = splitInlineToolLabel("docs / search", "Searched web");
    expect(result.leading).toBe("docs / search");
    expect(result.trailing).toBe(null);
  });
});

describe("shouldShimmerInlineToolLeadingLabel", () => {
  test("returns true only for in-progress labels with a non-empty leading label", () => {
    expect(shouldShimmerInlineToolLeadingLabel("inProgress", "Ran")).toBe(true);
  });

  test("returns false when status is not in-progress", () => {
    expect(shouldShimmerInlineToolLeadingLabel("completed", "Ran")).toBe(false);
  });

  test("returns false when leading label is empty", () => {
    expect(shouldShimmerInlineToolLeadingLabel("inProgress", "   ")).toBe(false);
    expect(shouldShimmerInlineToolLeadingLabel("inProgress", undefined)).toBe(false);
  });
});

describe("resolveInlineToolLeadingLabel", () => {
  test("inflects known leading labels for in-progress status", () => {
    expect(resolveInlineToolLeadingLabel("Called", "inProgress")).toBe("Calling");
    expect(resolveInlineToolLeadingLabel("Ran", "inProgress")).toBe("Running");
    expect(resolveInlineToolLeadingLabel("Ran command", "inProgress")).toBe("Running command");
    expect(resolveInlineToolLeadingLabel("explored", "inProgress")).toBe("exploring");
    expect(resolveInlineToolLeadingLabel("Searched web", "inProgress")).toBe("Searching web");
    expect(resolveInlineToolLeadingLabel("Edited", "inProgress")).toBe("Editing");
  });

  test("keeps leading label unchanged for non in-progress status", () => {
    expect(resolveInlineToolLeadingLabel("Ran", "completed")).toBe("Ran");
  });

  test("keeps unknown labels unchanged", () => {
    expect(resolveInlineToolLeadingLabel("Used tool", "inProgress")).toBe("Used tool");
  });
});

describe("shouldCollapseInlineToolOnStatusSettle", () => {
  test("returns true when an in-progress item settles", () => {
    expect(shouldCollapseInlineToolOnStatusSettle("inProgress", "completed")).toBe(true);
    expect(shouldCollapseInlineToolOnStatusSettle("inProgress", "failed")).toBe(true);
    expect(shouldCollapseInlineToolOnStatusSettle("inProgress", undefined)).toBe(true);
  });

  test("returns false when the previous status is not in-progress", () => {
    expect(shouldCollapseInlineToolOnStatusSettle("completed", "completed")).toBe(false);
    expect(shouldCollapseInlineToolOnStatusSettle(undefined, "completed")).toBe(false);
  });

  test("returns false while status remains in-progress", () => {
    expect(shouldCollapseInlineToolOnStatusSettle("inProgress", "inProgress")).toBe(false);
  });
});
