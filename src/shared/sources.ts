import type { components } from "@nodex/core-protocol";
import { z } from "zod";
type Model = components["schemas"];
export interface SourcesSettingsSnapshot {
  readonly source: Model["Source"] | null;
  readonly account: { readonly login: string; readonly id: string } | null;
  readonly connection: "connected" | "reconnect" | "disconnected";
  readonly repositories: readonly Model["SourceRepository"][];
  readonly problems: readonly Model["SourceProblem"][];
  readonly lastSuccessAtMs: number | null;
  readonly nextPollAtMs: number | null;
}
export const updateSourceSettingsSchema = z
  .object({
    sourceId: z.string().min(1).max(512),
    expectedRevision: z.number().int().min(1),
    enabled: z.boolean(),
    repositories: z
      .array(z.object({ id: z.string().regex(/^\d+$/), enabled: z.boolean() }).strict())
      .max(200),
    discovery: z
      .object({ assigned: z.boolean(), review_requests: z.boolean(), mentions: z.boolean() })
      .strict(),
  })
  .strict();
export type UpdateSourceSettingsInput = z.infer<typeof updateSourceSettingsSchema>;
