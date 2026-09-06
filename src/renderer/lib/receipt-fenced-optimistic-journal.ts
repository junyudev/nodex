import type { RendererCausalTraceEventInput } from "./renderer-causal-trace";

export interface ReceiptProjectionCursor {
  readonly storeEpoch: string;
  readonly commitSeq: number;
}

export interface ReceiptOptimisticActivity {
  readonly pending: number;
  readonly unknown: number;
  readonly acknowledged: number;
}

export interface ReceiptOptimisticMutationResult<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly error?: Error;
  readonly superseded: boolean;
  readonly opId: number;
  readonly outcome?: "unknown" | "rejected";
}

export interface ReceiptOptimisticCommand<Model, Result> {
  readonly operationIdentity?: string;
  readonly conflictKeys: readonly string[];
  readonly apply: (model: Model) => Model;
  readonly runRemote: () => Promise<Result>;
  readonly getCommitCursor?: (result: Result) => ReceiptProjectionCursor | null | undefined;
  readonly isCommitMaterialized?: (canonical: Model, result: Result) => boolean;
  readonly refresh?: (cursor: ReceiptProjectionCursor | null) => Promise<boolean>;
  readonly remoteLane?: string;
  readonly classifyFailure?: (error: Error) => "rejected" | "unknown";
  readonly trace?: (event: RendererCausalTraceEventInput) => void;
}

interface Entry<Model> {
  readonly opId: number;
  readonly operationIdentity: string | undefined;
  readonly conflictKeys: readonly string[];
  readonly apply: (model: Model) => Model;
  readonly trace: ((event: RendererCausalTraceEventInput) => void) | undefined;
  readonly receiptProof: (result: unknown) => {
    readonly cursor: ReceiptProjectionCursor | null;
    readonly materialized: ((canonical: Model) => boolean) | null;
  };
  phase: "local" | "pending" | "unknown" | "acknowledged";
  cursor: ReceiptProjectionCursor | null;
  materialized: ((canonical: Model) => boolean) | null;
  superseded: boolean;
  proofComplete: boolean;
}

/**
 * One presentation lifecycle shared by bounded projection owners. A command's
 * admitted receipt completes its Promise; canonical repair separately fences
 * dependent submissions. Only the matching rendered projection retires intent.
 */
export class ReceiptFencedOptimisticJournal<Model> {
  private entries: Entry<Model>[] = [];
  private nextId = 1;
  private generation = 0;
  private nextRenderToken = 0;
  private candidate: { entries: readonly Entry<Model>[]; model: Model; token: number } | null =
    null;
  private readonly lanes = new Map<string, { entry: Entry<Model>; ready: Promise<boolean> }>();

  constructor(
    private readonly dependencies: {
      readonly onChange: () => void;
      readonly equal?: (left: Model, right: Model) => boolean;
    },
  ) {}

  getActivity(): ReceiptOptimisticActivity {
    return {
      pending: this.entries.filter((entry) => entry.phase === "pending").length,
      unknown: this.entries.filter((entry) => entry.phase === "unknown").length,
      acknowledged: this.entries.filter((entry) => entry.phase === "acknowledged").length,
    };
  }

  hasWork(): boolean {
    return this.entries.length > 0 || this.lanes.size > 0;
  }

  hasMatchingConflict(predicate: (keys: readonly string[]) => boolean): boolean {
    return this.entries.some((entry) => predicate(entry.conflictKeys));
  }

  enqueueLocal(input: {
    readonly conflictKeys: readonly string[];
    readonly apply: (model: Model) => Model;
  }): void {
    this.supersede(input.conflictKeys);
    this.entries.push({
      ...input,
      opId: this.nextId++,
      operationIdentity: undefined,
      trace: undefined,
      receiptProof: () => ({ cursor: null, materialized: null }),
      phase: "local",
      cursor: null,
      materialized: null,
      superseded: false,
      proofComplete: false,
    });
    this.dependencies.onChange();
  }

