import { z } from "zod";
import type { WorkbenchPageFileSurfaceConfig } from "../workbench-scene";
import { ContentRoutingContextSchema } from "./content-routing-context";

export const WorkbenchPageFileSurfaceConfigSchema = z.strictObject({
  routingContext: ContentRoutingContextSchema,
  pageId: z.string().min(1).max(512),
  fileId: z.string().min(1).max(512),
  logicalPath: z.string().min(1).max(4_096).nullable(),
  titleSnapshot: z.string().max(2_000).optional(),
}) satisfies z.ZodType<WorkbenchPageFileSurfaceConfig>;
