import { z } from "zod";
import type { CodexCanonicalItem } from "../codex-conversation-state/codex-conversation-state";
import type { AutomationUpdateView } from "../types";
import { automationSchema } from "./automation-schema";

const resultData = z.record(z.string(), z.unknown());
const definitionSnapshot = z.object({
  id: z.string().trim().min(1).max(512),
  kind: z.enum(["cron", "heartbeat"]),
  name: z.string(),
  rrule: z.string().nullable(),
  mode: z.enum(["dry_run", "ask_first", "run"]).optional(),
  runbookPageId: z.string().nullable().optional(),
});

/** Project only successful native results; proposals carry the target resolved by Main. */
export function projectNativeAutomationUpdate(
  item: Extract<CodexCanonicalItem, { type: "mcpToolCall" }>,
): AutomationUpdateView | undefined {
  if (
    item.server !== "nodex_app" ||
    item.tool !== "automations_update" ||
    item.status !== "completed" ||
    item.error !== null
  )
    return undefined;
  const parsedResult = resultData.safeParse(item.result?.structuredContent);
  if (!parsedResult.success) return undefined;
  const data = parsedResult.data;
  if ("error" in data || data.ok === false) return undefined;
  if (data.committed === false) {
    const parsed = automationSchema.safeParse(data.proposal);
    if (!parsed.success) return undefined;
    const proposal = parsed.data;
    if (proposal.operation !== "suggested_create" && proposal.operation !== "suggested_update")
      return undefined;
    if (proposal.kind === "heartbeat" && !proposal.targetSessionId) return undefined;
    return { callId: item.id, source: "nativeMcp", arguments: proposal, proposal, result: null };
  }
  const request = automationSchema.safeParse(item.arguments);
  if (!request.success) return undefined;
  const { operation } = request.data;
  if (
    operation !== "view" &&
    operation !== "create" &&
    operation !== "update" &&
    operation !== "delete"
  )
    return undefined;
  const snapshot = definitionSnapshot.safeParse(data.item);
  if (!snapshot.success) return undefined;
  return {
    callId: item.id,
    source: "nativeMcp",
    arguments: { operation, ...snapshot.data },
    result: {
      automationId: snapshot.data.id,
      operation: operation === "view" ? null : operation,
      ...(operation === "delete" && (data.status === "deleted" || data.status === "not_found")
        ? { deleteStatus: data.status }
        : {}),
      snapshot: { ...snapshot.data, rrule: snapshot.data.rrule ?? "" },
    },
  };
}
