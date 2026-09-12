import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import type { CodexCanonicalConversationState } from "../../shared/types";
import type { CodexApplicationProtocolOccurrence } from "../codex-runtime/CodexApplicationRequestInbox";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const eventThreadId = (params: Record<string, unknown> | null): string | null =>
  typeof params?.threadId === "string" ? params.threadId : null;

const eventTurnId = (params: Record<string, unknown> | null): string | null =>
  typeof params?.turnId === "string" ? params.turnId : null;

const deltaKey = (method: string, turnId: string | null, itemId: string): string =>
  `${method}:${turnId ?? ""}:${itemId}`;

interface CompactableNotification {
  readonly method: string;
  readonly params: unknown;
}

const compactEvents = <Event>(input: {
  readonly threadId: string;
  readonly canonicalState: CodexCanonicalConversationState | null;
  readonly events: readonly Event[];
  readonly notification: (event: Event) => CompactableNotification | null;
  readonly replaceDelta: (event: Event, delta: string) => Event;
}): Event[] => {
  const completedAgentDeltaKeys = new Set<string>();
  const bufferedDeltasByKey = new Map<
    string,
    {
      method: "item/agentMessage/delta" | "item/commandExecution/outputDelta";
      turnId: string | null;
      itemId: string;
      text: string[];
    }
  >();

  for (const event of input.events) {
    const notification = input.notification(event);
    if (!notification) continue;
    const payload = asRecord(notification.params);
    if (eventThreadId(payload) !== input.threadId) continue;
    if (notification.method === "item/completed") {
      const item = asRecord(payload?.item);
      if (item?.type !== "agentMessage" || typeof item.id !== "string") continue;
      completedAgentDeltaKeys.add(
        deltaKey("item/agentMessage/delta", eventTurnId(payload), item.id),
      );
      continue;
    }
    if (
      notification.method !== "item/agentMessage/delta" &&
      notification.method !== "item/commandExecution/outputDelta"
    ) {
      continue;
    }
    const itemId = typeof payload?.itemId === "string" ? payload.itemId : null;
    const delta = typeof payload?.delta === "string" ? payload.delta : null;
    if (!itemId || delta === null) continue;
    const turnId = eventTurnId(payload);
    const key = deltaKey(notification.method, turnId, itemId);
    const existing = bufferedDeltasByKey.get(key);
    if (existing) {
      existing.text.push(delta);
      continue;
    }
    bufferedDeltasByKey.set(key, {
      method: notification.method,
      turnId,
      itemId,
      text: [delta],
    });
  }

  const duplicateCharactersByKey = new Map<string, number>();
  const canonicalTurns = residentConversationTurns(input.canonicalState);
  for (const [key, buffered] of bufferedDeltasByKey) {
    const turn = canonicalTurns.find((candidate) => candidate.turnId === buffered.turnId);
    const item = turn?.items.find(
      (candidate) =>
        candidate.id === buffered.itemId &&
        (buffered.method === "item/agentMessage/delta"
          ? candidate.type === "agentMessage"
          : candidate.type === "commandExecution"),
    );
    const existingText =
      buffered.method === "item/agentMessage/delta" && item?.type === "agentMessage"
        ? item.text
        : buffered.method === "item/commandExecution/outputDelta" &&
            item?.type === "commandExecution"
          ? item.aggregatedOutput
          : null;
    const fullDelta = buffered.text.join("");
    duplicateCharactersByKey.set(
      key,
      existingText !== null && existingText.endsWith(fullDelta) ? fullDelta.length : 0,
    );
  }

  return input.events.flatMap((event): Event[] => {
    const notification = input.notification(event);
    if (!notification) return [event];
    if (
      notification.method !== "item/agentMessage/delta" &&
      notification.method !== "item/commandExecution/outputDelta"
    ) {
      return [event];
    }
    const payload = asRecord(notification.params);
    const itemId = typeof payload?.itemId === "string" ? payload.itemId : null;
    const delta = typeof payload?.delta === "string" ? payload.delta : null;
    if (!itemId || delta === null) return [];
    const key = deltaKey(notification.method, eventTurnId(payload), itemId);
    if (notification.method === "item/agentMessage/delta" && completedAgentDeltaKeys.has(key)) {
      return [];
    }
    const duplicateCharacters = duplicateCharactersByKey.get(key) ?? 0;
    const consumedCharacters = Math.min(duplicateCharacters, delta.length);
    duplicateCharactersByKey.set(key, duplicateCharacters - consumedCharacters);
    const remainingDelta = delta.slice(consumedCharacters);
    if (!remainingDelta) return [];
    return remainingDelta === delta ? [event] : [input.replaceDelta(event, remainingDelta)];
  });
};

/** Compacts final Inbox occurrences without adding request-completion callbacks. */
export const compactCodexApplicationProtocolOccurrences = (input: {
  readonly threadId: string;
  readonly canonicalState: CodexCanonicalConversationState | null;
  readonly events: readonly CodexApplicationProtocolOccurrence[];
}): CodexApplicationProtocolOccurrence[] =>
  compactEvents({
    ...input,
    notification: (event) =>
      event.kind === "notification" ? { method: event.method, params: event.params } : null,
    replaceDelta: (event, delta) =>
      event.kind === "notification"
        ? { ...event, params: { ...(asRecord(event.params) ?? {}), delta } }
        : event,
  });
