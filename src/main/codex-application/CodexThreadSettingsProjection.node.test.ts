import { describe, expect, it } from "vite-plus/test";
import type { CodexModelOption } from "../../shared/types";
import { mergeCodexModelChange } from "./CodexThreadSettingsProjection";

const model = (serviceTiers: readonly string[]) =>
  ({
    model: "gpt",
    supportedReasoningEfforts: [],
    serviceTiers: serviceTiers.map((id) => ({ id, name: id, description: "" })),
  }) as unknown as CodexModelOption;

describe("mergeCodexModelChange", () => {
  const profile = { modelId: "gpt", reasoningEffort: null };

  it("keeps Fast on a model whose catalog names the tier priority", () => {
    expect(
      mergeCodexModelChange(
        { ...profile, serviceTier: "fast" },
        { ...profile, serviceTier: null },
        model(["priority"]),
      ).serviceTier,
    ).toBe("priority");
  });

  it.each([
    { serviceTiers: ["priority", "ultrafast"], expected: "ultrafast" },
    { serviceTiers: ["priority"], expected: "priority" },
    { serviceTiers: ["flex"], expected: null },
    { serviceTiers: [], expected: null },
  ])("fits Ultrafast to $expected across a model change", ({ serviceTiers, expected }) => {
    expect(
      mergeCodexModelChange(
        { ...profile, serviceTier: "ultrafast" },
        { ...profile, serviceTier: "ultrafast" },
        model(serviceTiers),
      ).serviceTier,
    ).toBe(expected);
  });

  it("keeps an explicit Standard", () => {
    expect(
      mergeCodexModelChange(
        { ...profile, serviceTier: null },
        { ...profile, serviceTier: "fast" },
        model(["priority"]),
      ).serviceTier,
    ).toBeNull();
  });
});
