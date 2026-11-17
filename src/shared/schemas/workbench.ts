import { z } from "zod";
import type {
  WorkbenchRecentPageSession,
  WorkbenchLayoutPageStageState,
  WorkbenchLayoutStageId,
  WorkbenchLayoutStageNavDirection,
  WorkbenchLayoutView,
} from "../workbench-layout";

const CurrentWorkbenchViewSchema = z.enum(["board", "list", "toggle-list", "calendar"]);

export const WorkbenchViewSchema = z.preprocess(
  (value) => (value === "kanban" ? "board" : value),
  CurrentWorkbenchViewSchema,
) satisfies z.ZodType<WorkbenchLayoutView>;

export const WorkbenchStageIdSchema = z.enum([
  "db",
  "pages",
  "threads",
  "files",
]) satisfies z.ZodType<WorkbenchLayoutStageId>;

export const WorkbenchStageNavDirectionSchema = z.enum([
  "left",
  "right",
]) satisfies z.ZodType<WorkbenchLayoutStageNavDirection>;

export const WorkbenchRecentPageSessionSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  pageId: z.string(),
  titleSnapshot: z.string(),
  lastOpenedAt: z.string(),
}) satisfies z.ZodType<WorkbenchRecentPageSession>;

export const WorkbenchLayoutPageStageStateSchema = z.object({
  open: z.boolean(),
  projectId: z.string(),
  pageId: z.string().nullable(),
}) satisfies z.ZodType<WorkbenchLayoutPageStageState>;
