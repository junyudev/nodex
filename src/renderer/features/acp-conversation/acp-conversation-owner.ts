import type {
  AcpBackendAuthenticateResult,
  AcpBackendConfigOptionResult,
  AcpBackendPromptResult,
  AcpBackendSessionPresentation,
} from "../../../shared/agent-backend-api";
import {
  applyAcpConversationDelta,
  type AcpConversationDelta,
  type AcpConversationSnapshot,
} from "../../../shared/acp-conversation";
import { acpBackendRuntime, type AcpBackendRuntime } from "../../lib/acp-backend-runtime";

export type AcpConversationControlOperation = "authenticate" | "cancel" | "config" | "mode";

export interface AcpConversationOwnerSnapshot {
  readonly connection: "connecting" | "failed" | "ready";
  readonly presentation: AcpBackendSessionPresentation | null;
  readonly promptPending: boolean;
  readonly controlPending: AcpConversationControlOperation | null;
  readonly error: string | null;
}

export interface AcpConversationOwnerPort {
  readonly threadId: string;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => AcpConversationOwnerSnapshot;
  readonly connect: () => () => void;
  readonly retry: () => void;
  readonly prompt: (prompt: string) => Promise<boolean>;
  readonly cancel: () => Promise<boolean>;
  readonly setMode: (modeId: string) => Promise<boolean>;
  readonly setConfigOption: (configId: string, value: string | boolean) => Promise<boolean>;
  readonly authenticate: (methodId: string) => Promise<boolean>;
  readonly close: () => Promise<void>;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message.trim() ? cause.message : String(cause);

const shouldAcceptSnapshot = (
  current: AcpConversationSnapshot | undefined,
  incoming: AcpConversationSnapshot,
): boolean => current === undefined || incoming.revision >= current.revision;

/**
 * Owns one attached ACP thread's renderer lifecycle. React is only a subscriber;
 * unmounting releases event delivery but does not close the durable backend session.
 */
export class AcpConversationOwner implements AcpConversationOwnerPort {
  readonly threadId: string;
  readonly #runtime: AcpBackendRuntime;
  readonly #listeners = new Set<() => void>();
  #state: AcpConversationOwnerSnapshot = {
    connection: "connecting",
    presentation: null,
    promptPending: false,
    controlPending: null,
    error: null,
  };
  #generation = 0;
  #releaseSubscription: (() => void) | null = null;
  #pendingDeltas: AcpConversationDelta[] = [];
  #resyncPending = false;

  constructor(threadId: string, runtime: AcpBackendRuntime = acpBackendRuntime) {
    this.threadId = threadId;
    this.#runtime = runtime;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): AcpConversationOwnerSnapshot => this.#state;

  readonly connect = (): (() => void) => {
    const generation = ++this.#generation;
    this.#releaseSubscription?.();
    this.#releaseSubscription = null;
    this.#pendingDeltas = [];
    this.#resyncPending = false;
    this.#patch({ connection: "connecting", presentation: null, error: null });
    void this.#subscribeAndOpen(generation);
    return () => {
      if (generation !== this.#generation) return;
      this.#generation += 1;
      this.#releaseSubscription?.();
      this.#releaseSubscription = null;
    };
  };

  readonly retry = (): void => {
    const generation = ++this.#generation;
    this.#releaseSubscription?.();
    this.#releaseSubscription = null;
    this.#pendingDeltas = [];
    this.#resyncPending = false;
    this.#patch({ connection: "connecting", presentation: null, error: null });
    void this.#subscribeAndOpen(generation);
  };

  readonly prompt = async (rawPrompt: string): Promise<boolean> => {
    const prompt = rawPrompt.trim();
    if (!prompt || this.#state.promptPending) return false;
    if (this.#state.presentation?.snapshot.status !== "idle") return false;
    this.#patch({ promptPending: true, error: null });
    try {
      const result: AcpBackendPromptResult = await this.#runtime.prompt({
        threadId: this.threadId,
        prompt,
      });
      this.#acceptSnapshot(result.snapshot);
      return true;
    } catch (cause) {
      this.#patch({ error: errorMessage(cause) });
      return false;
    } finally {
      this.#patch({ promptPending: false });
    }
  };

  readonly cancel = (): Promise<boolean> =>
    this.#runControl("cancel", async () => {
      this.#acceptSnapshot(await this.#runtime.cancel(this.threadId));
    });

