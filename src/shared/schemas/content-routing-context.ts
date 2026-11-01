import { z } from "zod";
import type { ContentRoutingContext } from "../content-routing-context";

const idSchema = z.string().min(1).max(512);

export const ContentRoutingContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("library") }).strict(),
  z
    .object({
      kind: z.literal("project"),
      projectId: idSchema,
    })
    .strict(),
]) satisfies z.ZodType<ContentRoutingContext>;
