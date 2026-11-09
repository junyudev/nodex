import type { components } from "@nodex/core-protocol";
import { z } from "zod";

export type Actor = components["schemas"]["Actor"];
const id = z.string().min(1).max(512);
export const actorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("member"), member_id: id }).strict(),
  z
    .object({ type: z.literal("agent"), session_id: id, run_id: id.nullish(), on_behalf_of: id })
    .strict(),
  z
    .object({
      type: z.literal("service"),
      kind: z.enum([
        "sources",
        "automations",
        "scheduler",
        "inbox_routing",
        "agent_runtime",
        "maintenance",
        "notifications",
        "membership",
      ]),
    })
    .strict(),
]) satisfies z.ZodType<Actor>;
