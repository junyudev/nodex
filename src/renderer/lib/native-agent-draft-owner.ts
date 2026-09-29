import type { ClaudeModelSelection } from "../../shared/claude-models";

export interface NativeAgentDraft {
  readonly selection: ClaudeModelSelection;
  readonly mode: "default" | "plan";
}
const defaultDraft: NativeAgentDraft = {
  selection: { model: "default", effort: "default" },
  mode: "default",
};

/** One draft choice is shared by all presentations of the same Session, Project and profile. */
export class NativeAgentDraftOwner {
  readonly #drafts = new Map<string, NativeAgentDraft>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly read = (key: string): NativeAgentDraft => this.#drafts.get(key) ?? defaultDraft;
  readonly write = (key: string, patch: Partial<NativeAgentDraft>) => {
    if (!this.#drafts.has(key) && this.#drafts.size >= 256) {
      const oldest = [...this.#drafts.keys()].find((candidate) => !this.#listeners.has(candidate));
      if (oldest) this.#drafts.delete(oldest);
      else throw new Error("Too many open Agent drafts");
    }
    this.#drafts.set(key, { ...this.read(key), ...patch });
    for (const listener of this.#listeners.get(key) ?? []) listener();
  };
  readonly clear = (key: string) => {
    this.#drafts.delete(key);
    for (const listener of this.#listeners.get(key) ?? []) listener();
  };
  readonly subscribe = (key: string, listener: () => void) => {
    const listeners = this.#listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(key);
    };
  };
}
export const nativeAgentDraftOwner = new NativeAgentDraftOwner();
