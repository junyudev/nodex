import { describe, expect, test } from "vite-plus/test";
import {
  isAgentRuntimeModeSupported,
  requiresFullAccessConfirmation,
  resolveAgentRuntimeMode,
} from "./agent-runtime-mode";

describe("permission modes", () => {
  test("treats a missing or empty list as every mode", () => {
    expect(isAgentRuntimeModeSupported("auto", undefined)).toBe(true);
    expect(isAgentRuntimeModeSupported("auto", [])).toBe(true);
    expect(isAgentRuntimeModeSupported("auto", ["approval-required", "full-access"])).toBe(false);
    expect(resolveAgentRuntimeMode("auto")).toBe("auto");
    expect(resolveAgentRuntimeMode("full-access", [])).toBe("full-access");
  });

  test("resolves to the broadest supported mode at or below the selected mode", () => {
    const supported = ["approval-required", "full-access"] as const;
    expect(resolveAgentRuntimeMode("auto", supported)).toBe("approval-required");
    expect(resolveAgentRuntimeMode("full-access", supported)).toBe("full-access");
    expect(resolveAgentRuntimeMode("full-access", ["approval-required", "auto"])).toBe("auto");
    expect(resolveAgentRuntimeMode("approval-required", ["full-access"])).toBe("approval-required");
  });

  test("confirms only a step up to Full access", () => {
    expect(requiresFullAccessConfirmation("approval-required", "full-access")).toBe(true);
    expect(requiresFullAccessConfirmation("full-access", "full-access")).toBe(false);
    expect(requiresFullAccessConfirmation("full-access", "auto")).toBe(false);
  });
});
