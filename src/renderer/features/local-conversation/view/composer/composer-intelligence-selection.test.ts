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
