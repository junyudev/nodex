import { createUuidV7 } from "../../../shared/uuid-v7";
import type {
  SurfaceHistoryCapability,
  SurfaceHistoryDirection,
  SurfaceHistorySnapshot,
} from "../../../shared/surface-history";

export type HistoryCommandOutcome<Receipt> =
  | { readonly kind: "committed"; readonly receipt: Receipt }
  | { readonly kind: "rejected"; readonly reason: string; readonly retryable: boolean }
  | { readonly kind: "unknown"; readonly reason: string }
  | { readonly kind: "unrecoverable"; readonly reason: string };

export type HistoryReceiptInterpretation<Inverse> =
  | { readonly kind: "reversible"; readonly inverse: Inverse }
  | { readonly kind: "noop" }
  | { readonly kind: "barrier"; readonly reason: string };

export type HistoryPreparation<Request, Receipt> =
  | { readonly kind: "submit"; readonly request: Request }
  | { readonly kind: "complete"; readonly receipt: Receipt };

export type HistoryCommandResolution<Receipt> =
  | { readonly status: "committed"; readonly receipt: Receipt; readonly entryId: number }
  | { readonly status: "noop" }
  | { readonly status: "rejected" | "recovering" | "blocked"; readonly reason: string };

/** A caller may observe an admitted action, but cannot erase a sent action. */
export interface HistoryCommandHandle<Receipt> {
  readonly accepted: boolean;
  readonly entryId: number | null;
  readonly result: Promise<HistoryCommandResolution<Receipt>>;
}

export interface HistoryContentAdapter<Intent, Request, Receipt, Inverse> {
  describe(intent: Intent): string;
  prepare(intent: Intent): Promise<HistoryPreparation<Request, Receipt>>;
  prepareInverse(inverse: Inverse): Promise<HistoryPreparation<Request, Receipt>>;
  submit(request: Request): Promise<HistoryCommandOutcome<Receipt>>;
  interpret(receipt: Receipt): HistoryReceiptInterpretation<Inverse>;
  /** Opaque native captures need content-owned accounting, not JSON serialization. */
  inverseBytes?(inverse: Inverse): number;
  exceedsReplayBounds?(inverse: Inverse): boolean;
  checkInverse?(
    inverse: Inverse,
  ): Promise<
    | { readonly state: "ready" }
    | { readonly state: "superseded" }
    | { readonly state: "unavailable"; readonly reason: string }
  >;
  replayLocal?(
    inverse: Inverse,
    direction: SurfaceHistoryDirection,
  ): { readonly kind: "committed"; readonly receipt: Receipt } | { readonly kind: "defer" };
  release?(inverse: Inverse, reason: "consumed" | "discarded"): void | Promise<void>;
  /** Retire receipt resources that cannot become a complete retained inverse. */
  discardReceipt?(receipt: Receipt): void | Promise<void>;
  abandon?(request: Request, inverse?: Inverse): Promise<void>;
}

export interface HistoryRetainedEntry<Inverse> {
  readonly entryId: number;
  readonly direction: SurfaceHistoryDirection;
  readonly state: "pending" | "ready" | "blocked";
  readonly inverse: Inverse | undefined;
}

export interface SurfaceHistory<Intent, Receipt, Inverse = unknown> {
  execute(intent: Intent): HistoryCommandHandle<Receipt>;
  /** Records a synchronous local transaction that already committed. Unlike a
   * durable command, local capture must remain available during recovery.
   */
  capture(intent: Intent, receipt: Receipt): HistoryCommandResolution<Receipt>;
  /** Refreshes a still-reachable native capture group without replacing its identity. */
  refreshCapture(entryId: number): boolean;
  retained(): readonly HistoryRetainedEntry<Inverse>[];
  reconcile(input: {
    readonly entryId: number;
    readonly expectedInverse: Inverse;
    readonly state: "superseded" | "unavailable";
    readonly reason?: string;
  }): boolean;
  request(
    direction: SurfaceHistoryDirection,
    targetEntryId?: number,
  ): HistoryCommandHandle<Receipt>;
  recover(): HistoryCommandHandle<Receipt>;
  snapshot(): SurfaceHistorySnapshot;
  subscribe(listener: () => void): () => void;
  setScope(scopeKey: string): void;
  reset(): void;
  close(): void;
  whenIdle(): Promise<void>;
}

