import type { CodexReasoningEffort, CodexServiceTier } from "@/lib/types";
/** The complete next-turn intelligence choice shown by a composer selector. */
export interface ComposerIntelligenceSelection {
  readonly kind: "codex" | "claude" | "acp";
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly serviceTier: CodexServiceTier;
}
