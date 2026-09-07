import { z } from "zod";
import type { CodexCanonicalItem } from "../codex-conversation-state/codex-conversation-state";
import type { CodexAutomationUpdateView } from "../types";
import { automationSchema } from "./automation-schema";

const successfulResult = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) });
const definitionSnapshot = z.object({
  id: z.string().trim().min(1).max(512),
  kind: z.enum(["cron", "heartbeat"]),
  name: z.string(),
  rrule: z.string().nullable(),
});

/** Project only successful native results; proposals carry the target resolved by Main. */
export function projectNativeAutomationUpdate(
  item: Extract<CodexCanonicalItem, { type: "mcpToolCall" }>,
): CodexAutomationUpdateView | undefined {
  if (
    item.server !== "nodex_app" ||
    item.tool !== "automation_update" ||
    item.status !== "completed" ||
    item.error !== null
  )
    return undefined;
  const envelope = successfulResult.safeParse(item.result?.structuredContent);
  if (!envelope.success) return undefined;
  const data = envelope.data.data;
  if (data.committed === false) {
    const parsed = automationSchema.safeParse(data.proposal);
    if (!parsed.success) return undefined;
    const proposal = parsed.data;
    if (proposal.mode !== "suggested_create" && proposal.mode !== "suggested_update")
      return undefined;
    if (proposal.kind === "heartbeat" && !proposal.targetSessionId) return undefined;
    return { callId: item.id, source: "nativeMcp", arguments: proposal, proposal, result: null };
  }
  const request = automationSchema.safeParse(item.arguments);
  if (!request.success) return undefined;
  const { mode } = request.data;
  if (mode !== "view" && mode !== "create" && mode !== "update" && mode !== "delete")
    return undefined;
  const snapshot = definitionSnapshot.safeParse(data.item);
  if (!snapshot.success) return undefined;
  return {
    callId: item.id,
    source: "nativeMcp",
    arguments: { mode, ...snapshot.data },
    result: {
      automationId: snapshot.data.id,
      mode: mode === "view" ? null : mode,
      ...(mode === "delete" && (data.status === "deleted" || data.status === "not_found")
        ? { deleteStatus: data.status }
        : {}),
      snapshot: { ...snapshot.data, rrule: snapshot.data.rrule ?? "" },
    },
  };
}
