import {
  createComposerDraftTransfer,
  type ComposerCompletedDraftSnapshot,
  type ComposerDraftTransfer,
} from "./composer-draft-state";
import type { PreparedComposerDraftTransfer } from "./composer-draft-transfer-attachments";

export interface ComposerDraftCaptureTarget {
  readonly threadId: string;
  readonly composerScopeIdentity: string;
}

export interface ComposerDraftCaptureBlocked {
  readonly status: "blocked";
  readonly reason:
    | "unavailable"
    | "busy"
    | "draft-loading"
    | "draft-error"
    | "pending-attachments"
    | "attachment-error"
    | "changed";
  readonly message: string;
}

export type ComposerDraftCaptureResult =
  | ComposerDraftCaptureBlocked
  | { readonly status: "ready"; readonly snapshot: ComposerCompletedDraftSnapshot };

interface ComposerDraftCaptureOwner {
  readonly read: () => ComposerDraftCaptureResult;
  readonly prepare?: (transfer: ComposerDraftTransfer) => Promise<PreparedComposerDraftTransfer>;
  readonly persist: (transfer: ComposerDraftTransfer) => Promise<void>;
}

export interface ComposerDraftCaptureLease {
  capture(): ComposerDraftCaptureResult;
  persistTransfer(targetConversationId: string): Promise<ComposerDraftTransfer>;
  commitTransfer(transfer: ComposerDraftTransfer): void;
  release(): Promise<void>;
}

interface Registration {
  readonly owner: ComposerDraftCaptureOwner;
  lease: object | null;
}

const registrations = new Map<string, Registration>();
const listeners = new Map<string, Set<() => void>>();

function targetKey(target: ComposerDraftCaptureTarget): string {
  return JSON.stringify([target.threadId.trim(), target.composerScopeIdentity.trim()]);
}

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

/** A mounted Composer owns its snapshot. The registry retains only its addressed capability. */
export function registerComposerDraftCapture(
  target: ComposerDraftCaptureTarget,
  owner: ComposerDraftCaptureOwner,
): () => void {
  const key = targetKey(target);
  const registration: Registration = { owner, lease: null };
  registrations.set(key, registration);
  notify(key);
  return () => {
    if (registrations.get(key) !== registration) return;
    registrations.delete(key);
    notify(key);
  };
}

export function subscribeComposerDraftCapture(
  target: ComposerDraftCaptureTarget,
  listener: () => void,
): () => void {
  const key = targetKey(target);
  const subscribers = listeners.get(key) ?? new Set();
  subscribers.add(listener);
  listeners.set(key, subscribers);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) listeners.delete(key);
  };
}

export function isComposerDraftCaptureLocked(target: ComposerDraftCaptureTarget): boolean {
  return registrations.get(targetKey(target))?.lease != null;
}

/** Freezes one exact mounted draft; failed saves release the lease without clearing its source. */
export function acquireComposerDraftCapture(
  target: ComposerDraftCaptureTarget,
):
  | ComposerDraftCaptureBlocked
  | { readonly status: "ready"; readonly lease: ComposerDraftCaptureLease } {
  const key = targetKey(target);
  const registration = registrations.get(key);
  const unavailable: ComposerDraftCaptureBlocked = {
    status: "blocked",
    reason: "unavailable",
    message: "This conversation's draft is unavailable. Open it and try again.",
  };
  if (!registration) return unavailable;
  if (registration.lease)
    return { status: "blocked", reason: "busy", message: "This draft is already being saved." };
  const initial = registration.owner.read();
  if (initial.status === "blocked") return initial;
  const token = {};
  let persistedSnapshot: string | null = null;
  const unpublished = new Map<string, PreparedComposerDraftTransfer>();
  registration.lease = token;
  notify(key);
  const capture = (): ComposerDraftCaptureResult => {
    if (registrations.get(key) !== registration || registration.lease !== token) return unavailable;
    const current = registration.owner.read();
    if (current.status === "blocked") return current;
    if (persistedSnapshot !== null && JSON.stringify(current.snapshot) !== persistedSnapshot) {
      return {
        status: "blocked",
        reason: "changed",
        message: "The draft changed while saving. Save it again before closing this conversation.",
      };
    }
    return current;
  };
  return {
    status: "ready",
    lease: {
      capture,
      async persistTransfer(targetConversationId) {
        const current = capture();
        if (current.status === "blocked") throw new Error(current.message);
        const snapshot = JSON.stringify(current.snapshot);
        const transfer = createComposerDraftTransfer(targetConversationId, current.snapshot);
        const prepared = registration.owner.prepare
          ? await registration.owner.prepare(transfer)
          : { transfer, discard: async () => {} };
        try {
          const ready = capture();
          if (ready.status === "blocked") throw new Error(ready.message);
          await registration.owner.persist(prepared.transfer);
          persistedSnapshot = snapshot;
          const persisted = capture();
          if (persisted.status === "blocked") throw new Error(persisted.message);
          unpublished.set(prepared.transfer.transferId, prepared);
          return prepared.transfer;
        } catch (error) {
          await prepared.discard();
          throw error;
        }
      },
      commitTransfer(transfer) {
        if (unpublished.get(transfer.transferId)?.transfer !== transfer)
          throw new Error("This draft transfer is no longer available");
        unpublished.delete(transfer.transferId);
      },
      async release() {
        if (registration.lease !== token) return;
        registration.lease = null;
        if (registrations.get(key) === registration) notify(key);
        const pending = [...unpublished.values()];
        unpublished.clear();
        await Promise.all(pending.map((prepared) => prepared.discard()));
      },
    },
  };
}
