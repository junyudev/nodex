import type { ClaudeModelSelection } from "../../shared/claude-models";
import type { AgentModelSelection } from "../../shared/agent-model-catalog";
import type { AgentBackendBinding } from "../../shared/agent-backend";

export const nativeAgentDraftKey = (
  sessionId: string,
  projectId: string | null,
  binding: Exclude<AgentBackendBinding, { kind: "codex" }> | null,
): string =>
  JSON.stringify([
    sessionId,
    projectId,
    binding?.kind,
    binding?.instanceConfigId,
    ...(binding?.kind === "acp" ? [binding.agentDefinitionId] : []),
  ]);

export interface NativeAgentDraft {
  readonly selection: ClaudeModelSelection;
  readonly mode: "default" | "plan";
  readonly options?: AgentModelSelection["options"];
  readonly modeId?: string;
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
