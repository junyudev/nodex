import { z } from "zod";

/** A one-shot semantic presentation request, never arbitrary saved view state. */
export const WorkbenchSurfaceRevealSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file"), line: z.number().int().min(1).max(10_000_000) }),
  z.strictObject({
    kind: z.literal("review"),
    threadId: z.string().min(1).max(512),
    view: z.enum(["last-turn", "branch", "unstaged", "staged"]),
    baseBranch: z.string().min(1).max(512).optional(),
    path: z.string().min(1).max(4_096).optional(),
  }),
]);
export type WorkbenchSurfaceReveal = z.infer<typeof WorkbenchSurfaceRevealSchema>;

export const WorkbenchPendingReviewOpenSchema = z.strictObject({
  operationId: z.string().min(1).max(512),
  intent: WorkbenchSurfaceRevealSchema.options[1],
});
export type WorkbenchPendingReviewOpen = z.infer<typeof WorkbenchPendingReviewOpenSchema>;
