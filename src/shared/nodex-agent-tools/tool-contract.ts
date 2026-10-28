import type { z } from "zod";
export type NodexAgentToolEffect = "read" | "write" | "destructive";

export interface NodexAgentToolContract<
  TInputSchema extends z.ZodType = z.ZodType,
  TOutputSchema extends z.ZodType = z.ZodType,
> {
  readonly description: string;
  readonly inputSchema: TInputSchema;
  readonly outputSchema: TOutputSchema;
  readonly deferLoading: boolean;
  readonly classifyEffect: (input: z.output<TInputSchema>) => NodexAgentToolEffect;
}
