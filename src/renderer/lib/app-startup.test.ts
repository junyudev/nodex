import { describe, expect, test } from "bun:test";
import {
  getStartupProgressValue,
  getStartupStatus,
} from "./app-startup";

describe("app startup helpers", () => {
  test("returns bootstrap copy while initialization is running", () => {
    expect(getStartupStatus({ phase: "app_waiting" }, 0)).toBe(
      "Preparing your workspace...",
    );
  });

  test("returns migration copy while sqlite work is running", () => {
    expect(getStartupStatus({ phase: "sqlite_waiting" }, 1)).toBe(
      "Migrating your local database",
    );
  });

  test("returns ready copy after initialization", () => {
    expect(getStartupStatus({ phase: "done" }, 0)).toBe("Ready");
  });

  test("uses the baseline progress while initialization is running", () => {
    expect(getStartupProgressValue({ phase: "app_waiting" }, null)).toBe(18);
  });

  test("clamps startup progress to a visible baseline during migrations", () => {
    expect(
      getStartupProgressValue(
        { phase: "sqlite_waiting" },
        { type: "InProgress", value: 3 },
      ),
    ).toBe(24);
  });

  test("returns full progress once initialization is done", () => {
    expect(getStartupProgressValue({ phase: "done" }, { type: "Done" })).toBe(100);
  });
});
