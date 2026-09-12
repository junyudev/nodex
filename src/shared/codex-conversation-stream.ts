/** A manager's local stream state. The transport routes messages without accepting revisions. */
export type ConversationStreamRole =
  | { role: "owner" }
  | { role: "follower"; ownerClientId: string };

export type ConversationStreamChange<Document, Patch, TextChange> =
  | { type: "snapshot"; revision: number; conversationState: Document }
  | {
      type: "patches";
      baseRevision: number;
      revision: number;
      patches: readonly Patch[];
      acceptedTextChanges?: readonly TextChange[];
    };

export interface ConversationStreamTransport<Document, Patch, TextChange> {
  sendState(
    conversationId: string,
    hostId: string,
    targetClientIds: readonly string[],
    change: ConversationStreamChange<Document, Patch, TextChange>,
  ): Promise<void> | void;
  sendFollowing(
    conversationId: string,
    hostId: string,
    following: boolean,
    targetClientIds?: readonly string[],
  ): Promise<void> | void;
  requestFollowingStatus(conversationId: string, hostId: string): Promise<void> | void;
  setThreadOwnership(
    conversationId: string,
    hostId: string,
    ownsThread: boolean,
  ): Promise<void> | void;
}

export interface ConversationStreamTextChange {
  key: { entityKey: string };
}

export interface ConversationWindowActivity {
  canAcquireThreadStream: boolean;
  routePath: string;
  visibilityState: "visible" | "hidden";
}

export interface ConversationStreamOptions<
  Document,
  Patch,
  TextChange extends ConversationStreamTextChange,
> {
  hostId: string;
  isLocalHost: boolean;
  canHandleOwnerlessDynamicTool(): boolean;
  transport: ConversationStreamTransport<Document, Patch, TextChange>;
  getConversation(conversationId: string): Document | undefined;
  normalizeSnapshot(document: Document): Document;
  applyPatches(document: Document, patches: readonly Patch[]): Document;
  setConversation(
    document: Document,
    details?: {
      patches: readonly Patch[];
      acceptedTranscriptText?: {
        changes: readonly TextChange[];
        turnEntityKeys: ReadonlySet<string>;
      };
    },
  ): void;
  notifyConversation(conversationId: string, patches?: readonly Patch[]): void;
  onRoleChanged(conversationId: string, role: ConversationStreamRole | null): void;
  onFollowersChanged(conversationId: string): void;
  onOwnerUnavailable(conversationId: string, ownerClientId: string): void;
  onError(operation: string, conversationId: string, error: unknown): void;
  schedule(callback: () => void, delayMs: number): () => void;
}

