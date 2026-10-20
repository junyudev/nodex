import { z } from "zod";
import type { InboxScope } from "../inbox";

/** Which Inbox a message or Scene belongs to; a leaf schema shared by Inbox and Workbench. */
export const InboxScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("library") }).strict(),
  z.object({ kind: z.literal("project"), projectId: z.string().trim().min(1).max(512) }).strict(),
]) satisfies z.ZodType<InboxScope>;
