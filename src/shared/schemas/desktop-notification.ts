import { z } from "zod";
import type { DesktopNotificationActionInvocation } from "../types";
import { InboxScopeSchema } from "./inbox-scope";

/** Device-local handoff across a Space switch retains the original notification authority. */
export const SpaceNotificationActionSchema = z
  .object({
    spaceId: z.string().min(1),
    notificationId: z.string(),
    actionId: z.string().nullable(),
    actionType: z.enum(["open", "reply"]),
    reply: z.string().optional(),
    hostId: z.string(),
    conversationId: z.string().nullable(),
    navigationPath: z.string().nullable(),
    activateTabId: z.string().nullable(),
    requestId: z.union([z.string(), z.number()]).nullable(),
    inboxEntry: z
      .object({ pageId: z.string(), scope: InboxScopeSchema, turnEpisode: z.string().optional() })
      .optional(),
    asyncQuestion: z.object({ turnId: z.string(), questionId: z.string() }).optional(),
  })
  .strict() satisfies z.ZodType<DesktopNotificationActionInvocation & { spaceId: string }>;
