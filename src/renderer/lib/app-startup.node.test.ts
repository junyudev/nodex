import { describe, expect, test } from "vite-plus/test";
import { getStartupStatus } from "./app-startup";

describe("app startup helpers", () => {
  test("keeps ordinary opening phases quiet", () => {
    expect(getStartupStatus({ phase: "opening" })).toBeNull();
    expect(getStartupStatus({ phase: "opening_workspace" })).toBeNull();
    expect(getStartupStatus({ phase: "done" })).toBeNull();
  });

  test("returns migration copy while sqlite work is running", () => {
    expect(getStartupStatus({ phase: "migrating", fromVersion: 86, toVersion: 88 })).toBe(
      "Updating local data…",
    );
  });

  test("renders real Core migration progress", () => {
    expect(
      getStartupStatus({
        phase: "migrating",
        fromVersion: 104,
        toVersion: 107,
        completed: 67,
        total: 100,
      }),
    ).toBe("Updating local data… 67%");
  });

  test("omits a percentage when the migration total is not trustworthy", () => {
    expect(
      getStartupStatus({
        phase: "migrating",
        fromVersion: 104,
        toVersion: 107,
        completed: 0,
        total: 0,
      }),
    ).toBe("Updating local data…");
  });
});
