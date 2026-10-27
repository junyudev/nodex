import { useEffect, useSyncExternalStore } from "react";
import {
  getUserInputAutoResolutionSnapshot,
  recordUserInputAutoResolutionActivity,
  snoozeUserInputAutoResolution,
  subscribeUserInputAutoResolutionChanges,
} from "@/lib/api";
import { buildCodexCanonicalRequestIdentityKey } from "../../../shared/codex-conversation-state/codex-conversation-state";
import type {
  CodexUserInputAutoResolutionChange,
  CodexUserInputAutoResolutionEntry,
} from "../../../shared/codex-user-input-auto-resolution";
import type { CodexProtocolRequestId } from "@/lib/types";
import { clearCodexUserInputDraft, clearCodexUserInputSecretDraft } from "./user-input-draft-state";

const entries = new Map<string, CodexUserInputAutoResolutionEntry>();
const listeners = new Set<() => void>();
let stopSubscription: (() => void) | null = null;
let hydrationPromise: Promise<void> | null = null;

function buildKey(
  hostId: string,
  conversationId: string,
  requestId: CodexProtocolRequestId,
): string {
  return JSON.stringify([hostId, conversationId, buildCodexCanonicalRequestIdentityKey(requestId)]);
}

function notify(): void {
  for (const listener of listeners) listener();
}

function applyChange(change: CodexUserInputAutoResolutionChange): void {
  if (change.type === "updated") {
    entries.set(
      buildKey(change.entry.hostId, change.entry.conversationId, change.entry.requestId),
      change.entry,
    );
    notify();
    return;
  }

  entries.delete(buildKey(change.hostId, change.conversationId, change.requestId));
  if (change.type === "timedOut" || change.reason === "responded" || change.reason === "resolved")
    clearCodexUserInputDraft(change.conversationId, change.requestId, change.hostId);
  else if (change.reason === "disconnected" || change.reason === "disposed")
    clearCodexUserInputSecretDraft(change.conversationId, change.requestId, change.hostId);
  notify();
}

function ensureStarted(): void {
  if (stopSubscription) return;
  let changedDuringHydration: Set<string> | null = new Set<string>();
  stopSubscription = subscribeUserInputAutoResolutionChanges((change) => {
    const key =
      change.type === "updated"
        ? buildKey(change.entry.hostId, change.entry.conversationId, change.entry.requestId)
        : buildKey(change.hostId, change.conversationId, change.requestId);
    changedDuringHydration?.add(key);
    applyChange(change);
  });
  hydrationPromise = getUserInputAutoResolutionSnapshot()
    .then((snapshot) => {
      for (const entry of snapshot) {
        const key = buildKey(entry.hostId, entry.conversationId, entry.requestId);
        if (changedDuringHydration?.has(key)) continue;
        entries.set(key, entry);
      }
      notify();
    })
    .catch(() => undefined)
    .finally(() => {
      changedDuringHydration = null;
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureStarted();
  return () => {
    listeners.delete(listener);
  };
}

const subscribeDisabled = (): (() => void) => () => {};
const getDisabledSnapshot = (): null => null;

export function useUserInputAutoResolution(
  conversationId: string,
  requestId: CodexProtocolRequestId,
  hostId = "local",
  enabled = true,
): CodexUserInputAutoResolutionEntry | null {
  const key = buildKey(hostId, conversationId, requestId);
  const entry = useSyncExternalStore(
    enabled ? subscribe : subscribeDisabled,
    enabled ? () => entries.get(key) ?? null : getDisabledSnapshot,
    () => null,
  );

  useEffect(() => {
    if (!enabled) return;
    ensureStarted();
    void hydrationPromise;
  }, [enabled]);

  return entry;
}

export async function recordUserInputActivity(
  conversationId: string,
  hostId = "local",
): Promise<void> {
  await recordUserInputAutoResolutionActivity({ hostId, conversationId });
}

export async function snoozeUserInput(
  conversationId: string,
  requestId: CodexProtocolRequestId,
  hostId = "local",
): Promise<boolean> {
  return await snoozeUserInputAutoResolution({
    hostId,
    conversationId,
    requestId,
  });
}

export async function isUserInputAutoResolutionTracked(
  conversationId: string,
  requestId: CodexProtocolRequestId,
  hostId = "local",
): Promise<boolean> {
  const key = buildKey(hostId, conversationId, requestId);
  const snapshot = await getUserInputAutoResolutionSnapshot();
  return snapshot.some(
    (entry) => buildKey(entry.hostId, entry.conversationId, entry.requestId) === key,
  );
}

export function resetUserInputAutoResolutionStateForTests(): void {
  stopSubscription?.();
  stopSubscription = null;
  hydrationPromise = null;
  entries.clear();
  listeners.clear();
}
