import type { CodexModelOption } from "../../shared/types";
import type { ThreadStartParams } from "@nodex/codex-app-server-protocol/v2";
import { AgentWorktreeStartingStateSchema } from "../../shared/schemas/worktree-starting-state";

export const CODEX_DYNAMIC_CREATE_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type CodexDynamicCreateReasoningEffort =
  (typeof CODEX_DYNAMIC_CREATE_REASONING_EFFORTS)[number];

export type CodexDynamicCreateStartingState =
  | { readonly type: "working-tree" }
  | { readonly type: "branch"; readonly branchName: string };

export type CodexDynamicCreateTarget =
  | {
      readonly type: "project";
      readonly projectId: string;
      readonly environment:
        | { readonly type: "local" }
        | {
            readonly type: "worktree";
            readonly startingState?: CodexDynamicCreateStartingState;
          };
    }
  | {
      readonly type: "projectless";
      readonly directoryName?: string;
    };

export interface CodexDynamicCreateThreadInput {
  readonly prompt: string;
  readonly target: CodexDynamicCreateTarget;
  readonly model?: string;
  readonly thinking?: CodexDynamicCreateReasoningEffort;
}

export interface CodexDynamicCreateModelProjection {
  readonly collaborationMode: {
    readonly mode: "default";
    readonly settings: {
      readonly model: string;
      readonly reasoning_effort: CodexDynamicCreateReasoningEffort;
      readonly developer_instructions: null;
    };
  } | null;
  readonly configOverrides: Readonly<NonNullable<ThreadStartParams["config"]>> | null;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCodexDynamicCreateReasoningEffort(
  value: unknown,
): value is CodexDynamicCreateReasoningEffort {
  return CODEX_DYNAMIC_CREATE_REASONING_EFFORTS.some((effort) => effort === value);
}

/** Shares the worker's starting-state schema, so an accepted branch is never rejected later. */
function parseStartingState(value: unknown): CodexDynamicCreateStartingState | null {
  const parsed = AgentWorktreeStartingStateSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.type === "working-tree") return { type: "working-tree" };
  return { type: "branch", branchName: parsed.data.branchName };
}

function parseTarget(value: unknown): CodexDynamicCreateTarget | null {
  if (!isRecord(value)) return null;
  if (value.type === "projectless") {
    if (value.directoryName !== undefined && !isNonemptyString(value.directoryName)) return null;
    return {
      type: "projectless",
      ...(value.directoryName === undefined ? {} : { directoryName: value.directoryName }),
    };
  }
  if (value.type !== "project" || !isNonemptyString(value.projectId)) return null;
  if (!isRecord(value.environment)) return null;
  if (value.environment.type === "local") {
    return {
      type: "project",
      projectId: value.projectId,
      environment: { type: "local" },
    };
  }
  if (value.environment.type !== "worktree") return null;
  const startingState =
    value.environment.startingState === undefined
      ? undefined
      : parseStartingState(value.environment.startingState);
  if (startingState === null) return null;
  return {
    type: "project",
    projectId: value.projectId,
    environment: {
      type: "worktree",
      ...(startingState === undefined ? {} : { startingState }),
    },
  };
}

/** Exact `GCn`: validate without trimming any accepted scalar. */
export function parseCodexDynamicCreateThreadInput(
  value: unknown,
): CodexDynamicCreateThreadInput | null {
  if (!isRecord(value) || !isNonemptyString(value.prompt)) return null;
  const target = parseTarget(value.target);
  if (!target) return null;
  if (value.model !== undefined && !isNonemptyString(value.model)) return null;
  if (value.thinking !== undefined && !isCodexDynamicCreateReasoningEffort(value.thinking)) {
    return null;
  }
  return {
    prompt: value.prompt,
    target,
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.thinking === undefined ? {} : { thinking: value.thinking }),
  };
}

/** Exact `st/$`: model selects default collaboration; thinking-only is a config override. */
export function projectCodexDynamicCreateModel(
  model: string | undefined,
  thinking: CodexDynamicCreateReasoningEffort | undefined,
): CodexDynamicCreateModelProjection {
  if (!model) {
    return {
      collaborationMode: null,
      configOverrides: thinking ? { model_reasoning_effort: thinking } : null,
    };
  }
  return {
    collaborationMode: {
      mode: "default",
      settings: {
        model,
        reasoning_effort: thinking ?? "medium",
        developer_instructions: null,
      },
    },
    configOverrides: null,
  };
}

/** Exact `FCn`: validate only the explicitly supplied model/reasoning pair. */
export function validateCodexDynamicCreateModelReasoning(
  model: string,
  thinking: CodexDynamicCreateReasoningEffort,
  models: readonly CodexModelOption[],
): string | null {
  const selected = models.find((candidate) => candidate.model === model);
  if (!selected) {
    return `create_thread could not validate reasoning effort "${thinking}" for model "${model}". Use a model and reasoning combination listed in the tool description, or omit thinking.`;
  }
  const supported = selected.supportedReasoningEfforts.map((option) => option.reasoningEffort);
  if (supported.some((effort) => effort === thinking)) return null;
  const detail =
    supported.length === 0
      ? "This model supports no reasoning effort overrides."
      : `Supported reasoning efforts: ${supported.join(", ")}.`;
  return `create_thread rejected unsupported model/reasoning combination: "${selected.model}" does not support "${thinking}". ${detail}`;
}
