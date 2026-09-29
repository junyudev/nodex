import type { AgentInteractionResponse } from "../../../shared/agent-conversation";
import type {
  AgentBackendAuthenticateResult,
  AgentBackendConfigOptionResult,
  AgentBackendPromptResult,
  AgentBackendSessionPresentation,
  AgentBackendControlInput,
  AgentBackendControlCommand,
} from "../../../shared/agent-backend-api";
import type { ClaudeModelSelection } from "../../../shared/claude-models";
import { createUuidV7 } from "../../../shared/uuid-v7";
import type { CodexPromptImageInput } from "../../../shared/types";
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
  readonly prompt: (prompt: string, images?: readonly CodexPromptImageInput[]) => Promise<boolean>;
  readonly submit: (prompt: string, images?: readonly CodexPromptImageInput[]) => Promise<boolean>;
  readonly cancel: () => Promise<boolean>;
  readonly setMode: (modeId: string) => Promise<boolean>;
  readonly setConfigOption: (configId: string, value: string | boolean) => Promise<boolean>;
  readonly setIntelligence: (selection: ClaudeModelSelection) => Promise<boolean>;
  readonly control: (input: AgentBackendControlCommand) => Promise<boolean>;
  readonly authenticate: (methodId: string) => Promise<boolean>;
  readonly respond: (requestId: string, response: AgentInteractionResponse) => Promise<boolean>;
  readonly close: () => Promise<void>;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message.trim() ? cause.message : String(cause);

