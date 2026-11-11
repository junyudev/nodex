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
        },
        selectedGates: ["app-tests"],
      }),
    ).not.toThrow();
  });

  test.each(["failure", "cancelled", "skipped"] as const)(
    "rejects a selected gate with %s result",
    (result) => {
      expect(() =>
        verifyRequiredGates({
          classifierResult: "success",
          results: { "app-tests": result },
          selectedGates: ["app-tests"],
        }),
      ).toThrow(`app-tests finished with ${result}`);
    },
  );

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

  test("derives PR gates only from the validated plan and Main gates from needs", () => {
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
