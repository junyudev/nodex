export interface CodexExecutionProfile {
  readonly modelId: string;
  readonly reasoningEffort: string | null;
  readonly serviceTier: string | null;
}

export type CodexExecutionProfileChange = "model" | "reasoningEffort" | "serviceTier";
