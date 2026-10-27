import { useSyncExternalStore } from "react";
import type { AppSummary } from "@nodex/codex-app-server-protocol/v2/AppSummary";
import type { PluginRow } from "../plugin-management";

/**
 * Installs and uninstalls running in this window, keyed by a plugin's stable identity. Every
 * surface showing the plugin reflects the same pending action, and new installs wait while
 * another is running.
 */
export type PluginPendingAction = "installing" | "uninstalling";

const pending = new Map<string, PluginPendingAction>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, PluginPendingAction> = new Map();

function publish() {
  snapshot = new Map(pending);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function beginPluginAction(identity: string, action: PluginPendingAction): () => void {
  pending.set(identity, action);
  publish();
  return () => {
    if (pending.get(identity) !== action) return;
    pending.delete(identity);
    publish();
  };
}

export function usePendingPluginActions(): ReadonlyMap<string, PluginPendingAction> {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** A just-installed plugin whose apps can be connected now, shown once over Customize. */
export interface PluginAppsOnboarding {
  readonly row: PluginRow;
  readonly apps: readonly AppSummary[];
  /** The starter prompt the install began from, for Try now. */
  readonly prompt?: string | null;
}

let onboarding: PluginAppsOnboarding | null = null;
const onboardingListeners = new Set<() => void>();

function setOnboarding(next: PluginAppsOnboarding | null) {
  onboarding = next;
  for (const listener of onboardingListeners) listener();
}

export function showPluginAppsOnboarding(session: PluginAppsOnboarding): void {
  setOnboarding(session);
}

export function closePluginAppsOnboarding(): void {
  setOnboarding(null);
}

export function usePluginAppsOnboarding(): PluginAppsOnboarding | null {
  return useSyncExternalStore(
    (listener) => {
      onboardingListeners.add(listener);
      return () => onboardingListeners.delete(listener);
    },
    () => onboarding,
  );
}
