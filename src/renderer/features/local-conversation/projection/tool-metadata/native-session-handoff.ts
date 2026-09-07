import { z } from "zod";
import { sessionHandoffSchema } from "../../../../../shared/nodex-app-tools/session-handoff-schemas";
import type { CodexMcpToolCallView } from "../../../../../shared/types";
import type { ThreadHandoffScope } from "../../../../lib/thread-handoff-runtime";

const admission = z.object({
  operationId: z.string().min(1),
  sessionId: z.string().min(1),
  threadId: z.string().min(1),
  deliveryState: z.literal("started"),
});

/** Bind native admission to the same Profile progress owner used by handoff controls. */
export function resolveNativeSessionHandoffScope(
  payload: CodexMcpToolCallView | undefined,
  requestThreadId: string,
): ThreadHandoffScope | null {
  if (
    !payload ||
    payload.invocation.server !== "nodex_app" ||
    payload.invocation.tool !== "handoff_session"
  )
    return null;
  if (!payload.completed || payload.result?.type !== "success") return null;
  const request = sessionHandoffSchema.safeParse(payload.invocation.arguments);
  const result = admission.safeParse(payload.result.structuredContent);
  if (!request.success || !result.success || result.data.sessionId !== request.data.sessionId)
    return null;
  if (request.data.operationId && request.data.operationId !== result.data.operationId) return null;
  return {
    operationId: result.data.operationId,
    requestThreadId,
    targetThreadId: result.data.threadId,
    destinationHostId: request.data.destinationHostId ?? null,
  };
}
