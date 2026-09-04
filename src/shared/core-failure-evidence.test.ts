import { describe, expect, it } from "vitest";
import { parseCoreFailureEvidence } from "./core-failure-evidence";

describe("View order preparation evidence", () => {
  it("preserves the exact View to prepare and rejects missing identities", () => {
    expect(
      parseCoreFailureEvidence({
        code: "maintenance_in_progress",
        recovery: { kind: "database_view_order_preparation", view_id: "view:one" },
      }),
    ).toEqual({
      code: "maintenance_in_progress",
      recovery: { kind: "database_view_order_preparation", view_id: "view:one" },
    });
    for (const viewId of [undefined, null, 1, ""]) {
      expect(() =>
        parseCoreFailureEvidence({
          code: "maintenance_in_progress",
          recovery: { kind: "database_view_order_preparation", view_id: viewId },
        }),
      ).toThrow(TypeError);
    }
  });
});
