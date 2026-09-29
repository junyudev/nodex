import type { AgentInteractionResponse } from "../../../shared/agent-conversation";
import type {
  AgentBackendAuthenticateResult,
  AgentBackendConfigOptionResult,
  AgentBackendPromptResult,
  AgentBackendSessionPresentation,
} from "../../../shared/agent-backend-api";
import {
  applyAgentConversationDelta,
  type AgentConversationDelta,
  type AgentConversationSnapshot,
} from "../../../shared/agent-conversation";
import { agentBackendRuntime, type AgentBackendRuntime } from "../../lib/agent-backend-runtime";

export type AgentConversationControlOperation =
  | "authenticate"
  | "cancel"
  | "config"
  | "mode"
  | "response";

export interface AgentConversationOwnerSnapshot {
  readonly connection: "connecting" | "failed" | "ready";
  readonly presentation: AgentBackendSessionPresentation | null;
  readonly promptPending: boolean;
  readonly controlPending: AgentConversationControlOperation | null;
  readonly error: string | null;
}

export interface AgentConversationOwnerPort {
  readonly threadId: string;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => AgentConversationOwnerSnapshot;
  readonly connect: () => () => void;
  readonly retry: () => void;
  readonly prompt: (prompt: string) => Promise<boolean>;
  readonly submit: (prompt: string) => Promise<boolean>;
  readonly cancel: () => Promise<boolean>;
  readonly setMode: (modeId: string) => Promise<boolean>;
  readonly setConfigOption: (configId: string, value: string | boolean) => Promise<boolean>;
  readonly authenticate: (methodId: string) => Promise<boolean>;
  readonly respond: (requestId: string, response: AgentInteractionResponse) => Promise<boolean>;
  readonly close: () => Promise<void>;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message.trim() ? cause.message : String(cause);

const shouldAcceptSnapshot = (
  current: AgentConversationSnapshot | undefined,
  incoming: AgentConversationSnapshot,
): boolean => current === undefined || incoming.revision >= current.revision;

/**
 * Owns one attached Agent thread's renderer lifecycle. React is only a subscriber;
 * unmounting releases event delivery but does not close the durable backend session.
 */
export class AgentConversationOwner implements AgentConversationOwnerPort {
  readonly threadId: string;
  readonly #runtime: AgentBackendRuntime;
  readonly #listeners = new Set<() => void>();
  #state: AgentConversationOwnerSnapshot = {
    connection: "connecting",
    presentation: null,
    promptPending: false,
    controlPending: null,
    error: null,
  };
  #generation = 0;
  #connectionLease = 0;
  #releaseSubscription: (() => void) | null = null;
  #pendingDeltas: AgentConversationDelta[] = [];
  #resyncPending = false;

  constructor(threadId: string, runtime: AgentBackendRuntime = agentBackendRuntime) {
    this.threadId = threadId;
    this.#runtime = runtime;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): AgentConversationOwnerSnapshot => this.#state;

  readonly connect = (): (() => void) => {
    const lease = ++this.#connectionLease;
    const generation = ++this.#generation;
    this.#releaseSubscription?.();
    this.#releaseSubscription = null;
    this.#pendingDeltas = [];
    this.#resyncPending = false;
    this.#patch({ connection: "connecting", presentation: null, error: null });
    void this.#subscribeAndOpen(generation);
    return () => {
      if (lease !== this.#connectionLease) return;
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
      const result: AgentBackendPromptResult = await this.#runtime.prompt({
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

  /** Resolve after admission, while the Main-owned turn continues and publishes completion. */
  readonly submit = (text: string): Promise<boolean> =>
    new Promise((resolve) => {
      let release = () => {};
      const finish = (accepted: boolean) => {
        release();
        resolve(accepted);
      };
      release = this.subscribe(() => {
        if (this.#state.presentation?.snapshot.status === "running") finish(true);
      });
      void this.prompt(text).then(finish);
    });

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
      const result: AgentBackendConfigOptionResult = await this.#runtime.setConfigOption({
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
      const result: AgentBackendAuthenticateResult = await this.#runtime.authenticate({
        threadId: this.threadId,
        methodId,
      });
      this.#acceptSnapshot(result.snapshot);
      await this.#refreshPresentation();
    });

  readonly respond = (requestId: string, response: AgentInteractionResponse): Promise<boolean> =>
    this.#runControl("response", async () => {
      await this.#runtime.respond(this.threadId, requestId, response);
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
    operation: AgentConversationControlOperation,
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

  #acceptPresentation(presentation: AgentBackendSessionPresentation): void {
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
      const next = applyAgentConversationDelta(snapshot, delta);
      if (!next) {
        this.#pendingDeltas.push(delta);
        continue;
      }
      snapshot = next;
    }
    this.#patch({ presentation: { ...presentation, snapshot } });
    if (this.#pendingDeltas.length > 0) this.#requestResync();
  }

  #acceptSnapshot(snapshot: AgentConversationSnapshot): void {
    const presentation = this.#state.presentation;
    if (!presentation) {
      return;
    }
    if (!shouldAcceptSnapshot(presentation.snapshot, snapshot)) return;
    const becameIdle = presentation.snapshot.status === "running" && snapshot.status === "idle";
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
    if (becameIdle) this.#requestResync();
  }

  #acceptDelta(delta: AgentConversationDelta): void {
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
    const snapshot = applyAgentConversationDelta(presentation.snapshot, delta);
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

  #patch(patch: Partial<AgentConversationOwnerSnapshot>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

const owners = new Map<
  string,
  { owner: AgentConversationOwner; references: number; release: (() => void) | null }
>();

export function acquireAgentConversationOwner(threadId: string): {
  owner: AgentConversationOwner;
  retain: () => () => void;
} {
  let entry = owners.get(threadId);
  if (!entry) {
    entry = { owner: new AgentConversationOwner(threadId), references: 0, release: null };
    owners.set(threadId, entry);
  }
  const shared = entry;
  return {
    owner: shared.owner,
    retain: () => {
      if (shared.references++ === 0) {
        owners.set(threadId, shared);
        shared.release = shared.owner.connect();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--shared.references !== 0) return;
        shared.release?.();
        shared.release = null;
        if (owners.get(threadId) === shared) owners.delete(threadId);
      };
    },
  };
}
