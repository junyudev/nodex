import { z } from "zod";

const boundedText = (maxBytes: number) =>
  z
    .string()
    .regex(/\S/, "Must contain a non-whitespace character")
    .min(1)
    .max(maxBytes)
    .describe(`Nonblank text, at most ${maxBytes} UTF-8 bytes`);

const eventFilter = z.strictObject({
  sourceId: boundedText(512).nullable(),
  repositories: z.array(boundedText(512)).max(100),
  events: z
    .array(
      z.enum([
        "new_issue",
        "new_pr",
        "comment",
        "review",
        "check_failed",
        "check_passed",
        "label_added",
        "label_removed",
      ]),
    )
    .min(1)
    .max(8),
  labels: z.array(boundedText(100)).max(100),
  actorClass: z.enum(["person", "any"]),
});

export const AutomationEventTriggerSchema = z.strictObject({
  kind: z.literal("event"),
  filter: eventFilter,
});

export const AutomationClockTriggerInputSchema = z.strictObject({
  kind: z.literal("clock"),
  rrule: boundedText(16 * 1024),
  timezone: boundedText(512).optional(),
});

export const AutomationTriggerInputSchema = z.discriminatedUnion("kind", [
  AutomationClockTriggerInputSchema,
  AutomationEventTriggerSchema,
]);

export const AutomationTriggerSchema = z.discriminatedUnion("kind", [
  AutomationClockTriggerInputSchema.extend({
    timezone: AutomationClockTriggerInputSchema.shape.timezone.unwrap(),
    nextRunAt: z.number().nullable(),
  }),
  AutomationEventTriggerSchema,
]);
