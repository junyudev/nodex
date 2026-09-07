import { isDeepStrictEqual } from "node:util";
import type { ItemStartedNotification } from "@nodex/codex-app-server-protocol/v2/ItemStartedNotification";

export interface CodexAppCallClaim {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  /** Recheck before committing; completing a Turn or closing its generation revokes the claim. */
  readonly isActive: () => boolean;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * One ledger per authenticated app-server generation. Only the reliable protocol ingress may
 * observe items. MCP metadata is matched against that observation, never used to create authority.
 * A claim proves invocation identity only; Core authority and consent remain separate checks.
 */
export const createCodexAppCallAdmission = (capacity = 1024) => {
  const calls = new Map<string, { event: ItemStartedNotification; claimed: boolean }>();
  const turns = new Map<string, string>();
  let closed = false;

  const endTurn = (threadId: string, turnId: string) => {
    if (turns.get(threadId) === turnId) turns.delete(threadId);
    for (const [id, call] of calls) {
      if (call.event.threadId === threadId && call.event.turnId === turnId) calls.delete(id);
    }
  };

  return {
    startTurn(threadId: string, turnId: string): void {
      if (closed) return;
      const previous = turns.get(threadId);
      if (previous && previous !== turnId) endTurn(threadId, previous);
      turns.set(threadId, turnId);
    },
    endTurn,
    observe(event: ItemStartedNotification): boolean {
      if (closed || turns.get(event.threadId) !== event.turnId) return false;
      const item = event.item;
      if (item.type !== "mcpToolCall" || item.server !== "nodex_app") return false;
      // Never overwrite an existing claim, including a replayed item/started notification.
      if (calls.has(item.id) || calls.size >= capacity) return false;
      calls.set(item.id, { event: structuredClone(event), claimed: false });
      return true;
    },
    claim(input: {
      readonly name: string;
      readonly arguments: Record<string, unknown>;
      readonly metadata: Record<string, unknown>;
    }): CodexAppCallClaim | null {
      if (closed) return null;
      const callId = input.metadata.callId;
      const metadata = record(input.metadata["x-codex-turn-metadata"]);
      if (typeof callId !== "string" || !metadata) return null;
      const call = calls.get(callId);
      if (!call || call.claimed) return null;
      const { threadId, turnId, item } = call.event;
      if (metadata.thread_id !== threadId || metadata.turn_id !== turnId) return null;
      if (item.type !== "mcpToolCall" || item.tool !== input.name) return null;
      if (!isDeepStrictEqual(item.arguments, input.arguments)) return null;
      call.claimed = true;
      return {
        threadId,
        turnId,
        callId,
        isActive: () => !closed && calls.get(callId) === call && turns.get(threadId) === turnId,
      };
    },
    close(): void {
      closed = true;
      calls.clear();
      turns.clear();
    },
  };
};
