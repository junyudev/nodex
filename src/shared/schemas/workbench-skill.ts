import { z } from "zod";
import {
  WorkbenchAbsoluteFilePathSchema,
  WorkbenchFileHostIdSchema,
} from "../workbench-resource-identity";

export const WorkbenchSkillSurfaceConfigSchema = z.strictObject({
  hostId: WorkbenchFileHostIdSchema,
  projectId: z.string().min(1).max(512).nullable(),
  skillId: z.string().min(1).max(256),
  // Presentation metadata only. The inventory resolves the ID and grants file access.
  manifestPath: WorkbenchAbsoluteFilePathSchema.nullable(),
});

export type WorkbenchSkillSurfaceConfig = z.infer<typeof WorkbenchSkillSurfaceConfigSchema>;
