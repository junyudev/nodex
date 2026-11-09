import { z } from "zod";
import type { WorkbenchSideChatSurfaceConfig } from "../workbench-scene";

export const WorkbenchSideChatSurfaceConfigSchema = z.strictObject({
  sessionId: z.string().min(1).max(512),
}) satisfies z.ZodType<WorkbenchSideChatSurfaceConfig>;