  run<Result>(
    command: ReceiptOptimisticCommand<Model, Result>,
  ): Promise<ReceiptOptimisticMutationResult<Result>> {
    const retained =
      command.operationIdentity === undefined
        ? undefined
        : this.entries.find(
            (entry) =>
              entry.operationIdentity === command.operationIdentity && entry.phase === "unknown",
          );
    if (!retained) this.supersede(command.conflictKeys);
    const entry: Entry<Model> = retained ?? {
      ...command,
      operationIdentity: command.operationIdentity,
      trace: command.trace,
      // An operation identity fixes its result type and interpretation. A retry
      // may obtain the receipt again, but cannot replace the original preview
      // or weaken the semantic proof merely because the current window changed.
      receiptProof: (value) => {
        const result = value as Result;
        return {
          cursor: command.getCommitCursor?.(result) ?? null,
          materialized: command.isCommitMaterialized
            ? (canonical) => command.isCommitMaterialized!(canonical, result)
            : null,
        };
      },
      opId: this.nextId++,
      phase: "pending",
      cursor: null,
      materialized: null,
      superseded: false,
      proofComplete: false,
    };
    entry.phase = "pending";
    if (!retained) {
      this.entries.push(entry);
      entry.trace?.({ kind: "local_intent", reason: "local_intent" });
    }
    this.dependencies.onChange();
    const generation = this.generation;
    const previous = command.remoteLane ? this.lanes.get(command.remoteLane) : undefined;
    let finishLane: (ready: boolean) => void = () => {};
    const laneReady = new Promise<boolean>((resolve) => {
      finishLane = resolve;
    });
    const lane = { entry, ready: laneReady };
    if (command.remoteLane) this.lanes.set(command.remoteLane, lane);

    return new Promise((resolve) => {
      void (async () => {
        let submitted = false;
        try {
          const precedingReady = !previous || previous.entry === entry || (await previous.ready);
          if (!precedingReady && !previous?.entry.proofComplete)
            throw new Error("A preceding placement did not reach canonical authority");
          if (generation !== this.generation)
            throw new Error(
              "Projection authority changed before the queued mutation could execute",
            );
          submitted = true;
          entry.trace?.({ kind: "submitted", reason: "transport_submit" });
          const result = await command.runRemote();
          entry.phase = "acknowledged";
          const proof = entry.receiptProof(result);
          entry.cursor = proof.cursor;
          entry.materialized = proof.materialized;
          if (!entry.superseded) entry.trace?.({ kind: "acknowledged", reason: "committed" });
          this.dependencies.onChange();
          resolve({ ok: true, result, superseded: entry.superseded, opId: entry.opId });
          // Repair failure belongs to the projection owner, never to the
          // already-acknowledged command or its durable interaction history.
          let ready = generation === this.generation;
          if (ready && command.refresh) {
            try {
              ready = await command.refresh(entry.cursor);
            } catch {
              ready = false;
            }
          }
          finishLane(ready);
          if (ready && command.remoteLane && this.lanes.get(command.remoteLane) === lane)
            this.lanes.delete(command.remoteLane);
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          const outcome = submitted ? (command.classifyFailure?.(error) ?? "rejected") : "rejected";
          if (outcome === "unknown" && !entry.superseded) {
            entry.phase = "unknown";
          } else {
            if (!entry.superseded) entry.trace?.({ kind: "failed", reason: "domain_failure" });
            this.entries = this.entries.filter((candidate) => candidate !== entry);
          }
          finishLane(false);
          if (
            outcome === "rejected" &&
            command.remoteLane &&
            this.lanes.get(command.remoteLane) === lane
          )
            this.lanes.delete(command.remoteLane);
          this.dependencies.onChange();
          resolve({ ok: false, error, outcome, superseded: entry.superseded, opId: entry.opId });
        }
      })();
    });
  }

