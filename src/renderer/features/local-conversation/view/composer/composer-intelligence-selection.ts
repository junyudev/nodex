import type { CodexServiceTier, CodexTurnStartOptions } from "@/lib/types";
import type { ThreadFooterModel } from "../../thread-stage-types";
import type { ComposerIntelligenceSelection } from "./composer-intelligence-types";

export type { ComposerIntelligenceSelection } from "./composer-intelligence-types";

export function deriveComposerIntelligenceSelection(
  model: ThreadFooterModel,
  defaultServiceTier: CodexServiceTier,
): ComposerIntelligenceSelection {
  const kind = model.provider?.kind ?? "codex";
  // Only undefined inherits; null explicitly selects Standard.
  const serviceTier =
    [
      model.provider?.serviceTier,
      model.conversation?.latestThreadSettings?.serviceTier,
      model.executionProfile?.serviceTier,
      defaultServiceTier,
    ].find((tier) => tier !== undefined) ?? null;
  return {
    kind,
    model: model.selectedModel,
    reasoningEffort: model.provider?.kind === "acp" ? "none" : model.selectedReasoningEffort,
    serviceTier: kind === "codex" ? serviceTier : null,
  };
}

export function areComposerIntelligenceSelectionsEqual(
  left: ComposerIntelligenceSelection,
  right: ComposerIntelligenceSelection,
): boolean {
  return (
    left.kind === right.kind &&
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
