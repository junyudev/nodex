import type { PlanType } from "@nodex/codex-app-server-protocol";

export const PAID_AGENT_SMOKE_CASES = ["file", "browser", "subagent"] as const;

export const PAID_AGENT_SMOKE_DISABLED_SKILL_NAMES = ["agent-browser", "qa-testing"] as const;

export type PaidAgentSmokeCase = (typeof PAID_AGENT_SMOKE_CASES)[number];

export interface PaidAgentSmokeCaseDefinition {
  readonly id: PaidAgentSmokeCase;
  readonly grep: string;
  readonly modelId: string;
  readonly reasoningEffort: string;
  readonly expectedLogicalExecutions: number;
}

export const PAID_AGENT_SMOKE_DEFINITIONS: Readonly<
  Record<PaidAgentSmokeCase, PaidAgentSmokeCaseDefinition>
> = {
  file: {
    id: "file",
    grep: "@paid-agent-file",
    modelId: "gpt-5.6-luna",
    reasoningEffort: "max",
    expectedLogicalExecutions: 1,
  },
  browser: {
    id: "browser",
    grep: "@paid-agent-browser",
    modelId: "gpt-5.6-luna",
    reasoningEffort: "max",
    expectedLogicalExecutions: 1,
  },
  subagent: {
    id: "subagent",
    grep: "@paid-agent-subagent",
    modelId: "gpt-5.6-terra",
    reasoningEffort: "medium",
    expectedLogicalExecutions: 2,
  },
};

export const isPaidAgentSmokeCase = (value: string): value is PaidAgentSmokeCase =>
  PAID_AGENT_SMOKE_CASES.some((candidate) => candidate === value);

const PAID_CHATGPT_PLAN_TYPES = new Set<PlanType>([
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "edu_plus",
  "edu_pro",
]);

export const isPaidChatGptPlan = (planType: string): planType is PlanType =>
  PAID_CHATGPT_PLAN_TYPES.has(planType as PlanType);

export const requirePaidAgentSmokeCase = (value: string | undefined): PaidAgentSmokeCase => {
  if (value && isPaidAgentSmokeCase(value)) return value;
  throw new Error(
    `Paid Agent smoke case must be one of ${PAID_AGENT_SMOKE_CASES.join(" | ")}; received ${JSON.stringify(value)}.`,
  );
};

/**
 * Keeps each paid canary's model-facing capability surface bounded to the behavior it verifies.
 * Non-subagent canaries remove unrelated delegation tools; the subagent canary retains the
 * model-selected native multi-agent surface it exists to exercise.
 */
export const buildPaidAgentSmokeCodexConfig = (caseId: PaidAgentSmokeCase): string => {
  const featureOverrides =
    caseId === "subagent"
      ? ""
      : `[features]
multi_agent = false
multi_agent_v2 = false

[agents]
enabled = false

`;
  const disabledSkills = PAID_AGENT_SMOKE_DISABLED_SKILL_NAMES.map(
    (name) => `[[skills.config]]
name = ${JSON.stringify(name)}
enabled = false
`,
  ).join("\n");
  return `${featureOverrides}${disabledSkills}`;
};
