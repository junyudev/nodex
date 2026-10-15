import { isDeepStrictEqual } from "node:util";
import type { ItemStartedNotification } from "@nodex/codex-app-server-protocol/v2/ItemStartedNotification";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";

export interface CodexAppCallClaim {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  /** Recheck before committing; completion, cancellation or native retirement revokes the call. */
  readonly isActive: () => boolean;
}

const MAX_CALL_BYTES = 4 * 1024 * 1024;
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const turnKey = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);
const callKey = (threadId: string, turnId: string, callId: string) =>
  JSON.stringify([threadId, turnId, callId]);

/** Reliable native observations prove invocation identity; Core proves the product Session. */
export const createCodexAppCallAdmission = (capacity = 1024) => {
  const calls = new Map<
    string,
    {
      threadId: string;
      turnId: string;
      callId: string;
      tool: string;
      arguments: unknown;
      claimed: boolean;
      bytes: number;
    }
  >();
  const cancelledTurns = new Set<string>();
  let retainedBytes = 0;
  let closed = false;
  let overflowed = false;
  const close = () => {
    closed = true;
    calls.clear();
    cancelledTurns.clear();
    retainedBytes = 0;
  };
  const overflow = () => {
    overflowed = true;
    close();
    return false;
  };
  const completeCall = (threadId: string, turnId: string, callId: string) => {
    const key = callKey(threadId, turnId, callId);
    const call = calls.get(key);
    if (!call) return;
    calls.delete(key);
    retainedBytes -= call.bytes;
  };
  return {
    isTurnLive: (threadId: string, turnId: string) =>
      !closed && !cancelledTurns.has(turnKey(threadId, turnId)),
    get overflowed() {
      return overflowed;
    },
    cancelTurn(threadId: string, turnId: string): void {
      if (closed) return;
      const key = turnKey(threadId, turnId);
      if (!cancelledTurns.has(key)) {
        const bytes = 32 + key.length * 2;
        if (cancelledTurns.size >= capacity || retainedBytes + bytes > MAX_REGISTRY_BYTES) {
          overflow();
          return;
        }
        cancelledTurns.add(key);
        retainedBytes += bytes;
      }
      for (const call of calls.values()) {
        if (call.threadId === threadId && call.turnId === turnId)
          completeCall(threadId, turnId, call.callId);
      }
    },
    completeCall,
    observe(event: ItemStartedNotification): boolean {
      if (closed) return false;
      const item = event.item;
      if (item.type !== "mcpToolCall" || item.server !== "nodex_app") return false;
      const identity = { threadId: event.threadId, turnId: event.turnId, callId: item.id };
      const candidate = { ...identity, tool: item.tool, arguments: item.arguments };
      const payloadBytes = cappedApproximateValueBytes(candidate, MAX_CALL_BYTES);
      if (payloadBytes > MAX_CALL_BYTES) return overflow();
      const key = callKey(event.threadId, event.turnId, item.id);
      if (cancelledTurns.has(turnKey(event.threadId, event.turnId)) || calls.has(key)) return false;
      const bytes = payloadBytes + 32 + key.length * 2;
      if (calls.size >= capacity || retainedBytes + bytes > MAX_REGISTRY_BYTES) return overflow();
      calls.set(key, {
        ...candidate,
        arguments: structuredClone(item.arguments),
        claimed: false,
        bytes,
      });
      retainedBytes += bytes;
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
      if (
        typeof callId !== "string" ||
        !metadata ||
        typeof metadata.thread_id !== "string" ||
        typeof metadata.turn_id !== "string"
      )
        return null;
      const key = callKey(metadata.thread_id, metadata.turn_id, callId);
      const call = calls.get(key);
      if (
        !call ||
        call.claimed ||
        call.tool !== input.name ||
        !isDeepStrictEqual(call.arguments, input.arguments)
      )
        return null;
      call.claimed = true;
      return {
        threadId: call.threadId,
        turnId: call.turnId,
        callId,
        isActive: () => !closed && calls.get(key) === call,
      };
    },
    close,
  };
};
