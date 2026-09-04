import { z } from "zod";
import type { FocusedHistoryPublication } from "../surface-history";

const capability = z
  .object({
    status: z.enum(["ready", "waiting", "blocked", "empty"]),
    label: z.string().max(512).nullable(),
    acceptsIntent: z.boolean(),
    reason: z.string().max(4096).nullable(),
    recoveryActions: z.array(z.enum(["retry", "reset"])).max(2),
  })
  .strict();

export const FocusedHistoryPublicationSchema = z
  .object({
    generation: z.number().int().positive(),
    sequence: z.number().int().nonnegative(),
    snapshot: z
      .object({
        ownerId: z.string().min(1).max(512),
        generation: z.number().int().nonnegative(),
        revision: z.number().int().nonnegative(),
        undo: capability,
        redo: capability,
      })
      .strict()
      .nullable(),
  })
  .strict() satisfies z.ZodType<FocusedHistoryPublication>;
