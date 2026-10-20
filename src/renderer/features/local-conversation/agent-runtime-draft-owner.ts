import type { AgentModelSelection } from "../../../shared/agent-model-catalog";

interface RuntimeDraft {
  readonly selection?: AgentModelSelection;
  readonly interactionMode: "default" | "plan";
}
const emptyDraft: RuntimeDraft = { interactionMode: "default" };

/**
 * Composer choices that have not reached execution: an unstarted Session's Agent and mode,
 * or a started chat's Agent and model for its next message. Presentations of the same key
 * share one draft; execution begins or changes only through a message sent through Main.
 */
class AgentRuntimeDraftOwner {
  readonly #drafts = new Map<string, RuntimeDraft>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly read = (key: string): RuntimeDraft => this.#drafts.get(key) ?? emptyDraft;
  readonly write = (key: string, patch: Partial<RuntimeDraft>): void => {
    if (!this.#drafts.has(key) && this.#drafts.size >= 256) {
      const oldest = [...this.#drafts.keys()].find((candidate) => !this.#listeners.has(candidate));
      if (!oldest) throw new Error("Too many open Agent drafts");
      this.#drafts.delete(oldest);
    }
    this.#drafts.set(key, { ...this.read(key), ...patch });
    for (const listener of this.#listeners.get(key) ?? []) listener();
  };
  readonly subscribe = (key: string, listener: () => void): (() => void) => {
    const listeners = this.#listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(key);
    };
  };
}
export const agentRuntimeDraftOwner = new AgentRuntimeDraftOwner();
