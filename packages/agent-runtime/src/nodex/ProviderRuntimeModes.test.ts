import { describe, expect, it } from "vite-plus/test";
import { withSupportedRuntimeModes } from "./ProviderRuntimeModes.ts";
import { ProviderDriverKind } from "@t3tools/contracts";

describe("provider execution mode catalog", () => {
  it.each(["codex", "claudeAgent", "acpRegistry", "opencode"])(
    "advertises native %s choices",
    (driver) => {
      const provider = { driver: ProviderDriverKind.make(driver), instanceId: "configured-agent" };
      const result = withSupportedRuntimeModes(provider);
      expect(result.instanceId).toBe(provider.instanceId);
      expect(result.supportedRuntimeModes).toEqual(
        driver === "acpRegistry" || driver === "opencode"
          ? ["approval-required", "full-access"]
          : ["approval-required", "auto", "full-access"],
      );
    },
  );
  it("preserves an instance's narrower advertised choices", () => {
    const provider = {
      driver: ProviderDriverKind.make("claudeAgent"),
      supportedRuntimeModes: ["approval-required"] as const,
    };
    expect(withSupportedRuntimeModes(provider).supportedRuntimeModes).toEqual([
      "approval-required",
    ]);
  });
});