interface RevisionWaiter {
  ownerClientId: string;
  revision: number;
  cancel: () => void;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class ConversationStream<
  Document,
  Patch,
  TextChange extends ConversationStreamTextChange = never,
> {
  private readonly roles = new Map<string, ConversationStreamRole>();
  private readonly revisions = new Map<string, number>();
  private readonly followed = new Set<string>();
  private readonly followers = new Map<string, Set<string>>();
  private readonly pendingReconnect = new Set<string>();
  private readonly waiters = new Map<string, Set<RevisionWaiter>>();
  private cancelReconnectGrace: (() => void) | null = null;
  private readonly windowActivity = new Set<{ activity: ConversationWindowActivity }>();
  private snapshotPublications = 0;
  private snapshotRecipients = 0;
  private patchPublications = 0;
  private patchRecipients = 0;

  constructor(private readonly options: ConversationStreamOptions<Document, Patch, TextChange>) {}

  registerWindowActivity(
    activity: ConversationWindowActivity,
    onChange: () => void,
  ): Disposable & {
    update(activity: ConversationWindowActivity): void;
  } {
    const registration = { activity };
    this.windowActivity.add(registration);
    onChange();
    return {
      update: (next) => {
        if (!this.windowActivity.has(registration)) return;
        registration.activity = next;
        onChange();
      },
      [Symbol.dispose]: () => {
        if (this.windowActivity.delete(registration)) onChange();
      },
    };
  }

  getWindowActivity(): ConversationWindowActivity | undefined {
    let last: ConversationWindowActivity | undefined;
    for (const { activity } of this.windowActivity) {
      if (activity.canAcquireThreadStream) return activity;
      last = activity;
    }
    return last;
  }

  ownsConversationHistoryStream(conversationId: string): boolean {
    return this.getRole(conversationId)?.role === "owner";
  }

  shouldIgnoreThreadMutationAsFollower(method: string, params: object): boolean {
    if (!isThreadMutation(method)) return false;
    const conversationId = getThreadMutationConversationId(params);
    return conversationId !== null && this.getRole(conversationId)?.role === "follower";
  }

  shouldHandleDynamicToolCall(conversationId: string | null): boolean {
    if (conversationId === null) return false;
    const role = this.getRole(conversationId);
    return (
      role?.role === "owner" || (role === null && this.options.canHandleOwnerlessDynamicTool())
    );
  }

  collectSnapshotFields(): Record<string, number> {
    let subscriptions = 0;
    for (const clients of this.followers.values()) subscriptions += clients.size;
    return {
      manager_stream_threads_with_followers: this.followers.size,
      manager_stream_follower_subscriptions: subscriptions,
      manager_stream_snapshot_publications_total: this.snapshotPublications,
      manager_stream_snapshot_recipients_total: this.snapshotRecipients,
      manager_stream_patch_publications_total: this.patchPublications,
      manager_stream_patch_recipients_total: this.patchRecipients,
    };
  }

  getRole(conversationId: string): ConversationStreamRole | null {
    return this.roles.get(conversationId) ?? null;
  }

  getRevision(conversationId: string): number | null {
    return this.revisions.get(conversationId) ?? null;
  }

  getStreamingConversationIds(): string[] {
    return [...this.roles.keys()];
  }

  getFollowedConversationIds(): string[] {
    return [...this.followed];
  }

  getFollowerClientIds(conversationId: string): string[] {
    return [...(this.followers.get(conversationId) ?? [])];
  }

  isFollowing(conversationId: string): boolean {
    return this.followed.has(conversationId);
  }

  hasFollowersOrPendingReconnect(conversationId: string): boolean {
    return this.followers.has(conversationId) || this.pendingReconnect.has(conversationId);
  }

  canBroadcastPatches(conversationId: string): boolean {
    return this.getRole(conversationId)?.role === "owner" && this.followers.has(conversationId);
  }

  setRole(conversationId: string, role: ConversationStreamRole | null): void {
    if (!role) {
      this.deleteRole(conversationId);
      return;
    }
    const previous = this.getRole(conversationId);
    if (equalRoles(previous, role)) return;
    if (previous?.role === "follower") {
      this.rejectWaiters(
        conversationId,
        "no-client-found: thread stream owner changed",
        previous.ownerClientId,
      );
    }
    this.roles.set(conversationId, role);
    this.notifyRole(conversationId);
    if (role.role !== "owner" || this.followers.has(conversationId)) return;
    this.observeSend(
      this.options.transport.requestFollowingStatus(conversationId, this.options.hostId),
      "request-following-status",
      conversationId,
    );
  }

  setFollowing(conversationId: string, following: boolean): void {
    if (this.followed.has(conversationId) === following) return;
    if (following) this.followed.add(conversationId);
    else this.stopFollowing(conversationId);
    this.sendFollowing(conversationId, following);
  }

  receiveFollowingStatusRequest(conversationId: string, sourceClientId: string): void {
    if (!this.followed.has(conversationId)) return;
    this.sendFollowing(conversationId, true, [sourceClientId]);
  }

  receiveFollowing(conversationId: string, sourceClientId: string, following: boolean): void {
    const clients = this.followers.get(conversationId) ?? new Set<string>();
    if (clients.has(sourceClientId) === following) {
      if (following) {
        this.sendSnapshot(conversationId, [sourceClientId], this.getRevision(conversationId) ?? 0);
      }
      return;
    }
    if (!following) {
      clients.delete(sourceClientId);
      if (clients.size === 0) this.followers.delete(conversationId);
      this.options.onFollowersChanged(conversationId);
      return;
    }
    const firstFollower = clients.size === 0;
    clients.add(sourceClientId);
    this.followers.set(conversationId, clients);
    this.options.onFollowersChanged(conversationId);
    if (firstFollower) {
      this.broadcastSnapshot(conversationId);
      return;
    }
    this.sendSnapshot(conversationId, [sourceClientId], this.getRevision(conversationId) ?? 0);
  }

  broadcastPatches(
    conversationId: string,
    patches: readonly Patch[],
    acceptedTextChanges?: readonly TextChange[],
  ): void {
    if (patches.length === 0 || !this.canBroadcastPatches(conversationId)) return;
    const targetClientIds = this.getFollowerClientIds(conversationId);
    if (targetClientIds.length === 0) return;
    const baseRevision = this.getRevision(conversationId) ?? 0;
    const revision = baseRevision + 1;
    this.revisions.set(conversationId, revision);
    this.patchPublications += 1;
    this.patchRecipients += targetClientIds.length;
    this.observeSend(
      this.options.transport.sendState(conversationId, this.options.hostId, targetClientIds, {
        type: "patches",
        baseRevision,
        revision,
        patches,
        acceptedTextChanges,
      }),
      "send-patches",
      conversationId,
    );
  }

  broadcastSnapshot(conversationId: string): number | null {
    const targetClientIds = this.getFollowerClientIds(conversationId);
    if (targetClientIds.length === 0) return null;
    const revision = (this.getRevision(conversationId) ?? 0) + 1;
    if (!this.sendSnapshot(conversationId, targetClientIds, revision)) return null;
    this.revisions.set(conversationId, revision);
    return revision;
  }

  receiveState(
    conversationId: string,
    sourceClientId: string,
    change: ConversationStreamChange<Document, Patch, TextChange>,
  ): void {
    if (!this.followed.has(conversationId)) return;
    const role = this.getRole(conversationId);
    if (change.type === "snapshot") {
      this.options.setConversation(this.options.normalizeSnapshot(change.conversationState));
      this.revisions.set(conversationId, change.revision);
      this.resolveWaiters(conversationId, sourceClientId, change.revision);
      this.options.notifyConversation(conversationId);
      this.setRole(conversationId, { role: "follower", ownerClientId: sourceClientId });
      return;
    }
    if (
      role?.role !== "follower" ||
      role.ownerClientId !== sourceClientId ||
      this.getRevision(conversationId) !== change.baseRevision
    )
      return;
    const conversation = this.options.getConversation(conversationId);
    if (!conversation) return;
    try {
      this.options.setConversation(this.options.applyPatches(conversation, change.patches), {
        patches: change.patches,
        acceptedTranscriptText:
          change.acceptedTextChanges == null
            ? undefined
            : {
                changes: change.acceptedTextChanges,
                turnEntityKeys: new Set(
                  change.acceptedTextChanges.map((change) => change.key.entityKey),
                ),
              },
      });
      this.revisions.set(conversationId, change.revision);
      this.resolveWaiters(conversationId, sourceClientId, change.revision);
      this.options.notifyConversation(conversationId, change.patches);
    } catch (error) {
      this.options.onError("apply-patches", conversationId, error);
    }
  }

  receiveClientStatus(
    clientId: string,
    status: "connected" | "disconnected",
    isSelf = false,
  ): void {
    if (status === "connected") {
      for (const conversationId of this.followed) {
        this.sendFollowing(conversationId, true, isSelf ? undefined : [clientId]);
      }
      return;
    }
    for (const [conversationId, clients] of this.followers) {
      if (!clients.delete(clientId)) continue;
      if (clients.size === 0) this.followers.delete(conversationId);
      this.options.onFollowersChanged(conversationId);
    }
    for (const [conversationId, role] of this.roles) {
      if (role.role !== "follower" || role.ownerClientId !== clientId) continue;
      this.rejectWaiters(
        conversationId,
        "no-client-found: thread stream owner disconnected",
        clientId,
      );
      this.options.onOwnerUnavailable(conversationId, clientId);
    }
  }

  resetIpcConnection(): void {
    for (const conversationId of this.followers.keys()) this.pendingReconnect.add(conversationId);
    this.followers.clear();
    if (this.pendingReconnect.size === 0) return;
    this.cancelReconnectGrace?.();
    this.cancelReconnectGrace = this.options.schedule(() => {
      const conversationIds = [...this.pendingReconnect];
      this.pendingReconnect.clear();
      this.cancelReconnectGrace = null;
      for (const conversationId of conversationIds) this.options.onFollowersChanged(conversationId);
    }, 5_000);
  }

  resetAfterReconnect(preserveStreams = false): {
    previousStreamingCount: number;
    previousRoleCount: number;
  } {
    const counts = { previousStreamingCount: this.roles.size, previousRoleCount: this.roles.size };
    if (preserveStreams) return counts;
    this.revisions.clear();
    for (const conversationId of this.waiters.keys()) {
      this.rejectWaiters(conversationId, "Conversation stream reset while waiting for history");
    }
    const conversationIds = [...this.roles.keys()];
    this.roles.clear();
    for (const conversationId of conversationIds) this.notifyRole(conversationId);
    return counts;
  }

  waitForRevision(
    conversationId: string,
    ownerClientId: string,
    revision: number,
    timeoutMs: number,
  ): Promise<void> {
    const role = this.getRole(conversationId);
    if (role?.role !== "follower" || role.ownerClientId !== ownerClientId) {
      return Promise.reject(new Error("no-client-found: thread stream owner is unavailable"));
    }
    if ((this.getRevision(conversationId) ?? 0) >= revision) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: RevisionWaiter = {
        ownerClientId,
        revision,
        resolve,
        reject,
        cancel: this.options.schedule(() => {
          this.removeWaiter(conversationId, waiter);
          reject(
            new Error(`stream-revision-timeout: timed out waiting for stream revision ${revision}`),
          );
        }, timeoutMs),
      };
      const waiters = this.waiters.get(conversationId) ?? new Set<RevisionWaiter>();
      waiters.add(waiter);
      this.waiters.set(conversationId, waiters);
    });
  }

  removeConversation(conversationId: string): void {
    if (this.followed.delete(conversationId)) this.sendFollowing(conversationId, false);
    this.followers.delete(conversationId);
    this.pendingReconnect.delete(conversationId);
    this.revisions.delete(conversationId);
    this.rejectWaiters(conversationId, "Conversation was removed while waiting for history");
    this.deleteRole(conversationId);
  }

  dispose(): void {
    this.windowActivity.clear();
    this.cancelReconnectGrace?.();
    this.cancelReconnectGrace = null;
    for (const conversationId of this.waiters.keys()) {
      this.rejectWaiters(
        conversationId,
        "App server manager was disposed while waiting for history",
      );
    }
  }

  private stopFollowing(conversationId: string): void {
    this.followed.delete(conversationId);
    if (this.getRole(conversationId)?.role !== "follower") return;
    this.revisions.delete(conversationId);
    this.rejectWaiters(conversationId, "Conversation is no longer followed");
    this.deleteRole(conversationId);
  }

  private sendFollowing(
    conversationId: string,
    following: boolean,
    targets?: readonly string[],
  ): void {
    this.observeSend(
      this.options.transport.sendFollowing(conversationId, this.options.hostId, following, targets),
      "send-following",
      conversationId,
    );
  }

  private sendSnapshot(
    conversationId: string,
    targets: readonly string[],
    revision: number,
  ): boolean {
    if (this.getRole(conversationId)?.role !== "owner") return false;
    const conversationState = this.options.getConversation(conversationId);
    if (!conversationState) return false;
    this.snapshotPublications += 1;
    this.snapshotRecipients += targets.length;
    this.observeSend(
      this.options.transport.sendState(conversationId, this.options.hostId, targets, {
        type: "snapshot",
        revision,
        conversationState,
      }),
      "send-snapshot",
      conversationId,
    );
    return true;
  }

  private observeSend(
    result: Promise<void> | void,
    operation: string,
    conversationId: string,
  ): void {
    result?.catch((error: unknown) => this.options.onError(operation, conversationId, error));
  }

  private deleteRole(conversationId: string): void {
    if (this.roles.delete(conversationId)) this.notifyRole(conversationId);
  }

  private notifyRole(conversationId: string): void {
    const role = this.getRole(conversationId);
    this.options.onRoleChanged(conversationId, role);
    if (!this.options.isLocalHost) return;
    this.observeSend(
      this.options.transport.setThreadOwnership(
        conversationId,
        this.options.hostId,
        role?.role === "owner",
      ),
      "set-ownership",
      conversationId,
    );
  }

  private removeWaiter(conversationId: string, waiter: RevisionWaiter): void {
    const waiters = this.waiters.get(conversationId);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.waiters.delete(conversationId);
  }

  private resolveWaiters(conversationId: string, ownerClientId: string, revision: number): void {
    for (const waiter of this.waiters.get(conversationId) ?? []) {
      if (waiter.ownerClientId !== ownerClientId || waiter.revision > revision) continue;
      this.removeWaiter(conversationId, waiter);
      waiter.cancel();
      waiter.resolve();
    }
  }

  private rejectWaiters(conversationId: string, message: string, ownerClientId?: string): void {
    for (const waiter of this.waiters.get(conversationId) ?? []) {
      if (ownerClientId !== undefined && waiter.ownerClientId !== ownerClientId) continue;
      this.removeWaiter(conversationId, waiter);
      waiter.cancel();
      waiter.reject(new Error(message));
    }
  }
}

function isThreadMutation(method: string): boolean {
  return (
    method.startsWith("turn/") ||
    method.startsWith("item/") ||
    method === "thread/started" ||
    method === "thread/realtime/itemAdded" ||
    method === "thread/status/changed" ||
    method === "thread/tokenUsage/updated" ||
    method === "error"
  );
}

function getThreadMutationConversationId(params: object): string | null {
  if ("threadId" in params && typeof params.threadId === "string" && params.threadId.length > 0)
    return params.threadId;
  if (!("thread" in params)) return null;
  const thread = params.thread;
  if (thread === null || typeof thread !== "object" || Array.isArray(thread)) return null;
  return "id" in thread && typeof thread.id === "string" && thread.id.length > 0 ? thread.id : null;
}

function equalRoles(left: ConversationStreamRole | null, right: ConversationStreamRole): boolean {
  if (left?.role !== right.role) return false;
  return (
    left.role !== "follower" ||
    right.role !== "follower" ||
    left.ownerClientId === right.ownerClientId
  );
}
