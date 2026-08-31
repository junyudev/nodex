export type NewThreadBackendSelection = "codex" | { readonly acpInstanceId: string };

const sameSelection = (
  left: NewThreadBackendSelection,
  right: NewThreadBackendSelection,
): boolean =>
  left === right ||
  (typeof left === "object" &&
    typeof right === "object" &&
    left.acpInstanceId === right.acpInstanceId);

/**
 * Shares the ephemeral backend choice between a Session's primary page and its composer dock.
 * It deliberately owns no durable backend binding; Core receives that only when a Thread starts.
 */
export class NewThreadBackendSelectionOwner {
  readonly #selections = new Map<string, NewThreadBackendSelection>();
  readonly #listeners = new Map<string, Set<() => void>>();

  readonly read = (sessionId: string): NewThreadBackendSelection =>
    this.#selections.get(sessionId) ?? "codex";

  readonly write = (sessionId: string, selection: NewThreadBackendSelection): void => {
    if (sameSelection(this.read(sessionId), selection)) return;
    if (selection === "codex") this.#selections.delete(sessionId);
    else this.#selections.set(sessionId, selection);
    for (const listener of this.#listeners.get(sessionId) ?? []) listener();
  };

  readonly subscribe = (sessionId: string, listener: () => void): (() => void) => {
    const listeners = this.#listeners.get(sessionId) ?? new Set<() => void>();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(sessionId);
    };
  };
}

export const newThreadBackendSelectionOwner = new NewThreadBackendSelectionOwner();
