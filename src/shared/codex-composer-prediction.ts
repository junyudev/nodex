import type { ReasoningEffort } from "@nodex/codex-app-server-protocol";

export interface CodexComposerPredictionInput {
  readonly hostId: string;
  readonly threadId: string;
  readonly latestTurnId: string | null;
  readonly generationTrigger: "live" | "catch-up";
}
/** Ephemeral inference output; it never replaces accepted composer or conversation content. */
export interface CodexComposerPredictionResult {
  readonly requestedAt: string;
  readonly text: string | null;
  readonly predictionThreadId: string;
  readonly predictionTurnId: string;
  readonly sourceTurnId: string | null;
  readonly generationTrigger: CodexComposerPredictionInput["generationTrigger"];
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort | null;
  readonly serviceTier: string | null;
  readonly parentReasoningEffort: ReasoningEffort | null;
  readonly configuredReasoningEffort: ReasoningEffort | null;
  readonly promptVersion: string;
  readonly totalDurationMs: number;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
}

export type CodexComposerPredictionClearInput =
  | { readonly hostId?: undefined; readonly threadId?: undefined }
  | { readonly hostId: string; readonly threadId?: string };

export interface CodexComposerPredictionAvailability {
  readonly enabled: boolean;
  readonly source: "environment" | null;
  readonly scope: string;
}
