import { z } from "zod";
import type { components } from "@nodex/core-protocol";
import { executionHoldScopeSchema } from "./work-application";
export type PageTurn = components["schemas"]["PageTurn"];
export type TurnReason = components["schemas"]["TurnReason"];
const assignee = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), member_id: z.string() }),
  z.object({
    kind: z.literal("agent"),
    instance_id: z.string(),
    model: z.string(),
    effort: z.string().nullable().optional(),
  }),
]);
const actor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), member_id: z.string() }),
  z.object({ kind: z.literal("agent"), assignee }),
  z.object({ kind: z.literal("page"), page_id: z.string(), key: z.string().nullable().optional() }),
  z.object({ kind: z.literal("queue"), position: z.number().int().positive() }),
  z.object({ kind: z.literal("none") }),
]);
const schema = z.object({
  page_id: z.string(),
  actor,
  reason: z
    .enum([
      "working",
      "paused",
      "queued",
      "question",
      "approval",
      "blocked",
      "failed",
      "stalled",
      "review",
      "ready_to_start",
      "starting",
      "waiting_on_prerequisite",
    ])
    .nullable()
    .optional(),
  since: z.string(),
  episode: z.string(),
  hold: z
    .object({
      scope: executionHoldScopeSchema,
      actor: z.string(),
      revision: z.number().int().positive(),
      paused_at: z.string(),
    })
    .nullable()
    .optional(),
});
export const parsePageTurn = (value: unknown): PageTurn => schema.parse(value);