interface Limits {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxPending: number;
  readonly maxRequestBytes: number;
  readonly maxRetainedIdentities: number;
}
type EntryState<Inverse> =
  | {
      readonly kind: "pending";
      readonly phase: "preparing" | "submitting" | "recovering";
      readonly inverse?: Inverse;
    }
  | { readonly kind: "ready"; readonly inverse: Inverse }
  | {
      readonly kind: "blocked";
      readonly reason: string;
      readonly retryable: boolean;
      readonly inverse?: Inverse;
    };
interface Entry<Inverse, Adapter> {
  readonly id: number;
  readonly local: boolean;
  readonly label: string;
  state: EntryState<Inverse>;
  bytes: number;
  readonly adapter: Adapter;
}
interface Attempt<Request, Inverse, Adapter> {
  readonly entry: Entry<Inverse, Adapter>;
  readonly direction: "forward" | SurfaceHistoryDirection;
  readonly request: Request;
  readonly bytes: number;
  readonly branch: number;
  readonly originalInverse?: Inverse;
}
interface Job<Receipt> {
  readonly direction: "forward" | SurfaceHistoryDirection;
  readonly run: () => Promise<HistoryCommandResolution<Receipt>>;
  readonly complete: (resolution: HistoryCommandResolution<Receipt>) => void;
  readonly cancel: () => void;
}
interface HistoryScope<Request, Inverse, Receipt, Adapter> {
  readonly key: string;
  readonly generation: number;
  readonly undo: Entry<Inverse, Adapter>[];
  readonly redo: Entry<Inverse, Adapter>[];
  readonly queue: Job<Receipt>[];
  readonly attempts: Map<number, Attempt<Request, Inverse, Adapter>>;
  active: "forward" | SurfaceHistoryDirection | null;
  activeReplay: Pick<Attempt<Request, Inverse, Adapter>, "entry" | "direction" | "branch"> | null;
  uncertain: Attempt<Request, Inverse, Adapter> | null;
  branch: number;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : "The action could not be confirmed.";
const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const emptyCapability: SurfaceHistoryCapability = Object.freeze({
  status: "empty",
  label: null,
  acceptsIntent: false,
  reason: null,
  recoveryActions: [],
});

/** Owns admission, command order, exact attempts and the reachable history interval.
 * Content adapters alone prepare requests and interpret authoritative inverses.
 */
export const createSurfaceHistory = <Intent, Request, Receipt, Inverse>(options: {
  readonly scopeKey: string;
  readonly adapter:
    | HistoryContentAdapter<Intent, Request, Receipt, Inverse>
    | ((intent: Intent) => HistoryContentAdapter<Intent, Request, Receipt, Inverse>);
  readonly limits?: Partial<Limits>;
  readonly retainedIdentityCount?: () => number;
  readonly initialCaptures?: Partial<
    Record<
      SurfaceHistoryDirection,
      readonly { readonly intent: Intent; readonly receipt: Receipt }[]
    >
  >;
  readonly onError?: (error: unknown) => void;
}): SurfaceHistory<Intent, Receipt, Inverse> => {
  type Adapter = HistoryContentAdapter<Intent, Request, Receipt, Inverse>;
  type Slot = Entry<Inverse, Adapter>;
  type FrozenAttempt = Attempt<Request, Inverse, Adapter>;
  const limits: Limits = {
    maxEntries: 50,
    maxBytes: 16 * 1024 * 1024,
    maxPending: 100,
    maxRequestBytes: 32 * 1024 * 1024,
    maxRetainedIdentities: 10_000,
    ...options.limits,
  };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new Error("History limits must be positive safe integers.");
  const ownerId = createUuidV7();
  const makeScope = (
    key: string,
    generation: number,
  ): HistoryScope<Request, Inverse, Receipt, Adapter> => ({
    key,
    generation,
    undo: [],
    redo: [],
    queue: [],
    attempts: new Map(),
    active: null,
    activeReplay: null,
    uncertain: null,
    branch: 0,
  });
  let scope = makeScope(options.scopeKey, 1);
  let sequence = 0;
  let revision = 0;
  let activeCount = 0;
  let requestBytes = 0;
  let closed = false;
  let replayingLocal = false;
  const listeners = new Set<() => void>();
  const releases = new Set<Promise<void>>();
  const idleWaiters = new Set<() => void>();
  const isIdle = () =>
    releases.size === 0 &&
    (closed || (!scope.active && (scope.uncertain !== null || scope.queue.length === 0)));
  const settleIdle = () => {
    if (!isIdle()) return;
    for (const complete of idleWaiters) complete();
    idleWaiters.clear();
  };
  const report = (error: unknown) => options.onError?.(error);
  const retainRelease = (release: void | Promise<void>) => {
    if (!release) return;
    const pending = release.catch(report);
    releases.add(pending);
    void pending.finally(() => {
      releases.delete(pending);
      settleIdle();
    });
  };
  const releaseInverse = (adapter: Adapter, inverse: Inverse, reason: "consumed" | "discarded") => {
    try {
      retainRelease(adapter.release?.(inverse, reason));
    } catch (error) {
      report(error);
    }
  };
  // The opposite gesture can be admitted before a replay receipt moves its
  // entry. Keep its exact frontier and branch; never predict the actual inverse.
  const pendingOppositeEntry = (direction: SurfaceHistoryDirection): Slot | undefined => {
    const replay = scope.activeReplay ?? scope.uncertain;
    const opposite = direction === "undo" ? "redo" : "undo";
    if (
      replay?.direction !== opposite ||
      replay.branch !== scope.branch ||
      !scope[opposite].includes(replay.entry)
    )
      return;
    return replay.entry;
  };
  const capability = (direction: SurfaceHistoryDirection): SurfaceHistoryCapability => {
    if (closed) return emptyCapability;
    const pendingOpposite = pendingOppositeEntry(direction);
    const entry = pendingOpposite ?? scope[direction].at(-1);
    if (!entry) return emptyCapability;
    if (scope.uncertain || pendingOpposite || entry.state.kind === "pending")
      return {
        status: "waiting",
        label: entry.label,
        acceptsIntent: !scope.uncertain,
        reason: scope.uncertain ? "Confirming the last action." : "Waiting for the current action.",
        recoveryActions: scope.uncertain ? ["retry", "reset"] : ["reset"],
      };
    if (entry.state.kind === "blocked")
      return {
        status: "blocked",
        label: entry.label,
        acceptsIntent: false,
        reason: entry.state.reason,
        recoveryActions: entry.state.retryable ? ["retry", "reset"] : ["reset"],
      };
    return {
      status: "ready",
      label: entry.label,
      acceptsIntent: true,
      reason: null,
      recoveryActions: [],
    };
  };
  const readSnapshot = (): SurfaceHistorySnapshot => ({
    ownerId,
    generation: scope.generation,
    revision,
    undo: capability("undo"),
    redo: capability("redo"),
  });
  let snapshot = readSnapshot();
  const publish = () => {
    revision++;
    snapshot = readSnapshot();
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        report(error);
      }
    }
    settleIdle();
  };
  const remove = (entries: Slot[], entry: Slot) => {
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
  };
  const retains = (owner: typeof scope, entry: Slot) =>
    owner.undo.includes(entry) || owner.redo.includes(entry);
  const discard = (owner: typeof scope, entry: Slot) => {
    const { adapter } = entry;
    const attempt = owner.attempts.get(entry.id);
    if (attempt) {
      retainRelease(adapter.abandon?.(attempt.request, attempt.originalInverse));
      return;
    }
    if (entry.state.kind === "ready") releaseInverse(adapter, entry.state.inverse, "discarded");
    if (entry.state.kind === "blocked" && entry.state.inverse !== undefined)
      releaseInverse(adapter, entry.state.inverse, "discarded");
  };
  const fork = (owner: typeof scope, throughEntryId: number) => {
    owner.branch++;
    for (const entry of [...owner.redo]) {
      if (entry.id >= throughEntryId) continue;
      remove(owner.redo, entry);
      discard(owner, entry);
    }
  };
  const trim = (owner: typeof scope) => {
    for (const direction of ["undo", "redo"] as const) {
      const entries = owner[direction];
      const through = entries.findLastIndex(
        (entry) =>
          entry.state.kind === "ready" && entry.adapter.exceedsReplayBounds?.(entry.state.inverse),
      );
      for (const entry of entries.splice(0, through + 1)) discard(owner, entry);
    }
    let count = owner.undo.length + owner.redo.length;
    let bytes = [...owner.undo, ...owner.redo].reduce((sum, entry) => sum + entry.bytes, 0);
    while (
      count > limits.maxEntries ||
      bytes > limits.maxBytes ||
      (options.retainedIdentityCount?.() ?? 0) > limits.maxRetainedIdentities
    ) {
      const entries = owner.undo.length > 0 ? owner.undo : owner.redo;
      const entry = entries.shift();
      if (!entry) return;
      bytes -= entry.bytes;
      count--;
      discard(owner, entry);
    }
  };
  const measure = (entry: Slot) => {
    const bytes =
      entry.state.kind === "ready" && entry.adapter.inverseBytes
        ? entry.adapter.inverseBytes(entry.state.inverse)
        : byteLength(entry.state);
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error("History size must be a non-negative safe integer.");
    return bytes;
  };
  const drain = (owner: typeof scope) => {
    if (owner.active || owner.uncertain || owner !== scope || closed) return;
    const job = owner.queue.shift();
    if (!job) return;
    owner.active = job.direction;
    activeCount++;
    const finish = (resolution: HistoryCommandResolution<Receipt>) => {
      owner.active = null;
      owner.activeReplay = null;
      activeCount--;
      if (owner === scope) publish();
      job.complete(resolution);
      drain(owner);
    };
    void job.run().then(finish, (error: unknown) => {
      report(error);
      finish({ status: "blocked", reason: reasonOf(error) });
    });
  };
  const immediate = (
    status: "noop" | "rejected" | "blocked",
    reason = "",
  ): HistoryCommandHandle<Receipt> => ({
    accepted: false,
    entryId: null,
    result: Promise.resolve(status === "noop" ? { status } : { status, reason }),
  });
  const unavailable = (): string | null => {
    if (closed) return "This surface is closed.";
    if (replayingLocal) return "A local history action is being applied.";
    if (scope.uncertain) return "Confirm the last action before starting another.";
    if (activeCount + scope.queue.length >= limits.maxPending || releases.size >= limits.maxPending)
      return "Too many surface commands are pending. Wait for confirmation.";
    return null;
  };
  const enqueue = (
    owner: typeof scope,
    entryId: number | null,
    direction: "forward" | SurfaceHistoryDirection,
    run: () => Promise<HistoryCommandResolution<Receipt>>,
  ): HistoryCommandHandle<Receipt> => {
    let complete!: (resolution: HistoryCommandResolution<Receipt>) => void;
    const result = new Promise<HistoryCommandResolution<Receipt>>((resolve) => {
      complete = resolve;
    });
    owner.queue.push({
      direction,
      run,
      complete,
      cancel: () =>
        complete({
          status: "rejected",
          reason: "The surface history was reset before this action started.",
        }),
    });
    drain(owner);
    return { accepted: true, entryId, result };
  };
  const finishAttempt = (owner: typeof scope, attempt: FrozenAttempt) => {
    owner.attempts.delete(attempt.entry.id);
    if (owner.uncertain === attempt) owner.uncertain = null;
    requestBytes -= attempt.bytes;
  };
  const interpret = (adapter: Adapter, receipt: Receipt): HistoryReceiptInterpretation<Inverse> => {
    let interpretation: HistoryReceiptInterpretation<Inverse>;
    try {
      interpretation = adapter.interpret(receipt);
    } catch (error) {
      report(error);
      interpretation = {
        kind: "barrier",
        reason: "The action committed, but its history could not be restored.",
      };
    }
    if (interpretation.kind !== "reversible") {
      try {
        retainRelease(adapter.discardReceipt?.(receipt));
      } catch (error) {
        report(error);
      }
    }
    return interpretation;
  };
  const installReceipt = (
    owner: typeof scope,
    attempt: Pick<FrozenAttempt, "entry" | "direction" | "branch" | "originalInverse">,
    receipt: Receipt,
  ): HistoryCommandResolution<Receipt> => {
    const { entry, direction } = attempt;
    const { adapter } = entry;
    const source = direction === "redo" ? owner.redo : owner.undo;
    const target =
      direction === "forward" ? owner.undo : direction === "undo" ? owner.redo : owner.undo;
    const reachable = owner === scope && !closed && source.includes(entry);
    const interpretation = interpret(adapter, receipt);
    if (attempt.originalInverse !== undefined)
      releaseInverse(adapter, attempt.originalInverse, "consumed");
    if (direction !== "forward" || interpretation.kind === "noop") remove(source, entry);
    if (interpretation.kind === "noop") {
      if (owner === scope) publish();
      return { status: "noop" };
    }
    if (!reachable || (direction !== "forward" && owner.branch !== attempt.branch)) {
      if (interpretation.kind === "reversible")
        releaseInverse(adapter, interpretation.inverse, "discarded");
      return { status: "committed", receipt, entryId: entry.id };
    }
    if (direction === "forward") fork(owner, entry.id);
    entry.state =
      interpretation.kind === "barrier"
        ? { kind: "blocked", reason: interpretation.reason, retryable: false }
        : { kind: "ready", inverse: interpretation.inverse };
    try {
      entry.bytes = measure(entry);
    } catch (error) {
      report(error);
      if (entry.state.kind === "ready") releaseInverse(adapter, entry.state.inverse, "discarded");
      entry.state = {
        kind: "blocked",
        reason: "The committed action exceeds the history representation.",
        retryable: false,
      };
      entry.bytes = byteLength(entry.state);
    }
    if (direction !== "forward") target.push(entry);
    trim(owner);
    publish();
    return { status: "committed", receipt, entryId: entry.id };
  };
  const send = async (
    owner: typeof scope,
    attempt: FrozenAttempt,
  ): Promise<HistoryCommandResolution<Receipt>> => {
    const { adapter } = attempt.entry;
    owner.activeReplay = attempt;
    attempt.entry.state = {
      kind: "pending",
      phase: "submitting",
      inverse: attempt.originalInverse,
    };
    if (owner === scope) publish();
    let outcome: HistoryCommandOutcome<Receipt>;
    try {
      outcome = await adapter.submit(attempt.request);
    } catch (error) {
      outcome = { kind: "unknown", reason: reasonOf(error) };
    }
    if (outcome.kind === "committed") {
      finishAttempt(owner, attempt);
      return installReceipt(owner, attempt, outcome.receipt);
    }
    if (outcome.kind === "unknown") {
      if (owner !== scope || closed) {
        finishAttempt(owner, attempt);
        return { status: "recovering", reason: outcome.reason };
      }
      attempt.entry.state = {
        kind: "pending",
        phase: "recovering",
        inverse: attempt.originalInverse,
      };
      owner.uncertain = attempt;
      if (owner === scope) publish();
      return { status: "recovering", reason: outcome.reason };
    }
    finishAttempt(owner, attempt);
    if (attempt.originalInverse !== undefined && !retains(owner, attempt.entry))
      releaseInverse(adapter, attempt.originalInverse, "discarded");
    if (outcome.kind === "unrecoverable") {
      // Expiry without a receipt proves neither commit nor non-commit. Retire
      // the attempt but never expose earlier entries or prepare a new identity.
      attempt.entry.state = {
        kind: "blocked",
        reason: outcome.reason,
        retryable: false,
        inverse: attempt.originalInverse,
      };
      if (attempt.direction === "forward" && owner === scope) fork(owner, attempt.entry.id);
      if (owner === scope) publish();
      return { status: "blocked", reason: outcome.reason };
    }
    if (attempt.direction === "forward") remove(owner.undo, attempt.entry);
    else
      attempt.entry.state = {
        kind: "blocked",
        reason: outcome.reason,
        retryable: outcome.retryable,
        inverse: attempt.originalInverse,
      };
    if (owner === scope) publish();
    return { status: "rejected", reason: outcome.reason };
  };
  const prepare = async (
    owner: typeof scope,
    entry: Slot,
    direction: FrozenAttempt["direction"],
    preparation: () => Promise<HistoryPreparation<Request, Receipt>>,
    originalInverse?: Inverse,
    branch = owner.branch,
  ): Promise<HistoryCommandResolution<Receipt>> => {
    const { adapter } = entry;
    entry.state = { kind: "pending", phase: "preparing", inverse: originalInverse };
    publish();
    let request: Request;
    let bytes: number;
    try {
      const prepared = await preparation();
      if (prepared.kind === "complete")
        return installReceipt(
          owner,
          { entry, direction, branch, originalInverse },
          prepared.receipt,
        );
      request = structuredClone(prepared.request);
      bytes = byteLength(request);
      if (requestBytes + bytes > limits.maxRequestBytes)
        throw new Error("This action exceeds the pending request budget.");
    } catch (error) {
      if (direction === "forward") remove(owner.undo, entry);
      else if (originalInverse !== undefined && !retains(owner, entry))
        releaseInverse(adapter, originalInverse, "discarded");
      else
        entry.state = {
          kind: "blocked",
          reason: reasonOf(error),
          retryable: true,
          inverse: originalInverse,
        };
      if (owner === scope) publish();
      return { status: "rejected", reason: reasonOf(error) };
    }
    if (owner !== scope || closed || !retains(owner, entry)) {
      if (originalInverse !== undefined) releaseInverse(adapter, originalInverse, "discarded");
      return {
        status: "rejected",
        reason: "The surface changed before this action could be sent.",
      };
    }
    const attempt = { entry, direction, request, bytes, branch, originalInverse };
    requestBytes += bytes;
    owner.attempts.set(entry.id, attempt);
    return send(owner, attempt);
  };
  const replay = async (
    owner: typeof scope,
    direction: SurfaceHistoryDirection,
    throughEntryId: number,
    targetEntryId?: number,
    retry = false,
  ): Promise<HistoryCommandResolution<Receipt>> => {
    const branch = owner.branch;
    while (true) {
      if (owner !== scope || closed)
        return { status: "rejected", reason: "This surface history ended." };
      const local = replayLocal(owner, direction, throughEntryId, targetEntryId, true);
      if (local) return local.result;
      const entry = owner[direction].findLast((candidate) => candidate.id <= throughEntryId);
      if (!entry || (targetEntryId !== undefined && targetEntryId !== entry.id))
        return { status: "noop" };
      const state = entry.state;
      if (state.kind === "pending")
        return { status: "blocked", reason: "Confirm the latest action first." };
      if (state.kind === "blocked" && (!retry || !state.retryable || state.inverse === undefined))
        return { status: "blocked", reason: state.reason };
      const inverse = state.inverse!;
      owner.activeReplay = { entry, direction, branch };
      if (owner === scope) publish();
      if (entry.adapter.checkInverse) {
        const available = await checkInverse(owner, entry, inverse);
        if (available === "changed") continue;
        if (available !== "ready") return { status: "blocked", reason: available.reason };
      }
      const resolution = await prepare(
        owner,
        entry,
        direction,
        () => entry.adapter.prepareInverse(inverse),
        inverse,
        branch,
      );
      if (resolution.status !== "noop") return resolution;
    }
  };
  const checkInverse = async (owner: typeof scope, entry: Slot, inverse: Inverse) => {
    const state = entry.state;
    const stale = () => owner !== scope || !retains(owner, entry) || entry.state !== state;
    let checked: Awaited<ReturnType<NonNullable<Adapter["checkInverse"]>>>;
    try {
      checked = await entry.adapter.checkInverse!(inverse);
    } catch (error) {
      if (stale()) return "changed" as const;
      entry.state = { kind: "blocked", reason: reasonOf(error), retryable: true, inverse };
      publish();
      return { reason: reasonOf(error) };
    }
    if (stale()) return "changed" as const;
    if (checked.state === "ready") return "ready" as const;
    reconcile({
      entryId: entry.id,
      expectedInverse: inverse,
      state: checked.state,
      reason: "reason" in checked ? checked.reason : undefined,
    });
    return checked.state === "superseded" ? ("changed" as const) : { reason: checked.reason };
  };
  const replayLocal = (
    owner: typeof scope,
    direction: SurfaceHistoryDirection,
    throughEntryId: number,
    targetEntryId?: number,
    inExecutor = false,
  ): HistoryCommandHandle<Receipt> | undefined => {
    if (
      closed ||
      replayingLocal ||
      owner.uncertain ||
      (!inExecutor &&
        (owner.queue.length > 0 || (owner.active !== null && owner.active !== "forward")))
    )
      return;
    let consumed = false;
    while (true) {
      const entry = owner[direction].findLast((candidate) => candidate.id <= throughEntryId);
      if (!entry) return consumed ? immediate("noop") : undefined;
      if (targetEntryId !== undefined && targetEntryId !== entry.id) return immediate("noop");
      if (entry.state.kind !== "ready" || !entry.adapter.replayLocal) return;
      const branch = owner.branch;
      const originalInverse = entry.state.inverse;
      let result: ReturnType<NonNullable<Adapter["replayLocal"]>>;
      replayingLocal = true;
      try {
        result = entry.adapter.replayLocal(entry.state.inverse, direction);
      } catch (error) {
        report(error);
        entry.state = {
          kind: "blocked",
          reason: reasonOf(error),
          retryable: false,
          inverse: entry.state.inverse,
        };
        publish();
        return immediate("blocked", reasonOf(error));
      } finally {
        replayingLocal = false;
      }
      if (result.kind === "defer") return;
      const resolution = installReceipt(
        owner,
        { entry, direction, branch, originalInverse },
        result.receipt,
      );
      if (resolution.status === "noop") {
        consumed = true;
        continue;
      }
      return { accepted: true, entryId: entry.id, result: Promise.resolve(resolution) };
    }
  };
  const reset = (key = scope.key) => {
    const previous = scope;
    for (const job of previous.queue.splice(0)) job.cancel();
    for (const entry of [...previous.undo, ...previous.redo]) discard(previous, entry);
    if (previous.uncertain) finishAttempt(previous, previous.uncertain);
    previous.undo.length = 0;
    previous.redo.length = 0;
    scope = makeScope(key, previous.generation + 1);
    publish();
  };
  const reconcile: SurfaceHistory<Intent, Receipt, Inverse>["reconcile"] = ({
    entryId,
    expectedInverse,
    state,
    reason,
  }) => {
    if (closed || replayingLocal) return false;
    const entry = [...scope.undo, ...scope.redo].find((candidate) => candidate.id === entryId);
    if (!entry || entry.state.kind === "pending" || entry.state.inverse !== expectedInverse)
      return false;
    if (state === "superseded") {
      remove(scope.undo, entry);
      remove(scope.redo, entry);
      releaseInverse(entry.adapter, expectedInverse, "consumed");
    } else {
      entry.state = {
        kind: "blocked",
        reason: reason ?? "This history action is no longer available.",
        retryable: false,
        inverse: expectedInverse,
      };
    }
    publish();
    return true;
  };
  // A native engine may already have reachable history when the surface binds.
  // Adopt it without creating a new content branch or trimming dependent Redo early.
  for (const direction of ["undo", "redo"] as const) {
    const captures = [...(options.initialCaptures?.[direction] ?? [])];
    if (direction === "redo") captures.reverse();
    for (const { intent, receipt } of captures) {
      const adapter =
        typeof options.adapter === "function" ? options.adapter(intent) : options.adapter;
      const interpretation = interpret(adapter, receipt);
      if (interpretation.kind === "noop") continue;
      const entry: Slot = {
        id: ++sequence,
        local: true,
        label: adapter.describe(intent),
        adapter,
        bytes: 0,
        state:
          interpretation.kind === "reversible"
            ? { kind: "ready", inverse: interpretation.inverse }
            : { kind: "blocked", reason: interpretation.reason, retryable: false },
      };
      entry.bytes = measure(entry);
      scope[direction].push(entry);
    }
    if (direction === "redo") scope.redo.reverse();
  }
  trim(scope);
  snapshot = readSnapshot();
  return {
    retained: () =>
      (["undo", "redo"] as const).flatMap((direction) =>
        scope[direction].map((entry) => ({
          entryId: entry.id,
          direction,
          state: entry.state.kind,
          inverse: entry.state.inverse,
        })),
      ),
    reconcile,
    capture: (intent, receipt) => {
      const adapter =
        typeof options.adapter === "function" ? options.adapter(intent) : options.adapter;
      if (closed) {
        const interpretation = interpret(adapter, receipt);
        if (interpretation.kind === "reversible")
          releaseInverse(adapter, interpretation.inverse, "discarded");
        return { status: "rejected", reason: "This surface is closed." };
      }
      const owner = scope;
      const entry: Slot = {
        id: ++sequence,
        local: true,
        label: adapter.describe(intent),
        bytes: 128,
        adapter,
        state: { kind: "pending", phase: "preparing" },
      };
      owner.undo.push(entry);
      return installReceipt(owner, { entry, direction: "forward", branch: owner.branch }, receipt);
    },
    refreshCapture: (entryId) => {
      const entry = scope.undo.at(-1);
      if (closed || replayingLocal || !entry?.local || entry.id !== entryId) return false;
      if (entry.state.kind !== "ready") return false;
      // A grouped edit is a new content branch even though its capture identity stays stable.
      fork(scope, ++sequence);
      try {
        entry.bytes = measure(entry);
      } catch (error) {
        report(error);
        releaseInverse(entry.adapter, entry.state.inverse, "discarded");
        entry.state = { kind: "blocked", reason: reasonOf(error), retryable: false };
        entry.bytes = byteLength(entry.state);
      }
      trim(scope);
      publish();
      return true;
    },
    execute: (intent) => {
      const reason = unavailable();
      if (reason) return immediate("rejected", reason);
      const owner = scope;
      const adapter =
        typeof options.adapter === "function" ? options.adapter(intent) : options.adapter;
      const entry: Slot = {
        id: ++sequence,
        local: false,
        label: adapter.describe(intent),
        bytes: 128,
        adapter,
        state: { kind: "pending", phase: "preparing" },
      };
      owner.undo.push(entry);
      publish();
      return enqueue(owner, entry.id, "forward", () =>
        prepare(owner, entry, "forward", () => adapter.prepare(intent)),
      );
    },
    request: (direction, targetEntryId) => {
      const local = replayLocal(scope, direction, sequence, targetEntryId);
      if (local) return local;
      const reason = unavailable();
      if (reason) return immediate("blocked", reason);
      const owner = scope;
      const throughEntryId = sequence;
      const entry = pendingOppositeEntry(direction) ?? owner[direction].at(-1);
      if (!entry) return immediate("noop");
      return enqueue(owner, entry.id, direction, () =>
        replay(owner, direction, throughEntryId, targetEntryId),
      );
    },
    recover: () => {
      if (closed || scope.active)
        return immediate("blocked", "The current action is still being confirmed.");
      const owner = scope;
      if (owner.uncertain) {
        const attempt = owner.uncertain;
        owner.uncertain = null;
        // Recovery precedes dependent queued commands and reuses the frozen request.
        const waiting = owner.queue.splice(0);
        const handle = enqueue(owner, attempt.entry.id, attempt.direction, () =>
          send(owner, attempt),
        );
        owner.queue.push(...waiting);
        return handle;
      }
      const direction = owner.undo.at(-1)?.state.kind === "blocked" ? "undo" : "redo";
      return enqueue(owner, owner[direction].at(-1)?.id ?? null, direction, () =>
        replay(owner, direction, sequence, undefined, true),
      );
    },
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setScope: (key) => {
      if (scope.key !== key) reset(key);
    },
    reset: () => reset(),
    close: () => {
      if (closed) return;
      closed = true;
      reset();
    },
    whenIdle: () =>
      isIdle() ? Promise.resolve() : new Promise<void>((complete) => idleWaiters.add(complete)),
  };
};
