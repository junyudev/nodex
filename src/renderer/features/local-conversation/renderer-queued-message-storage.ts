import type { CodexQueuedMessage, CodexQueuedMessageState } from "../../../shared/codex-queued-message";
import type { QueuedMessageStorage } from "../../../shared/codex-queued-message-coordinator";
import { runConversationOperation } from "./local-conversation-operations";

/** One window cache; the browser lock serializes read/modify/write across windows. */
export class RendererQueuedMessageStorage implements QueuedMessageStorage<CodexQueuedMessage> {
  private value: CodexQueuedMessageState | undefined;
  private loading: Promise<CodexQueuedMessageState> | undefined;
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  read(): { isLoading: boolean; value?: CodexQueuedMessageState } {
    return { isLoading: this.value === undefined, value: this.value };
  }
  load(): Promise<CodexQueuedMessageState> {
    if (this.value !== undefined) return Promise.resolve(this.value);
    if (this.loading) return this.loading;
    const load = async (): Promise<CodexQueuedMessageState> => {
      for (;;) {
        const revision = this.revision;
        const state = await runConversationOperation("codex:queued-messages:read");
        if (revision !== this.revision) continue;
        this.value = state;
        return state;
      }
    };
    const loading = load().finally(() => { if (this.loading === loading) this.loading = undefined; });
    this.loading = loading;
    return loading;
  }
  update(recipe: (state: CodexQueuedMessageState) => CodexQueuedMessageState): Promise<void> {
    return navigator.locks.request("codex-queued-follow-up-state", async () => {
      const current = await runConversationOperation("codex:queued-messages:read");
      const next = recipe(current);
      await runConversationOperation("codex:queued-messages:write", next);
      this.revision++;
      this.value = next;
    });
  }
  invalidate(): void {
    this.revision++;
    this.value = undefined;
    for (const listener of this.listeners) listener();
    if (!this.listeners.size) return;
    void this.load().then(() => { for (const listener of this.listeners) listener(); }).catch((error: unknown) => console.error("Queued message refresh failed", error));
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
export const rendererQueuedMessageStorage = new RendererQueuedMessageStorage();
