import type { AgentSessionConfigSelectOption } from "./agent-conversation";

export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];
export type ClaudeEffortSelection = ClaudeEffortLevel | "default";
export const isClaudeEffortLevel = (value: unknown): value is ClaudeEffortLevel =>
  CLAUDE_EFFORT_LEVELS.some((level) => level === value);

export interface ClaudeModelCatalogInput {
  readonly instanceConfigId: string;
  readonly projectId: string;
}

export const CLAUDE_DEFAULT_MODEL: AgentSessionConfigSelectOption = {
  value: "default",
  name: "Claude default",
  description: "Use the model configured in Claude Code",
};

/** Versioned Claude IDs have a readable label; gateway IDs remain opaque. */
export function claudeModelName(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[.*\])?$/u.exec(id);
  if (!match) return id;
  const [, family, major, minor, suffix] = match;
  return `Claude ${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ""}${suffix ? ` ${suffix}` : ""}`;
}