const shouldAcceptSnapshot = (
  current: AgentConversationSnapshot | undefined,
  incoming: AgentConversationSnapshot,
): boolean =>
  current === undefined ||
  current.sessionId !== incoming.sessionId ||
  incoming.revision >= current.revision;

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
  #resyncDirty = false;
  readonly #retiredSessions = new Set<string>();

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
    this.#resyncDirty = false;
    this.#retiredSessions.clear();
    this.#patch({
      connection: "connecting",
      presentation: null,
      promptPending: false,
      controlPending: null,
      error: null,
    });
    void this.#subscribeAndOpen(generation);
    return () => {
      if (lease !== this.#connectionLease) return;
      this.#generation += 1;
      this.#releaseSubscription?.();
      this.#releaseSubscription = null;
      this.#pendingDeltas = [];
      this.#resyncPending = false;
      this.#resyncDirty = false;
    };
  };

  readonly retry = (): void => {
    const generation = ++this.#generation;
    this.#releaseSubscription?.();
    this.#releaseSubscription = null;
    this.#pendingDeltas = [];
    this.#resyncPending = false;
    this.#resyncDirty = false;
    this.#retiredSessions.clear();
    this.#patch({
      connection: "connecting",
      presentation: null,
      promptPending: false,
      controlPending: null,
      error: null,
    });
    void this.#subscribeAndOpen(generation);
  };

  readonly prompt = async (
    rawPrompt: string,
    images?: readonly CodexPromptImageInput[],
  ): Promise<boolean> => {
    const prompt = rawPrompt.trim();
    if ((!prompt && !images?.length) || this.#state.promptPending) return false;
    if (this.#state.presentation?.snapshot.status !== "idle") return false;
    const generation = this.#generation;
    this.#patch({ promptPending: true, error: null });
    try {
      const result: AgentBackendPromptResult = await this.#runtime.prompt({
        threadId: this.threadId,
        prompt,
        clientUserMessageId: createUuidV7(),
        ...(images?.length ? { images } : {}),
      });
      if (generation !== this.#generation) return false;
      this.#acceptSnapshot(result.snapshot);
      return true;
    } catch (cause) {
      if (generation === this.#generation) this.#patch({ error: errorMessage(cause) });
      return false;
    } finally {
      if (generation === this.#generation) this.#patch({ promptPending: false });
    }
  };

  /** Resolve after admission, while the Main-owned turn continues and publishes completion. */
  readonly submit = (text: string, images?: readonly CodexPromptImageInput[]): Promise<boolean> =>
    new Promise((resolve) => {
      let release = () => {};
      const finish = (accepted: boolean) => {
        release();
        resolve(accepted);
      };
      release = this.subscribe(() => {
        if (this.#state.presentation?.snapshot.status === "running") finish(true);
      });
      void this.prompt(text, images).then(finish);
    });

  readonly cancel = (): Promise<boolean> =>
    this.#runControl("cancel", async (generation) => {
      const snapshot = await this.#runtime.cancel(this.threadId);
      if (generation === this.#generation) this.#acceptSnapshot(snapshot);
    });

  readonly setMode = (modeId: string): Promise<boolean> =>
    this.#runControl("mode", async (generation) => {
      const snapshot = await this.#runtime.setMode({ threadId: this.threadId, modeId });
      if (generation !== this.#generation) return;
      this.#acceptSnapshot(snapshot);
      if (!snapshot.metadata) await this.#refreshPresentation(generation);
    });

  readonly setConfigOption = (configId: string, value: string | boolean): Promise<boolean> =>
    this.#runControl("config", async (generation) => {
      const result: AgentBackendConfigOptionResult = await this.#runtime.setConfigOption({
        threadId: this.threadId,
        configId,
        value,
      });
      if (generation !== this.#generation) return;
      this.#acceptSnapshot(result.snapshot);
      if (!result.snapshot.metadata) await this.#refreshPresentation(generation);
    });

  readonly setIntelligence = (selection: ClaudeModelSelection): Promise<boolean> =>
    this.#runControl("config", async () => {
      const generation = this.#generation;
      const presentation = await this.#runtime.setIntelligence({
        threadId: this.threadId,
        selection,
      });
      if (generation === this.#generation) this.#acceptPresentation(presentation);
    });

  readonly control = (input: AgentBackendControlCommand): Promise<boolean> =>
    this.#runControl("config", async () => {
      const generation = this.#generation;
      const presentation = await this.#runtime.control({
        ...input,
        threadId: this.threadId,
      } as AgentBackendControlInput);
      if (generation === this.#generation) this.#acceptPresentation(presentation);
    });

  readonly authenticate = (methodId: string): Promise<boolean> =>
    this.#runControl("authenticate", async (generation) => {
      const result: AgentBackendAuthenticateResult = await this.#runtime.authenticate({
        threadId: this.threadId,
        methodId,
      });
      if (generation !== this.#generation) return;
      if (methodId === "reconnect") {
        this.retry();
        return;
      }
      this.#acceptSnapshot(result.snapshot);
      await this.#refreshPresentation(generation);
    });

  readonly respond = (requestId: string, response: AgentInteractionResponse): Promise<boolean> =>
    this.#runControl("response", async (generation) => {
      await this.#runtime.respond(this.threadId, requestId, response);
      if (generation === this.#generation) await this.#refreshPresentation(generation);
    });

  readonly close = async (): Promise<void> => {
    const generation = this.#generation;
    await this.#runtime.close(this.threadId);
    if (generation !== this.#generation) return;
    this.#generation += 1;
    this.#releaseSubscription?.();
    this.#releaseSubscription = null;
    this.#pendingDeltas = [];
    this.#resyncPending = false;
    this.#resyncDirty = false;
    this.#patch({
      presentation: null,
      connection: "connecting",
      promptPending: false,
      controlPending: null,
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
    if (!presentation) throw new Error("Agent session is not available");
    this.#acceptPresentation(presentation);
  }

  async #runControl(
    operation: AgentConversationControlOperation,
    run: (generation: number) => Promise<void>,
  ): Promise<boolean> {
    if (this.#state.controlPending) return false;
    const generation = this.#generation;
    this.#patch({ controlPending: operation, error: null });
    try {
      await run(generation);
      return generation === this.#generation;
    } catch (cause) {
      if (generation === this.#generation) this.#patch({ error: errorMessage(cause) });
      return false;
    } finally {
      if (generation === this.#generation) this.#patch({ controlPending: null });
    }
  }

  #acceptPresentation(presentation: AgentBackendSessionPresentation): void {
    const currentSnapshot = this.#state.presentation?.snapshot;
    if (
      presentation.snapshot.sessionId &&
      this.#retiredSessions.has(presentation.snapshot.sessionId)
    )
      return;
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
    if (currentSnapshot?.sessionId && snapshot.sessionId !== currentSnapshot.sessionId)
      this.#retireSession(currentSnapshot.sessionId);
    const base =
      currentSnapshot &&
      currentSnapshot.sessionId === presentation.snapshot.sessionId &&
      currentSnapshot.revision > presentation.snapshot.revision
        ? (this.#state.presentation ?? presentation)
        : presentation;
    this.#patch({ presentation: this.#withMetadata({ ...base, snapshot }) });
    if (this.#pendingDeltas.length > 0) this.#requestResync();
  }

  #acceptSnapshot(snapshot: AgentConversationSnapshot): void {
    const presentation = this.#state.presentation;
    if (!presentation) {
      return;
    }
    if (snapshot.sessionId && this.#retiredSessions.has(snapshot.sessionId)) return;
    if (!shouldAcceptSnapshot(presentation.snapshot, snapshot)) return;
    if (presentation.snapshot.sessionId && snapshot.sessionId !== presentation.snapshot.sessionId)
      this.#retireSession(presentation.snapshot.sessionId);
    const becameIdle = presentation.snapshot.status === "running" && snapshot.status === "idle";
    const currentModeId = snapshot.turns
      .flatMap(({ updates }) => updates)
      .findLast((update) => update.kind === "mode")?.currentModeId;
    this.#patch({
      presentation: this.#withMetadata({
        ...presentation,
        snapshot,
        modes:
          presentation.modes && currentModeId
            ? { ...presentation.modes, currentModeId }
            : presentation.modes,
      }),
    });
    if (becameIdle) this.#requestResync();
  }

  #withMetadata(presentation: AgentBackendSessionPresentation): AgentBackendSessionPresentation {
    const metadata = presentation.snapshot.metadata;
    if (!metadata) return presentation;
    return {
      ...presentation,
      capabilities: metadata.capabilities,
      modes: metadata.modes,
      configOptions: metadata.configOptions,
    };
  }

  #retireSession(sessionId: string): void {
    this.#retiredSessions.add(sessionId);
    if (this.#retiredSessions.size > 64)
      this.#retiredSessions.delete(this.#retiredSessions.values().next().value!);
  }

  #acceptDelta(delta: AgentConversationDelta): void {
    if (this.#retiredSessions.has(delta.sessionId)) return;
    const presentation = this.#state.presentation;
    if (!presentation) {
      this.#pendingDeltas = [...this.#pendingDeltas.slice(-127), delta];
      return;
    }
    if (delta.sessionId !== presentation.snapshot.sessionId) {
      if (this.#resyncPending) this.#resyncDirty = true;
      this.#requestResync();
      return;
    }
    if (delta.revision <= presentation.snapshot.revision) return;
    if (this.#resyncPending) this.#resyncDirty = true;
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
    this.#resyncDirty = false;
    let succeeded = false;
    void this.#refreshPresentation(generation)
      .then(() => {
        succeeded = true;
      })
      .catch((cause) => {
        if (generation !== this.#generation) return;
        this.#patch({ connection: "failed", error: errorMessage(cause) });
      })
      .finally(() => {
        if (generation !== this.#generation) return;
        const followUp = succeeded && this.#resyncDirty;
        this.#resyncPending = false;
        this.#resyncDirty = false;
        if (followUp) this.#requestResync();
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
