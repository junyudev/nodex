import { describe, expect, test } from "vite-plus/test";

import { verifyCommandSteps, verifyStaticCheckSteps } from "./verify-vite-plus-workflow-contracts";

describe("Vite+ CI command ownership", () => {
  test("accepts direct vp commands after the shared setup action", () => {
    expect(
      verifyCommandSteps(
        "workflow.job",
        [
          { uses: "./.github/actions/setup-vite-plus" },
          { run: "vp install --frozen-lockfile" },
          { run: "vp run test" },
        ],
        true,
      ),
    ).toBe(2);
  });

  test("rejects package-manager indirection", () => {
    expect(() =>
      verifyCommandSteps(
        "workflow.job",
        [{ uses: "./.github/actions/setup-vite-plus" }, { run: "pnpm exec vp run test" }],
        true,
      ),
    ).toThrow(/invokes pnpm directly/u);
  });

  test("rejects vp commands before setup", () => {
    expect(() => verifyCommandSteps("workflow.job", [{ run: "vp run test" }], true)).toThrow(
      /invokes vp before/u,
    );
  });

  test("requires the reusable static matrix to own the integrated check", () => {
    expect(() =>
      verifyStaticCheckSteps("workflow.static-contracts", [
        {
          run: [
            "vp exec tsx scripts/ci/run-timed.ts -- vp run check",
            "vp exec tsx scripts/ci/verify-static.ts --group types",
          ].join("\n"),
        },
      ]),
    ).not.toThrow();

    expect(() =>
      verifyStaticCheckSteps("workflow.static-contracts", [
        { run: "vp exec tsx scripts/ci/verify-static.ts --group types" },
      ]),
    ).toThrow(/canonical vp run check task/u);

    expect(() =>
      verifyStaticCheckSteps("workflow.static-contracts", [
        { run: "vp exec tsx scripts/ci/verify-static.ts --group types" },
        { run: "vp run check" },
      ]),
    ).toThrow(/before grouped static contracts/u);
  });
});
