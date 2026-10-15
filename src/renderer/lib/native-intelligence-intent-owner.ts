import type { ClaudeModelSelection } from "../../shared/claude-models";

/**
 * A live Claude thread reports only the selection its runtime applied, which is fitted to the
 * current model. The user's unfitted intent is kept here so preferences the current model cannot
 * honor return on a later model change.
 */
export class NativeIntelligenceIntentOwner {
  readonly #intents = new Map<string, ClaudeModelSelection>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly read = (threadId: string): ClaudeModelSelection | undefined =>
    this.#intents.get(threadId);
  readonly write = (threadId: string, intent: ClaudeModelSelection) => {
    this.#intents.delete(threadId);
    this.#intents.set(threadId, intent);
    if (this.#intents.size > 256) this.#intents.delete(this.#intents.keys().next().value!);
    for (const listener of this.#listeners.get(threadId) ?? []) listener();
  };
  readonly subscribe = (threadId: string, listener: () => void) => {
    const listeners = this.#listeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(threadId);
    };
  };
}
export const nativeIntelligenceIntentOwner = new NativeIntelligenceIntentOwner();