  readonly setMode = (modeId: string): Promise<boolean> =>
    this.#runControl("mode", async () => {
      const snapshot = await this.#runtime.setMode({ threadId: this.threadId, modeId });
      this.#acceptSnapshot(snapshot);
      const presentation = this.#state.presentation;
      if (presentation?.modes) {
        this.#acceptPresentation({
          ...presentation,
          modes: { ...presentation.modes, currentModeId: modeId },
        });
      }
    });

  readonly setConfigOption = (configId: string, value: string | boolean): Promise<boolean> =>
    this.#runControl("config", async () => {
      const result: AcpBackendConfigOptionResult = await this.#runtime.setConfigOption({
        threadId: this.threadId,
        configId,
        value,
      });
      this.#acceptSnapshot(result.snapshot);
      const presentation = this.#state.presentation;
      if (presentation) {
        this.#acceptPresentation({ ...presentation, configOptions: result.configOptions });
      }
    });

  readonly authenticate = (methodId: string): Promise<boolean> =>
    this.#runControl("authenticate", async () => {
      const result: AcpBackendAuthenticateResult = await this.#runtime.authenticate({
        threadId: this.threadId,
        methodId,
      });
      this.#acceptSnapshot(result.snapshot);
      await this.#refreshPresentation();
    });

  readonly close = async (): Promise<void> => {
    await this.#runtime.close(this.threadId);
    const presentation = this.#state.presentation;
    if (!presentation) return;
    this.#acceptSnapshot({
      ...presentation.snapshot,
      status: "closed",
      revision: presentation.snapshot.revision + 1,
    });
  };

  async #openAndRead(generation: number): Promise<void> {
    try {
      const opened = await this.#runtime.open({ threadId: this.threadId });
      if (generation !== this.#generation) return;
      this.#acceptPresentation(opened);
      const current = await this.#runtime.read(this.threadId);
      if (generation !== this.#generation) return;
      if (current) this.#acceptPresentation(current);
      this.#patch({ connection: "ready", error: null });
    } catch (cause) {
      if (generation !== this.#generation) return;
      this.#patch({ connection: "failed", error: errorMessage(cause) });
    }
  }

  async #subscribeAndOpen(generation: number): Promise<void> {
    try {
      const release = await this.#runtime.subscribe(this.threadId, ({ delta }) => {
        if (generation !== this.#generation) return;
        this.#acceptDelta(delta);
      });
      if (generation !== this.#generation) {
        release();
        return;
      }
      this.#releaseSubscription = release;
      await this.#openAndRead(generation);
    } catch (cause) {
      if (generation !== this.#generation) return;
      this.#patch({ connection: "failed", error: errorMessage(cause) });
    }
  }

  async #refreshPresentation(generation = this.#generation): Promise<void> {
    const presentation = await this.#runtime.read(this.threadId);
    if (generation !== this.#generation) return;
    if (presentation) this.#acceptPresentation(presentation);
  }

  async #runControl(
    operation: AcpConversationControlOperation,
    run: () => Promise<void>,
  ): Promise<boolean> {
    if (this.#state.controlPending) return false;
    this.#patch({ controlPending: operation, error: null });
    try {
      await run();
      return true;
    } catch (cause) {
      this.#patch({ error: errorMessage(cause) });
      return false;
    } finally {
      this.#patch({ controlPending: null });
    }
  }

  #acceptPresentation(presentation: AcpBackendSessionPresentation): void {
    const currentSnapshot = this.#state.presentation?.snapshot;
    let snapshot =
      currentSnapshot &&
      currentSnapshot.sessionId === presentation.snapshot.sessionId &&
      currentSnapshot.revision > presentation.snapshot.revision
        ? currentSnapshot
        : presentation.snapshot;
    const pending = this.#pendingDeltas.sort((left, right) => left.revision - right.revision);
    this.#pendingDeltas = [];
    for (const delta of pending) {
      if (delta.sessionId !== snapshot.sessionId || delta.revision <= snapshot.revision) continue;
      const next = applyAcpConversationDelta(snapshot, delta);
      if (!next) {
        this.#pendingDeltas.push(delta);
        continue;
      }
      snapshot = next;
    }
    this.#patch({ presentation: { ...presentation, snapshot } });
    if (this.#pendingDeltas.length > 0) this.#requestResync();
  }

  #acceptSnapshot(snapshot: AcpConversationSnapshot): void {
    const presentation = this.#state.presentation;
    if (!presentation) {
      return;
    }
    if (!shouldAcceptSnapshot(presentation.snapshot, snapshot)) return;
    const currentModeId = snapshot.turns
      .flatMap(({ updates }) => updates)
      .findLast((update) => update.kind === "mode")?.currentModeId;
    this.#patch({
      presentation: {
        ...presentation,
        snapshot,
        modes:
          presentation.modes && currentModeId
            ? { ...presentation.modes, currentModeId }
            : presentation.modes,
      },
    });
  }

  #acceptDelta(delta: AcpConversationDelta): void {
    const presentation = this.#state.presentation;
    if (!presentation) {
      this.#pendingDeltas = [...this.#pendingDeltas.slice(-127), delta];
      return;
    }
    if (delta.sessionId !== presentation.snapshot.sessionId) {
      this.#requestResync();
      return;
    }
    if (delta.revision <= presentation.snapshot.revision) return;
    const snapshot = applyAcpConversationDelta(presentation.snapshot, delta);
    if (!snapshot) {
      this.#pendingDeltas = [...this.#pendingDeltas.slice(-127), delta];
      this.#requestResync();
      return;
    }
    this.#acceptSnapshot(snapshot);
  }

  #requestResync(): void {
    if (this.#resyncPending) return;
    const generation = this.#generation;
    this.#resyncPending = true;
    void this.#refreshPresentation(generation)
      .catch((cause) => {
        if (generation !== this.#generation) return;
        this.#patch({ connection: "failed", error: errorMessage(cause) });
      })
      .finally(() => {
        if (generation === this.#generation) this.#resyncPending = false;
      });
  }

  #patch(patch: Partial<AcpConversationOwnerSnapshot>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
