import type { FuzzyFileSearchSessionStartParams } from "@nodex/codex-app-server-protocol";
import type { FuzzyFileSearchSessionUpdateParams } from "@nodex/codex-app-server-protocol";
import type { FuzzyFileSearchSessionStopParams } from "@nodex/codex-app-server-protocol";
import { z } from "zod";

const sessionId = z.string().uuid();
export const ComposerFileSearchStartSchema = z
  .object({
    sessionId,
    roots: z.array(z.string().trim().min(1)).min(1).max(16),
  })
  .strict() satisfies z.ZodType<FuzzyFileSearchSessionStartParams>;
export const ComposerFileSearchUpdateSchema = z
  .object({
    sessionId,
    query: z.string().max(512),
  })
  .strict() satisfies z.ZodType<FuzzyFileSearchSessionUpdateParams>;
export const ComposerFileSearchStopSchema = z
  .object({ sessionId })
  .strict() satisfies z.ZodType<FuzzyFileSearchSessionStopParams>;
