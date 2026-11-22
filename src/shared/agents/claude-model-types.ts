export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

export interface ClaudeModelTraits {
  readonly effortLevels?: ClaudeEffortLevel[] | undefined;
  readonly fastMode?: boolean | undefined;
  readonly adaptiveThinking?: boolean | undefined;
  readonly disableThinking?: boolean | undefined;
  readonly disabledThinkingEfforts?: ClaudeEffortLevel[] | undefined;
  readonly contextWindows?: string[] | undefined;
}

export interface ClaudeCustomModel {
  readonly id: string;
  readonly displayName: string;
  readonly traits: ClaudeModelTraits;
}
