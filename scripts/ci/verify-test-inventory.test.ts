import { describe, expect, test } from "vite-plus/test";
import { ownedTestCandidates, verifyTestInventory } from "./verify-test-inventory";

const file = "src/main/new-application/behavior.node.test.ts";

describe("actual test inventory", () => {
  test("independently finds new packages and suffixes without suite globs", () => {
    expect(
      ownedTestCandidates([
        file,
        "packages/new-package/behavior.spec.ts",
        "src/a.ts",
        "scripts/fixtures/tooling/invalid.test.ts",
      ]),
    ).toEqual([file, "packages/new-package/behavior.spec.ts"]);
  });
  test("accepts one discovered owner", () => {
    expect(() =>
      verifyTestInventory([file], [{ suite: "core-client", tier: "default", files: [file] }]),
    ).not.toThrow();
  });
  test("rejects duplication across runtimes", () => {
    expect(() =>
      verifyTestInventory(
        [file],
        [
          { suite: "core-client", tier: "default", files: [file] },
          { suite: "main", tier: "default", files: [file] },
        ],
      ),
    ).toThrow("discovered");
  });
  test("rejects ignored owned tests and newly unowned packages", () => {
    expect(() => verifyTestInventory([file], [])).toThrow("discovered []");
    expect(() => verifyTestInventory(["packages/new-package/behavior.test.ts"], [])).toThrow(
      "0 declared owners",
    );
  });
  test("rejects discovery in the wrong tier", () => {
    expect(() =>
      verifyTestInventory([file], [{ suite: "core-client", tier: "stress", files: [file] }]),
    ).toThrow("discovered");
  });
});
