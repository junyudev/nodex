import { describe, expect, test } from "vite-plus/test";

import { classifyChangedPaths } from "./classify-change";
import { requiredGateNames, verifyRequiredGates } from "./verify-required-gates";

describe("required CI gate verification", () => {
  test("accepts successful selected gates and ignores unselected skipped jobs", () => {
    expect(() =>
      verifyRequiredGates({
        classifierResult: "success",
        results: {
          "app-tests": "success",
          "rust-checks": "skipped",
          "windows-checks": "skipped",
        },
        selectedGates: ["app-tests"],
      }),
    ).not.toThrow();
  });

  test.each(["failure", "cancelled", "skipped"] as const)(
    "rejects a selected Windows gate with %s result",
    (result) => {
      expect(() =>
        verifyRequiredGates({
          classifierResult: "success",
          results: { "static-contracts": "success", "windows-checks": result },
          selectedGates: requiredGateNames(
            [],
            classifyChangedPaths([".github/workflows/windows.yml"]),
          ),
        }),
      ).toThrow(`windows-checks finished with ${result}`);
    },
  );

  test.each(["failure", "cancelled", "skipped"] as const)(
    "rejects a classifier with %s result even when no other gates are selected",
    (classifierResult) => {
      expect(() =>
        verifyRequiredGates({ classifierResult, results: {}, selectedGates: [] }),
      ).toThrow(`classify finished with ${classifierResult}`);
    },
  );

  test("rejects a missing result for a selected gate", () => {
    expect(() =>
      verifyRequiredGates({
        classifierResult: "success",
        results: {},
        selectedGates: ["rust-checks"],
      }),
    ).toThrow("rust-checks has no GitHub job result");
  });

  test("rejects duplicate and empty selected gate names", () => {
    expect(() =>
      verifyRequiredGates({
        classifierResult: "success",
        results: { "app-tests": "success" },
        selectedGates: ["app-tests", "app-tests"],
      }),
    ).toThrow("must not contain duplicates");
    expect(() =>
      verifyRequiredGates({
        classifierResult: "success",
        results: { " ": "success" },
        selectedGates: [" "],
      }),
    ).toThrow("must not be empty");
  });

  test("derives pre-merge gates from the validated plan and unconditional gates from needs", () => {
    expect(
      requiredGateNames(["stale-or-unselected"], classifyChangedPaths(["src/renderer/app.tsx"])),
    ).toEqual(["static-contracts", "app-tests"]);
    expect(requiredGateNames([], classifyChangedPaths(["crates/nodex-core/src/lib.rs"]))).toContain(
      "rust-checks",
    );
    expect(requiredGateNames(["static-contracts", "rust-workspace"], undefined)).toEqual([
      "static-contracts",
      "rust-workspace",
    ]);
  });
});
