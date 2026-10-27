import { describe, expect, it } from "vitest";
import { parseCoreError, parseCoreFailureEvidence } from "./core-failure-evidence";

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

describe("Core error payloads", () => {
  const payload = {
    code: "invalid_input",
    message: "Invalid project identity",
    retryable: false,
    recovery: { kind: "none" },
  } as const;

  it("preserves the generated error contract", () => {
    expect(parseCoreError(payload)).toEqual(payload);
  });

  it.each([
    null,
    { ...payload, code: "unknown" },
    { ...payload, message: 1 },
    { ...payload, retryable: "false" },
    { ...payload, recovery: { kind: "unknown" } },
    {
      ...payload,
      recovery: {
        kind: "recovery_package",
        failure: { reason: "invalid_json", effect: "unknown", limit: -1 },
      },
    },
  ])("rejects invalid error evidence: %j", (value) => {
    expect(() => parseCoreError(value)).toThrow(TypeError);
  });
});
