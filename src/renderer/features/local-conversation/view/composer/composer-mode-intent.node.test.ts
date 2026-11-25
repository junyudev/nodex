import { describe, expect, test, it } from "vite-plus/test";
import type { ThreadFooterModel } from "../../thread-stage-types";
import {
  areComposerIntelligenceSelectionsEqual,
  buildComposerIntelligenceTurnOverrides,
  deriveComposerIntelligenceSelection,
  type ComposerIntelligenceSelection,
} from "./composer-intelligence-selection";
import {
  hasDefaultMode,
  hasPlanMode,
  isPlanMode,
  resolveNextComposerPlanMode,
  shouldShowComposerPlanKeywordSuggestion,
} from "./composer-plan-mode";
import { CLAUDE_PROMPT_KEYWORDS, findComposerPromptKeywords } from "./composer-prompt-keywords";
import { buildComposerThreadGoalDraft } from "./composer-thread-goal-draft";
import {
  isInterruptedTurnResumeEligible,
  createInterruptedTurnResumeGate,
} from "./interrupted-turn-resume-controller";

describe("composer intelligence selection", () => {
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
});

describe("composer plan mode", () => {
  const modes = [{ mode: "default" }, { mode: "plan" }];

  describe("composer plan mode helpers", () => {
    test("detects available plan and default modes", () => {
      expect(hasPlanMode(modes)).toBe(true);
      expect(hasDefaultMode(modes)).toBe(true);
      expect(isPlanMode("plan")).toBe(true);
      expect(isPlanMode("default")).toBe(false);
    });

    test("toggles between default and plan mode", () => {
      expect(resolveNextComposerPlanMode({ currentMode: "default", modes })).toBe("plan");
      expect(resolveNextComposerPlanMode({ currentMode: "plan", modes })).toBe("default");
      expect(
        resolveNextComposerPlanMode({ currentMode: "default", modes: [{ mode: "default" }] }),
      ).toBe(null);
    });

    test("shows keyword suggestion only for plan drafts that are not already dismissed or active", () => {
      expect(
        shouldShowComposerPlanKeywordSuggestion({
          prompt: "please plan this migration",
          currentMode: "default",
          modes,
          dismissed: false,
        }),
      ).toBe(true);
      expect(
        shouldShowComposerPlanKeywordSuggestion({
          prompt: "please plan this migration",
          currentMode: "plan",
          modes,
          dismissed: false,
        }),
      ).toBe(false);
      expect(
        shouldShowComposerPlanKeywordSuggestion({
          prompt: "please plan this migration",
          currentMode: "default",
          modes,
          dismissed: true,
        }),
      ).toBe(false);
      expect(
        shouldShowComposerPlanKeywordSuggestion({
          prompt: "please explain this migration",
          currentMode: "default",
          modes,
          dismissed: false,
        }),
      ).toBe(false);
    });
  });
});

describe("composer prompt keywords", () => {
  const words = (text: string) =>
    findComposerPromptKeywords(text, CLAUDE_PROMPT_KEYWORDS).map(({ from, to, keyword }) => [
      text.slice(from, to),
      keyword.word,
    ]);

  describe("findComposerPromptKeywords", () => {
    it("finds Claude Code's keywords as whole words in any case", () => {
      expect(words("Ultrathink about this, then ULTRACODE it.")).toEqual([
        ["Ultrathink", "ultrathink"],
        ["ULTRACODE", "ultracode"],
      ]);
    });

    it("ignores the words inside longer words", () => {
      expect(words("ultrathinking ultracoded preultrathink")).toEqual([]);
    });

    it("finds nothing for an Agent without keywords", () => {
      expect(findComposerPromptKeywords("ultrathink", [])).toEqual([]);
    });
  });
});

