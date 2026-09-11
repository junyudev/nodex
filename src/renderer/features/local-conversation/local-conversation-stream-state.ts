import type { CodexThreadStreamCheckpoint } from "../../../shared/types";
import { areCodexThreadStreamCheckpointsEqual } from "../../../shared/codex-owner-follower-replication";

export type LocalConversationStreamRole =
  | { role: "owner" }
  | { role: "follower"; ownerClientId: string };

export type LocalConversationPatchDecision =
  | { type: "apply"; sourceClientId: string }
  | { type: "drop"; reason: "missing-follower-role" }
  | {
      type: "resync";
      reason:
        | "owner-mismatch"
        | "owner-epoch-mismatch"
        | "revision-gap"
        | "base-checkpoint-mismatch";
    };

export type LocalConversationSnapshotDecision =
  | { type: "apply" }
  | { type: "drop"; reason: "owner-role" | "stale-snapshot" }
  | {
      type: "resync";
      reason: "owner-mismatch" | "owner-epoch-mismatch";
    };

type StreamStateTimer = unknown;

interface RevisionWaiter {
  conversationId: string;
  ownerClientId: string | null;
  targetRevision: number;
  timeout: StreamStateTimer;
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface LocalConversationStreamStateOptions {
  setTimeout?: (callback: () => void, ms: number) => StreamStateTimer;
  clearTimeout?: (timer: StreamStateTimer) => void;
}

function scheduleTimeout(callback: () => void, ms: number): StreamStateTimer {
  return setTimeout(callback, ms);
}

function clearScheduledTimeout(timer: StreamStateTimer): void {
  clearTimeout(timer as ReturnType<typeof setTimeout>);
}

function formatOwner(ownerClientId: string | null): string {
  return ownerClientId ?? "unknown-owner";
}

function buildSnapshotRole(sourceClientId: string): LocalConversationStreamRole {
  return { role: "follower", ownerClientId: sourceClientId };
}

export class LocalConversationStreamState {
  private readonly streamingConversationIds = new Set<string>();
  private readonly followedConversationIds = new Set<string>();
  private readonly rolesByConversationId = new Map<string, LocalConversationStreamRole>();
  private readonly checkpointByConversationId = new Map<string, CodexThreadStreamCheckpoint>();
  private readonly waitersByConversationId = new Map<string, Set<RevisionWaiter>>();
  private readonly setTimeoutFn: (callback: () => void, ms: number) => StreamStateTimer;
  private readonly clearTimeoutFn: (timer: StreamStateTimer) => void;

  constructor(options: LocalConversationStreamStateOptions = {}) {
    this.setTimeoutFn = options.setTimeout ?? scheduleTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? clearScheduledTimeout;
  }

  getRole(conversationId: string): LocalConversationStreamRole | null {
    return this.rolesByConversationId.get(conversationId) ?? null;
  }

  getRevision(conversationId: string): number | null {
    return this.checkpointByConversationId.get(conversationId)?.revision ?? null;
  }

  getCheckpoint(conversationId: string): CodexThreadStreamCheckpoint | null {
    return this.checkpointByConversationId.get(conversationId) ?? null;
  }

  getStreamingConversationIds(): string[] {
    return [...this.streamingConversationIds];
  }

  isConversationFollowing(conversationId: string): boolean {
    return this.followedConversationIds.has(conversationId);
  }

  getFollowedConversationIds(): string[] {
    return [...this.followedConversationIds];
  }

  setConversationFollowing(conversationId: string, following: boolean): void {
    if (following) {
      this.followedConversationIds.add(conversationId);
      return;
    }

    this.followedConversationIds.delete(conversationId);
    const role = this.rolesByConversationId.get(conversationId);
    if (role?.role !== "follower") return;
    this.rolesByConversationId.delete(conversationId);
    this.checkpointByConversationId.delete(conversationId);
    this.rejectWaitersForConversation(
      conversationId,
      new Error(`Conversation ${conversationId} is no longer followed`),
    );
  }

  setStreaming(conversationId: string, streaming: boolean): void {
    if (streaming) {
      this.streamingConversationIds.add(conversationId);
      return;
    }

    this.streamingConversationIds.delete(conversationId);
  }

  markOwner(conversationId: string, checkpoint?: CodexThreadStreamCheckpoint | null): void {
    this.setRole(conversationId, { role: "owner" });
    if (checkpoint) {
      this.checkpointByConversationId.set(conversationId, checkpoint);
    }
  }

  recordOwnerCheckpoint(conversationId: string, checkpoint: CodexThreadStreamCheckpoint): void {
    const role = this.rolesByConversationId.get(conversationId);
    if (!role || role.role !== "owner") {
      this.markOwner(conversationId, checkpoint);
      return;
    }

    this.checkpointByConversationId.set(conversationId, checkpoint);
  }

