import type { CoreScenarioContext } from "../scenarios/harness/core-scenario-harness";

export type EvaluationContext = Pick<
  CoreScenarioContext,
  "runtime" | "seed" | "manifest" | "profile"
>;

export interface CaseAssertion {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}
export interface CaseVerification {
  readonly passed: boolean;
  readonly assertions: readonly CaseAssertion[];
}
export interface ObservedCommand {
  readonly args: readonly string[];
  readonly stdout: string;
  readonly exitCode: number;
}
export interface PreparedCase {
  readonly prompt: string;
  readonly verify: (finalAnswer: string) => Promise<CaseVerification>;
  readonly afterCommand?: (call: ObservedCommand) => Promise<void>;
  readonly followUpPrompt?: string;
}
export interface CaseDefinition {
  readonly id: string;
  readonly group: "core" | "holdout";
  readonly prompt: string;
  readonly prepare: (context: EvaluationContext, variant: number) => Promise<PreparedCase>;
}

export const EVALUATION_HOLDOUT_CASE_IDS = ["ambiguous-title", "concurrent-edit"] as const;