describe("buildComposerThreadGoalDraft", () => {
  test("returns not-goal when goal actions are unavailable", () => {
    const result = buildComposerThreadGoalDraft({
      promptRaw: "/goal keep working",
      goalActionAvailable: false,
      goalModeActive: true,
      hasAttachments: false,
    });

    expect(result.status).toBe("not-goal");
  });

  test("parses canonical and repeated-o goal slash commands", () => {
    const canonical = buildComposerThreadGoalDraft({
      promptRaw: "  /goal keep working",
      goalActionAvailable: true,
      goalModeActive: false,
      hasAttachments: false,
    });
    const repeated = buildComposerThreadGoalDraft({
      promptRaw: "/gooal keep going",
      goalActionAvailable: true,
      goalModeActive: false,
      hasAttachments: false,
    });

    expect(canonical.status).toBe("ready");
    expect(canonical.status === "ready" ? canonical.draft.objective : "").toBe("keep working");
    expect(repeated.status).toBe("ready");
    expect(repeated.status === "ready" ? repeated.draft.objective : "").toBe("keep going");
  });

  test("does not parse goal text outside the leading slash command", () => {
    const result = buildComposerThreadGoalDraft({
      promptRaw: "please /goal keep working",
      goalActionAvailable: true,
      goalModeActive: false,
      hasAttachments: false,
    });

    expect(result.status).toBe("not-goal");
  });

  test("uses the whole prompt while goal mode is active", () => {
    const result = buildComposerThreadGoalDraft({
      promptRaw: "keep working",
      goalActionAvailable: true,
      goalModeActive: true,
      hasAttachments: false,
    });

    expect(result.status).toBe("ready");
    expect(result.status === "ready" ? result.draft.objective : "").toBe("keep working");
  });

  test("strips plugin and app markdown links to labels", () => {
    const result = buildComposerThreadGoalDraft({
      promptRaw: "/goal use [Browser](app://browser) and [Plug\\]in](plugin://abc)",
      goalActionAvailable: true,
      goalModeActive: false,
      hasAttachments: false,
    });

    expect(result.status).toBe("ready");
    expect(result.status === "ready" ? result.draft.objective : "").toBe("use Browser and Plug]in");
  });

  test("returns empty only when objective and attachments are both empty", () => {
    const empty = buildComposerThreadGoalDraft({
      promptRaw: "/goal",
      goalActionAvailable: true,
      goalModeActive: false,
      hasAttachments: false,
    });
    const attachmentOnly = buildComposerThreadGoalDraft({
      promptRaw: "/goal",
      goalActionAvailable: true,
      goalModeActive: false,
      hasAttachments: true,
    });

    expect(empty.status).toBe("empty");
    expect(attachmentOnly.status).toBe("ready");
    expect(attachmentOnly.status === "ready" ? attachmentOnly.draft.hasAttachments : false).toBe(
      true,
    );
  });
});

describe("interrupted turn resume controller", () => {
  function buildModel(overrides: Partial<ThreadFooterModel> = {}): ThreadFooterModel {
    return {
      threadId: "thread_1",
      projectId: "project_1",
      conversation: {
        threadId: "thread_1",
        projectId: "project_1",
        statusType: "idle",
        statusActiveFlags: [],
        turns: [{ turnId: "turn_1", status: "interrupted", items: [] }],
        threadGoal: null,
      },
      activeTurn: null,
      isThreadRunning: false,
      isNewThreadTab: false,
      resumeState: "resumed",
      ...overrides,
    } as ThreadFooterModel;
  }

  describe("interrupted turn resume controller", () => {
    test("allows only an idle interrupted conversation without an active goal", () => {
      expect(
        isInterruptedTurnResumeEligible({
          model: buildModel(),
          hasResumeAction: true,
        }),
      ).toBe(true);
      expect(
        isInterruptedTurnResumeEligible({
          model: buildModel({ isThreadRunning: true }),
          hasResumeAction: true,
        }),
      ).toBe(false);
      expect(
        isInterruptedTurnResumeEligible({
          model: buildModel({ conversation: null }),
          hasResumeAction: true,
        }),
      ).toBe(false);
      expect(
        isInterruptedTurnResumeEligible({
          model: buildModel(),
          hasResumeAction: false,
        }),
      ).toBe(false);
    });

    test("admits one attempt until its release completes", () => {
      const gate = createInterruptedTurnResumeGate();
      const release = gate.tryAcquire(true);

      expect(release).not.toBeNull();
      expect(gate.tryAcquire(true)).toBeNull();
      release?.();
      release?.();
      expect(gate.tryAcquire(true)).not.toBeNull();
    });
  });
});