  acceptSnapshot(input: {
    conversationId: string;
    checkpoint: CodexThreadStreamCheckpoint;
    sourceClientId: string;
  }): LocalConversationSnapshotDecision {
    const currentRole = this.rolesByConversationId.get(input.conversationId);
    const currentCheckpoint = this.checkpointByConversationId.get(input.conversationId);
    if (currentRole?.role === "owner") {
      return { type: "drop", reason: "owner-role" };
    }
    if (currentRole?.role === "follower" && currentCheckpoint) {
      if (currentRole.ownerClientId !== input.sourceClientId) {
        if (input.checkpoint.ownerEpoch <= currentCheckpoint.ownerEpoch) {
          return { type: "resync", reason: "owner-mismatch" };
        }
      } else if (input.checkpoint.ownerEpoch < currentCheckpoint.ownerEpoch) {
        return { type: "drop", reason: "stale-snapshot" };
      } else if (input.checkpoint.ownerEpoch === currentCheckpoint.ownerEpoch) {
        if (input.checkpoint.revision < currentCheckpoint.revision) {
          return { type: "drop", reason: "stale-snapshot" };
        }
      }
    }
    this.setRole(input.conversationId, buildSnapshotRole(input.sourceClientId));
    this.checkpointByConversationId.set(input.conversationId, input.checkpoint);
    this.resolveSatisfiedWaiters(input.conversationId);
    return { type: "apply" };
  }

  adoptFollowerBaseline(input: {
    conversationId: string;
    checkpoint: CodexThreadStreamCheckpoint;
    sourceClientId: string;
  }): void {
    this.setRole(input.conversationId, buildSnapshotRole(input.sourceClientId));
    this.checkpointByConversationId.set(input.conversationId, input.checkpoint);
    this.resolveSatisfiedWaiters(input.conversationId);
  }

  evaluatePatch(input: {
    conversationId: string;
    baseCheckpoint: CodexThreadStreamCheckpoint;
    checkpoint: CodexThreadStreamCheckpoint;
    sourceClientId: string;
  }): LocalConversationPatchDecision {
    const role = this.rolesByConversationId.get(input.conversationId);
    if (!role || role.role === "owner") {
      return { type: "drop", reason: "missing-follower-role" };
    }

    if (role.ownerClientId !== input.sourceClientId) {
      return { type: "resync", reason: "owner-mismatch" };
    }

    const currentCheckpoint = this.checkpointByConversationId.get(input.conversationId);
    if (!currentCheckpoint) {
      return { type: "resync", reason: "revision-gap" };
    }
    if (
      currentCheckpoint.ownerEpoch !== input.baseCheckpoint.ownerEpoch ||
      input.checkpoint.ownerEpoch !== input.baseCheckpoint.ownerEpoch
    ) {
      return { type: "resync", reason: "owner-epoch-mismatch" };
    }
    if (
      currentCheckpoint.revision !== input.baseCheckpoint.revision ||
      input.checkpoint.revision !== input.baseCheckpoint.revision + 1
    ) {
      return { type: "resync", reason: "revision-gap" };
    }
    if (!areCodexThreadStreamCheckpointsEqual(currentCheckpoint, input.baseCheckpoint)) {
      return { type: "resync", reason: "base-checkpoint-mismatch" };
    }

    return { type: "apply", sourceClientId: input.sourceClientId };
  }

  acceptPatch(input: {
    conversationId: string;
    checkpoint: CodexThreadStreamCheckpoint;
    sourceClientId: string;
  }): void {
    this.setRole(input.conversationId, buildSnapshotRole(input.sourceClientId));
    this.checkpointByConversationId.set(input.conversationId, input.checkpoint);
    this.resolveSatisfiedWaiters(input.conversationId);
  }

