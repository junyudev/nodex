import type { AgentSessionConfigSelectOption } from "./agent-conversation";

export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];
export type ClaudeEffortSelection = ClaudeEffortLevel | "default";
export const isClaudeEffortLevel = (value: unknown): value is ClaudeEffortLevel =>
  CLAUDE_EFFORT_LEVELS.some((level) => level === value);

/** User intent is durable; native routing and policy limits only change the observed selection. */
export interface ClaudeModelSelection {
  readonly model: string;
  readonly effort: ClaudeEffortSelection;
  readonly fast?: boolean;
  readonly thinking?: boolean;
  readonly context?: string;
}
/** Resolved native control state; null means the CLI has not reported a value. */
export interface ClaudeResolvedIntelligence {
  readonly model: string | null;
  readonly effort: ClaudeEffortLevel | null;
  readonly fast: boolean | null;
  readonly thinking: boolean | null;
}

/** Native context is a decoration of a concrete model identity, never of `default`. */
export const claudeModelContext = (model: string | null | undefined): string | undefined =>
  /\[(\d+[km])\]$/iu.exec(model ?? "")?.[1]?.toLowerCase();

export const claudeModelWithContext = (model: string, context?: string): string =>
  context ? `${model.replace(/\[(?:\d+[km])\]$/iu, "")}[${context}]` : model;
export interface ClaudeModelTraits {
  readonly effortLevels?: ClaudeEffortLevel[];
  readonly fastMode?: boolean;
  readonly adaptiveThinking?: boolean;
  readonly disableThinking?: boolean;
  readonly disabledThinkingEfforts?: ClaudeEffortLevel[];
  readonly contextWindows?: string[];
}

// Exact canonical identities verified against the installed native capability predicate.
// Adaptive thinking does not imply that a model accepts disabled thinking.
const THINKING_OFF_MODELS = new Set([
  "claude-opus-4-0",
  "claude-opus-4-1",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-4-0",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-haiku-4-5",
]);
const DATED_THINKING_IDENTITIES: Readonly<Record<string, string>> = {
  "claude-sonnet-4-5-20250929": "claude-sonnet-4-5",
  "claude-sonnet-4-5@20250929": "claude-sonnet-4-5",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  "claude-haiku-4-5@20251001": "claude-haiku-4-5",
  "claude-opus-4-5-20251101": "claude-opus-4-5",
  "claude-opus-4-5@20251101": "claude-opus-4-5",
};
export function claudeKnownThinkingTraits(modelId: string): ClaudeModelTraits {
  const base = modelId.replace(/\[(?:\d+[km])\]$/iu, "");
  const identity = DATED_THINKING_IDENTITIES[base] ?? base;
  if (identity === "claude-sonnet-5-5" || identity === "claude-opus-5-5")
    return { disableThinking: false };
  if (!THINKING_OFF_MODELS.has(identity)) return {};
  return {
    disableThinking: true,
    ...(identity === "claude-opus-5" ? { disabledThinkingEfforts: ["low", "medium", "high"] } : {}),
  };
}
export interface ClaudeCustomModel {
  readonly id: string;
  readonly displayName: string;
  readonly traits: ClaudeModelTraits;
}
export interface ClaudeDiscoveredSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly enabled: boolean;
  readonly userInvocable: boolean;
}
export interface ClaudeHealth {
  readonly status: "ready" | "unknown" | "error";
  readonly executable: string | null;
  readonly version: string | null;
  readonly account: {
    readonly email?: string;
    readonly tokenSource?: string;
    readonly subscriptionType?: string;
    readonly apiProvider?: string;
  } | null;
  readonly error: string | null;
}
export interface ClaudeDiscovery {
  readonly models: readonly AgentSessionConfigSelectOption[];
  readonly intelligence: ClaudeResolvedIntelligence;
  readonly commands: readonly {
    readonly name: string;
    readonly description: string;
    readonly argumentHint: string;
  }[];
  readonly skills: readonly ClaudeDiscoveredSkill[];
  readonly health: ClaudeHealth;
  readonly revision: string;
}
export interface ClaudeHistoryPage {
  readonly messages: readonly {
    readonly type: string;
    readonly uuid: string;
    readonly session_id: string;
    readonly message: unknown;
    readonly parent_tool_use_id: string | null;
    readonly parent_agent_id: string | null;
  }[];
  readonly before: string | null;
  readonly hasMore: boolean;
}

export interface ClaudeRuntimeDiagnostics {
  readonly health: ClaudeHealth;
  readonly mcpServers: readonly {
    readonly name: string;
    readonly status: string;
    readonly error?: string;
  }[];
  readonly agents: readonly { readonly name: string; readonly description: string }[];
  readonly capabilities: readonly string[];
}

export interface ClaudeModelCatalogInput {
  readonly requestId?: string;
  readonly forceReload?: boolean;
  readonly instanceConfigId: string;
  readonly projectId: string | null;
}

/** Drafts discover their selected Project; attached chats discover their saved execution location. */
export type ClaudeDiscoveryScope =
  | {
      readonly kind: "project";
      readonly instanceConfigId: string;
      readonly projectId: string | null;
    }
  | { readonly kind: "thread"; readonly threadId: string };

export interface ClaudeDiscoveryInput {
  readonly scope: ClaudeDiscoveryScope;
  readonly requestId?: string;
  readonly forceReload?: boolean;
}

/** Versioned Claude IDs have a readable label; gateway IDs remain opaque. */
export function claudeModelName(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[.*\])?$/u.exec(id);
  if (!match) return id;
  const [, family, major, minor, suffix] = match;
  return `Claude ${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ""}${suffix ? ` ${suffix}` : ""}`;
}
