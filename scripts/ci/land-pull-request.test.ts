import { describe, expect, it } from "vite-plus/test";

import { assessChecks } from "./land-pull-request.ts";

describe("assessChecks", () => {
  it("lands only once the aggregate gate passes, and stops at any failure first", () => {
    const passed = { name: "required", bucket: "pass" };
    const review = { name: "CodeRabbit", bucket: "pending" };

    expect(assessChecks([])).toEqual({ kind: "pending" });
    expect(assessChecks([{ name: "rust tests", bucket: "pass" }])).toEqual({ kind: "pending" });
    expect(assessChecks([{ name: "required", bucket: "pending" }])).toEqual({ kind: "pending" });
    // Advisory checks still running do not hold a pull request whose gate passed.
    expect(assessChecks([passed, review])).toEqual({ kind: "ready" });

    const failed = { name: "app tests / app core-client-2+main", bucket: "fail" };
    const cancelled = { name: "windows checks / native x64", bucket: "cancel" };
    expect(assessChecks([passed, failed, cancelled])).toEqual({
      kind: "failed",
      failures: [failed, cancelled],
    });
  });
});