  waitForRevision(input: {
    conversationId: string;
    ownerClientId: string | null;
    revision: number;
    timeoutMs: number;
  }): Promise<void> {
    const role = this.rolesByConversationId.get(input.conversationId);
    if (!role || role.role !== "follower" || role.ownerClientId !== input.ownerClientId) {
      return Promise.reject(
        new Error(
          `Cannot wait for ${input.conversationId} revision ${input.revision} from ${formatOwner(input.ownerClientId)} because that owner is not active`,
        ),
      );
    }

    const currentRevision =
      this.checkpointByConversationId.get(input.conversationId)?.revision ?? 0;
    if (currentRevision >= input.revision) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const waiter: RevisionWaiter = {
        conversationId: input.conversationId,
        ownerClientId: input.ownerClientId,
        targetRevision: input.revision,
        timeout: null,
        resolve,
        reject,
      };
      waiter.timeout = this.setTimeoutFn(() => {
        this.removeWaiter(waiter);
        reject(
          new Error(
            `Timed out waiting for ${input.conversationId} revision ${input.revision} from ${formatOwner(input.ownerClientId)}`,
          ),
        );
      }, input.timeoutMs);

      this.addWaiter(waiter);
    });
  }

  markOwnerUnavailable(ownerClientId: string): string[] {
    const affectedConversationIds: string[] = [];
    for (const [conversationId, role] of this.rolesByConversationId.entries()) {
      if (role.role !== "follower" || role.ownerClientId !== ownerClientId) {
        continue;
      }

      affectedConversationIds.push(conversationId);
      this.rolesByConversationId.delete(conversationId);
      this.checkpointByConversationId.delete(conversationId);
      this.rejectWaitersForConversation(
        conversationId,
        new Error(`Owner ${formatOwner(ownerClientId)} is unavailable`),
      );
    }
    return affectedConversationIds;
  }

  handleTransportReset(conversationIds?: readonly string[]): string[] {
    const requestedConversationIds = conversationIds?.length ? new Set(conversationIds) : null;
    const affectedConversationIds = [...this.followedConversationIds].filter(
      (conversationId) =>
        requestedConversationIds === null || requestedConversationIds.has(conversationId),
    );
    for (const conversationId of affectedConversationIds) {
      this.rolesByConversationId.delete(conversationId);
      this.checkpointByConversationId.delete(conversationId);
      this.rejectWaitersForConversation(
        conversationId,
        new Error(`Stream transport was reset for ${conversationId}`),
      );
    }
    return affectedConversationIds;
  }

  removeConversation(conversationId: string): void {
    this.streamingConversationIds.delete(conversationId);
    this.followedConversationIds.delete(conversationId);
    this.rolesByConversationId.delete(conversationId);
    this.checkpointByConversationId.delete(conversationId);
    this.rejectWaitersForConversation(
      conversationId,
      new Error(`Conversation ${conversationId} was removed`),
    );
  }

  reset(): void {
    for (const conversationId of [...this.waitersByConversationId.keys()]) {
      this.rejectWaitersForConversation(conversationId, new Error("Stream state was reset"));
    }
    this.streamingConversationIds.clear();
    this.followedConversationIds.clear();
    this.rolesByConversationId.clear();
    this.checkpointByConversationId.clear();
  }

  private setRole(conversationId: string, nextRole: LocalConversationStreamRole): void {
    const previousRole = this.rolesByConversationId.get(conversationId) ?? null;
    this.rolesByConversationId.set(conversationId, nextRole);
    if (areRolesCompatible(previousRole, nextRole)) {
      return;
    }

    this.rejectWaitersForConversation(
      conversationId,
      new Error(`Stream owner changed for ${conversationId}`),
    );
  }

  private addWaiter(waiter: RevisionWaiter): void {
    let waiters = this.waitersByConversationId.get(waiter.conversationId);
    if (!waiters) {
      waiters = new Set<RevisionWaiter>();
      this.waitersByConversationId.set(waiter.conversationId, waiters);
    }
    waiters.add(waiter);
  }

  private removeWaiter(waiter: RevisionWaiter): void {
    const waiters = this.waitersByConversationId.get(waiter.conversationId);
    if (!waiters) return;

    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.waitersByConversationId.delete(waiter.conversationId);
    }
  }

  private resolveSatisfiedWaiters(conversationId: string): void {
    const waiters = this.waitersByConversationId.get(conversationId);
    if (!waiters) return;

    const role = this.rolesByConversationId.get(conversationId) ?? null;
    const revision = this.checkpointByConversationId.get(conversationId)?.revision ?? 0;
    for (const waiter of [...waiters]) {
      if (!role || role.role !== "follower" || role.ownerClientId !== waiter.ownerClientId) {
        this.rejectWaiter(waiter, new Error(`Stream owner changed for ${conversationId}`));
        continue;
      }
      if (revision < waiter.targetRevision) continue;

      this.resolveWaiter(waiter);
    }
  }

  private rejectWaitersForConversation(conversationId: string, error: Error): void {
    const waiters = this.waitersByConversationId.get(conversationId);
    if (!waiters) return;

    for (const waiter of [...waiters]) {
      this.rejectWaiter(waiter, error);
    }
  }

  private resolveWaiter(waiter: RevisionWaiter): void {
    this.removeWaiter(waiter);
    this.clearTimeoutFn(waiter.timeout);
    waiter.resolve();
  }

  private rejectWaiter(waiter: RevisionWaiter, error: Error): void {
    this.removeWaiter(waiter);
    this.clearTimeoutFn(waiter.timeout);
    waiter.reject(error);
  }
}

function areRolesCompatible(
  previousRole: LocalConversationStreamRole | null,
  nextRole: LocalConversationStreamRole,
): boolean {
  if (!previousRole) return true;
  if (previousRole.role !== nextRole.role) return false;
  if (previousRole.role === "owner") return true;
  if (nextRole.role !== "follower") return false;
  return previousRole.ownerClientId === nextRole.ownerClientId;
}