  project(
    canonical: Model,
    cursor: ReceiptProjectionCursor | null,
    materializationReady = true,
    proofCanonical = canonical,
  ): {
    readonly model: Model;
    readonly renderToken: number | null;
  } {
    const equal = this.dependencies.equal ?? Object.is;
    let model = canonical;
    const materialized: Entry<Model>[] = [];
    this.entries = this.entries.filter((entry) => {
      const after = entry.apply(model);
      const unchanged = equal(after, model);
      if (entry.phase === "local" && unchanged && materializationReady) return false;
      const covered =
        !entry.cursor ||
        (cursor?.storeEpoch === entry.cursor.storeEpoch &&
          cursor.commitSeq >= entry.cursor.commitSeq);
      entry.proofComplete =
        entry.phase === "acknowledged" &&
        covered &&
        materializationReady &&
        (entry.materialized
          ? entry.materialized(proofCanonical) && entry.materialized(model)
          : unchanged);
      if (entry.proofComplete) materialized.push(entry);
      // The candidate React commits must contain canonical materialization,
      // not a second application of a now-proven, potentially non-idempotent
      // pointer preview. Later entries still compose over this handoff.
      model = entry.proofComplete ? model : after;
      return true;
    });
    if (materialized.length === 0) {
      this.candidate = null;
      return { model, renderToken: null };
    }
    const previous = this.candidate;
    if (
      !previous ||
      !equal(previous.model, model) ||
      previous.entries.length !== materialized.length ||
      materialized.some((entry, index) => entry !== previous.entries[index])
    ) {
      this.candidate = { entries: materialized, model, token: ++this.nextRenderToken };
      for (const entry of materialized)
        entry.trace?.({
          kind: "materialized",
          reason: "canonical_observation",
          renderToken: this.candidate.token,
        });
    }
    return { model, renderToken: this.candidate!.token };
  }

  markRendered(token: number): void {
    const candidate = this.candidate;
    if (!candidate || candidate.token !== token) return;
    this.candidate = null;
    for (const entry of candidate.entries) {
      entry.trace?.({ kind: "rendered", reason: "render_handoff", renderToken: token });
      entry.trace?.({ kind: "settled", reason: "proof_complete" });
    }
    this.entries = this.entries.filter((entry) => !candidate.entries.includes(entry));
    for (const [name, lane] of this.lanes) {
      if (candidate.entries.includes(lane.entry)) this.lanes.delete(name);
    }
    this.dependencies.onChange();
  }

  revoke(reason: "authority_revoked" | "store_reset"): void {
    this.generation += 1;
    for (const entry of this.entries) {
      entry.superseded = true;
      entry.trace?.({ kind: "revoked", reason });
    }
    this.entries = [];
    this.candidate = null;
    this.lanes.clear();
  }

  removeWhere(predicate: (keys: readonly string[]) => boolean): boolean {
    const removed = this.entries.filter((entry) => predicate(entry.conflictKeys));
    for (const entry of removed) {
      entry.superseded = true;
      entry.trace?.({ kind: "revoked", reason: "authority_revoked" });
    }
    this.entries = this.entries.filter((entry) => !removed.includes(entry));
    if (removed.length > 0) this.candidate = null;
    return removed.length > 0;
  }

  resolveConflicts(keys: readonly string[]): void {
    this.supersede(keys);
  }

  /** Discards local presentation only; it never cancels a durable command. */
  discard(operationIdentity: string): boolean {
    const removed = this.entries.filter((entry) => entry.operationIdentity === operationIdentity);
    if (removed.length === 0) return false;
    for (const entry of removed) {
      entry.superseded = true;
      entry.trace?.({ kind: "revoked", reason: "authority_revoked" });
    }
    this.entries = this.entries.filter((entry) => !removed.includes(entry));
    this.candidate = null;
    for (const [name, lane] of this.lanes) {
      if (removed.includes(lane.entry)) this.lanes.delete(name);
    }
    this.dependencies.onChange();
    return true;
  }

  private supersede(keys: readonly string[]): void {
    for (const entry of this.entries) {
      if (!entry.conflictKeys.some((key) => keys.includes(key))) continue;
      entry.superseded = true;
      this.candidate = null;
      entry.trace?.({ kind: "superseded", reason: "newer_intent" });
    }
    this.entries = this.entries.filter((entry) => !entry.superseded);
  }
}
