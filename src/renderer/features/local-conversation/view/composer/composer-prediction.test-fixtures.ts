import type { CodexComposerPredictionResult } from "../../../../../shared/codex-composer-prediction";

export function predictionResult(
  sourceTurnId = "source-turn",
  text = "Inspect the tests next",
): CodexComposerPredictionResult {
  return {
    requestedAt: "2026-10-12T00:00:00Z",
    text,
    predictionThreadId: `prediction-${sourceTurnId}`,
    predictionTurnId: "prediction-turn",
    sourceTurnId,
    generationTrigger: "catch-up",
    model: "gpt-5.6-sol",
    reasoningEffort: null,
    serviceTier: null,
    parentReasoningEffort: null,
    configuredReasoningEffort: null,
    promptVersion: "1",
    totalDurationMs: 20,
    inputTokens: null,
    cachedInputTokens: null,
  };
}
