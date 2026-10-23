import { describe, expect, test } from "vite-plus/test";
import type { ThreadFooterModel } from "../../thread-stage-types";
import {
  areComposerIntelligenceSelectionsEqual,
  buildComposerIntelligenceTurnOverrides,
  deriveComposerIntelligenceSelection,
  type ComposerIntelligenceSelection,
} from "./composer-intelligence-selection";

const CODEX_SELECTION: ComposerIntelligenceSelection = {
  kind: "codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
  serviceTier: "fast",
};

describe("composer intelligence selection", () => {
  test("preserves Claude effort without inheriting a Codex service tier", () => {
    expect(
      deriveComposerIntelligenceSelection(
        {
          provider: { kind: "claude" },
          selectedModel: "claude-sonnet-5",
          selectedReasoningEffort: "max",
        } as ThreadFooterModel,
        "fast",
      ),
    ).toEqual({
      kind: "claude",
      model: "claude-sonnet-5",
      reasoningEffort: "max",
      serviceTier: null,
    });
  });
  test("derives active-thread speed ahead of the renderer default", () => {
    const selection = deriveComposerIntelligenceSelection(
      {
        selectedModel: "gpt-5.6-sol",
        selectedReasoningEffort: "xhigh",
        conversation: {
          latestThreadSettings: { serviceTier: "fast" },
        },
      } as ThreadFooterModel,
      null,
    );

    expect(selection).toEqual(CODEX_SELECTION);
  });

  test.each([null, "fast"])(
    "retains an explicit Standard thread when the saved default is %s",
    (defaultServiceTier) => {
      const selection = deriveComposerIntelligenceSelection(
        {
          selectedModel: "gpt-6-sol",
          selectedReasoningEffort: "high",
          conversation: { latestThreadSettings: { serviceTier: null } },
        } as ThreadFooterModel,
        defaultServiceTier,
      );

      expect(selection.serviceTier).toBeNull();
      expect(buildComposerIntelligenceTurnOverrides(selection).serviceTier).toBeNull();
    },
  );

  test("uses the saved tier only before the conversation has its own tier", () => {
    expect(
      deriveComposerIntelligenceSelection(
        {
          selectedModel: "gpt-6-sol",
          selectedReasoningEffort: "high",
          conversation: { latestThreadSettings: {} },
        } as ThreadFooterModel,
        "fast",
      ).serviceTier,
    ).toBe("fast");
  });

  test.each([null, "fast"])(
    "restores the saved thread tier %s before live settings arrive",
    (serviceTier) => {
      const model = {
        selectedModel: "gpt-6-sol",
        selectedReasoningEffort: "high",
        executionProfile: { modelId: "gpt-6-sol", reasoningEffort: "high", serviceTier },
        conversation: { latestThreadSettings: null },
      } as ThreadFooterModel;

      expect(
        deriveComposerIntelligenceSelection(model, serviceTier === null ? "fast" : null)
          .serviceTier,
      ).toBe(serviceTier);
    },
  );

  test("builds exact native Codex turn overrides", () => {
    expect(buildComposerIntelligenceTurnOverrides(CODEX_SELECTION)).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
    });
  });

  test("compares semantic values instead of object identity", () => {
    expect(
      areComposerIntelligenceSelectionsEqual(CODEX_SELECTION, {
        ...CODEX_SELECTION,
      }),
    ).toBe(true);
    expect(
      areComposerIntelligenceSelectionsEqual(CODEX_SELECTION, {
        ...CODEX_SELECTION,
        serviceTier: null,
      }),
    ).toBe(false);
  });
});
