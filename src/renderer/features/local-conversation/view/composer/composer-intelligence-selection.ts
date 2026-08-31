import type { CodexServiceTier, CodexTurnStartOptions } from "@/lib/types";
import type { ThreadFooterModel } from "../../thread-stage-types";
import type { ComposerIntelligenceSelection } from "./composer-intelligence-types";

export type { ComposerIntelligenceSelection } from "./composer-intelligence-types";

export function deriveComposerIntelligenceSelection(
  model: ThreadFooterModel,
  defaultServiceTier: CodexServiceTier,
): ComposerIntelligenceSelection {
  return {
    kind: "codex",
    model: model.selectedModel,
    reasoningEffort: model.selectedReasoningEffort,
    serviceTier: model.conversation?.latestThreadSettings?.serviceTier ?? defaultServiceTier,
  };
}

export function areComposerIntelligenceSelectionsEqual(
  left: ComposerIntelligenceSelection,
  right: ComposerIntelligenceSelection,
): boolean {
  return (
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.serviceTier === right.serviceTier
  );
}

export function buildComposerIntelligenceTurnOverrides(
  selection: ComposerIntelligenceSelection,
): Pick<CodexTurnStartOptions, "model" | "reasoningEffort" | "serviceTier"> {
  return {
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    serviceTier: selection.serviceTier,
  };
}
