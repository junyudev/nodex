import { z } from "zod";
import { isBoundedOperationId } from "../operation-identity";

const sessionId = z.string().trim().min(1).max(512);
export const ProjectSessionPlacementSchema = z
  .object({
    kind: z.enum(["before", "after"]),
    sessionId,
  })
  .strict();
export const ProjectSessionPlaceCommandSchema = z
  .object({
    operationId: z.string().refine(isBoundedOperationId),
    payload: z.object({ sessionId, placement: ProjectSessionPlacementSchema }).strict(),
  })
  .strict();
export const ProjectSessionSummaryWindowInputSchema = z
  .object({
    order: z.enum(["activity", "manual"]).optional(),
    placementScope: z.enum(["all", "builtin"]).optional(),
    includeArchived: z.boolean().optional(),
    after: z.string().min(1).nullable().optional(),
    first: z.number().int().min(1).max(200).optional(),
  })
  .strict();

/** Lanes one scope's summary read may carry at once; the Core read accepts no more. */
export const MAX_PROJECT_SESSION_SUMMARY_LANES = 4;
export const ProjectSessionSummaryLanesInputSchema = z
  .array(ProjectSessionSummaryWindowInputSchema)
  .min(1)
  .max(MAX_PROJECT_SESSION_SUMMARY_LANES);
