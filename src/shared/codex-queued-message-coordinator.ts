export type QueuedMessageState<Message> = Readonly<Record<string, readonly Message[]>>;
export type QueuedMessageRole =
  | { role: "owner" }
  | { role: "follower"; ownerClientId: string }
  | null;
export interface QueuedMessageStorage<Message> {
  read(): { isLoading: boolean; value?: QueuedMessageState<Message> };
  load(): Promise<QueuedMessageState<Message>>;
  update(
    recipe: (state: QueuedMessageState<Message>) => QueuedMessageState<Message>,
  ): Promise<void>;
}
export interface QueuedMessageCoordinatorClient<Message> {
  storage: QueuedMessageStorage<Message>;
  role(conversationId: string): QueuedMessageRole;
  validate(messages: readonly Message[]): void;
  requestFollower(
    conversationId: string,
    state: QueuedMessageState<Message>,
    ownerClientId: string,
  ): Promise<void>;
  broadcast(conversationId: string, messages: readonly Message[]): Promise<void>;
  changed(conversationId: string | null): void;
  wake(conversationId: string): void;
  error(operation: string, error: unknown): void;
}
interface Pending<Message> {
  count: number;
  committedMessages: readonly Message[] | undefined;
  broadcast: { sourceClientId: string; messages: readonly Message[] } | undefined;
}
const EMPTY: readonly never[] = [];
/** Queue documents use independent peer broadcasts, never conversation patch acknowledgements. */
export class QueuedMessageCoordinator<Message> implements Disposable {
  private readonly messages = new Map<
    string,
    { messages: readonly Message[]; refreshing: boolean }
  >();
  private readonly pending = new Map<string, Pending<Message>>();
  private loadedState: QueuedMessageState<Message> | undefined;
  private loading: Promise<void> | undefined;
  private pendingWrites: Promise<unknown> = Promise.resolve();
  private refresh: Promise<void> | undefined;
  private refreshRequested: "storage-change" | "execution-wake" | undefined;
  private disposed = false;
  constructor(private readonly client: QueuedMessageCoordinatorClient<Message>) {}
  readMessages(conversationId: string): readonly Message[] | undefined {
    const overlay = this.messages.get(conversationId);
    if (overlay) return overlay.messages;
    const storage = this.client.storage.read();
    const state = storage.isLoading ? this.loadedState : storage.value;
    if (storage.isLoading && state == null) return undefined;
    return state?.[conversationId] ?? EMPTY;
  }
  readState(): QueuedMessageState<Message> | undefined {
    const storage = this.client.storage.read();
    const state = storage.isLoading ? this.loadedState : storage.value;
    if (storage.isLoading && state == null) return undefined;
    const result = { ...state };
    for (const [id, { messages }] of this.messages) {
      if (!messages.length) delete result[id];
      else result[id] = messages;
    }
    return result;
  }
  async loadMessages(conversationId: string): Promise<void> {
    if (this.disposed) return;
    if (this.readMessages(conversationId) == null) await this.load();
    if (!this.disposed) this.notify(conversationId);
  }
  private load(): Promise<void> {
    if (this.loading) return this.loading;
    const loading = this.client.storage
      .load()
      .then((state) => {
        if (!this.disposed && this.loading === loading) this.loadedState = state;
      })
      .catch((error: unknown) => {
        if (this.loading === loading) this.loading = undefined;
        throw error;
      });
    this.loading = loading;
    return loading;
  }
  mutate(
    conversationId: string,
    recipe: (messages: readonly Message[]) => readonly Message[],
  ): void {
    if (this.disposed) return;
    if (this.readMessages(conversationId) == null) {
      void this.load()
        .then(() => {
          if (!this.disposed) this.mutate(conversationId, recipe);
        })
        .catch((error: unknown) => this.client.error("load", error));
      return;
    }
    void this.write(conversationId, recipe, false).catch((error: unknown) =>
      this.client.error("update", error),
    );
  }
  acceptFromFollower(
    conversationId: string,
    messages: readonly Message[],
  ): Promise<readonly Message[]> {
    return this.write(conversationId, () => messages, true);
  }
  update(
    conversationId: string,
    recipe: (messages: readonly Message[]) => readonly Message[],
  ): Promise<readonly Message[]> {
    return this.write(conversationId, recipe, false);
  }
  receiveBroadcast(
    sourceClientId: string,
    conversationId: string,
    messages: readonly Message[],
  ): void {
    const role = this.client.role(conversationId);
    if (this.disposed || role?.role !== "follower" || role.ownerClientId !== sourceClientId) return;
    const pending = this.pending.get(conversationId);
    if (pending) {
      pending.broadcast = { sourceClientId, messages };
      return;
    }
    this.install(conversationId, messages);
  }
  private write(
    conversationId: string,
    recipe: (messages: readonly Message[]) => readonly Message[],
    requireOwner: boolean,
  ): Promise<readonly Message[]> {
    if (this.disposed) return Promise.reject(new Error("Queued message coordinator retired"));
    let before = this.readMessages(conversationId) ?? EMPTY;
    let next = recipe(before);
    this.client.validate(next);
    const pending = this.pending.get(conversationId) ?? {
      count: 0,
      committedMessages: this.messages.get(conversationId)?.messages,
      broadcast: undefined,
    };
    pending.count++;
    this.pending.set(conversationId, pending);
    this.install(conversationId, next);
    const write = this.pendingWrites.then(async () => {
      if (this.disposed) throw new Error("Queued message coordinator retired");
      const broadcast = pending.broadcast;
      const role = this.client.role(conversationId);
      if (requireOwner && role?.role !== "owner")
        throw new Error("This window no longer owns the thread");
      if (role?.role === "follower")
        await this.client.requestFollower(
          conversationId,
          { [conversationId]: next },
          role.ownerClientId,
        );
      else {
        await this.client.storage.update((state) => {
          before = state[conversationId] ?? EMPTY;
          next = recipe(before);
          this.client.validate(next);
          const result = { ...state };
          if (!next.length) delete result[conversationId];
          else result[conversationId] = next;
          return result;
        });
        if (!this.disposed && this.client.role(conversationId)?.role === "owner")
          void this.client
            .broadcast(conversationId, next)
            .catch((error: unknown) => this.client.error("broadcast", error));
      }
      pending.committedMessages = next;
      if (pending.broadcast === broadcast) pending.broadcast = undefined;
    });
    this.pendingWrites = write.catch(() => {});
    return write
      .then(() => before)
      .finally(() => {
        if (--pending.count !== 0) return;
        this.pending.delete(conversationId);
        if (this.disposed) return;
        const role = this.client.role(conversationId);
        const messages =
          role?.role === "follower" && role.ownerClientId === pending.broadcast?.sourceClientId
            ? pending.broadcast.messages
            : pending.committedMessages;
        if (this.messages.get(conversationId)?.messages !== messages) {
          if (messages === undefined) {
            this.messages.delete(conversationId);
            this.notify(conversationId);
          } else this.install(conversationId, messages);
        }
        if (role?.role !== "follower") this.storageChanged();
      });
  }
  storageChanged(): void {
    if (this.disposed) return;
    const overlays = [...this.messages].filter(
      ([id]) => !this.pending.has(id) && this.client.role(id)?.role !== "follower",
    );
    for (const [, overlay] of overlays) overlay.refreshing = true;
    this.client.changed(null);
    if (this.refresh) {
      this.refreshRequested = "storage-change";
      return;
    }
    if (!overlays.length) {
      this.wakeLoaded();
      return;
    }
    const refresh = this.client.storage
      .load()
      .then((state) => {
        if (this.disposed || this.refresh !== refresh || this.refreshRequested === "storage-change")
          return;
        this.refreshRequested = undefined;
        this.loadedState = state;
        this.loading = Promise.resolve();
        for (const [id, overlay] of overlays) {
          if (
            this.messages.get(id) === overlay &&
            !this.pending.has(id) &&
            this.client.role(id)?.role !== "follower"
          )
            this.messages.set(id, { messages: state[id] ?? EMPTY, refreshing: false });
        }
        this.client.changed(null);
        this.wakeLoaded();
      })
      .catch((error: unknown) => {
        if (!this.disposed) this.client.error("refresh", error);
      })
      .finally(() => {
        if (this.refresh !== refresh) return;
        this.refresh = undefined;
        if (this.refreshRequested) {
          this.refreshRequested = undefined;
          this.storageChanged();
        }
      });
    this.refresh = refresh;
  }
  requestExecutionWake(): void {
    if (this.disposed) return;
    if (this.refresh) {
      this.refreshRequested ??= "execution-wake";
      return;
    }
    this.storageChanged();
  }
  isPending(conversationId: string): boolean {
    return this.pending.has(conversationId);
  }
  isRefreshing(conversationId: string): boolean {
    return this.messages.get(conversationId)?.refreshing === true;
  }
  /** Capture an explicit send only after all active storage refreshes have settled. */
  async waitForRefresh(): Promise<void> {
    while (this.refresh) await this.refresh;
  }
  private wakeLoaded(): void {
    for (const id of Object.keys(this.readState() ?? {})) this.client.wake(id);
  }
  private install(conversationId: string, messages: readonly Message[]): void {
    this.messages.set(conversationId, { messages, refreshing: false });
    this.notify(conversationId);
  }
  private notify(conversationId: string): void {
    this.client.changed(conversationId);
    this.client.wake(conversationId);
  }
  /** Let accepted queue edits reach storage before the window's IPC handlers retire. */
  async flushPendingWrites(): Promise<void> {
    for (;;) {
      const loading = this.loading;
      const writes = this.pendingWrites;
      await loading;
      await writes;
      if (loading === this.loading && writes === this.pendingWrites) return;
    }
  }
  [Symbol.dispose](): void {
    this.disposed = true;
    this.messages.clear();
    this.pending.clear();
    this.loadedState = undefined;
    this.refresh = undefined;
    this.refreshRequested = undefined;
  }
}
