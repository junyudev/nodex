import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { CodexQueuedMessageState } from "../../../shared/codex-queued-message";
const operation = vi.hoisted(() => vi.fn());
vi.mock("./local-conversation-operations", () => ({ runConversationOperation: operation }));
import { RendererQueuedMessageStorage } from "./renderer-queued-message-storage";

afterEach(() => { vi.restoreAllMocks(); operation.mockReset(); });
describe("window queued message storage", () => {
  test("serializes updates under the shared browser lock and rereads the durable document", async () => {
    let state: CodexQueuedMessageState = {};
    const seen: string[] = [];
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (name: string, callback: () => Promise<void>) => { seen.push(name); await callback(); } } });
    operation.mockImplementation(async (name: string, value?: CodexQueuedMessageState) => {
      if (name.endsWith(":read")) return state;
      if (name.endsWith(":write")) state = value!;
    });
    const storage = new RendererQueuedMessageStorage();
    await storage.load();
    state = { external: [] };
    await storage.update((current) => ({ ...current, local: [] }));
    expect(state).toEqual({ external: [], local: [] });
    expect(seen).toEqual(["codex-queued-follow-up-state"]);
    expect(storage.read()).toEqual({ isLoading: false, value: state });
  });
  test("a durable invalidation during loading prevents stale cache resurrection", async () => {
    let complete!: (state: CodexQueuedMessageState) => void;
    operation.mockImplementationOnce(() => new Promise<CodexQueuedMessageState>((resolve) => { complete = resolve; })).mockResolvedValueOnce({ fresh: [] });
    const storage = new RendererQueuedMessageStorage();
    const loaded = storage.load();
    storage.invalidate();
    complete({ stale: [] });
    await expect(loaded).resolves.toEqual({ fresh: [] });
    expect(storage.read().value).toEqual({ fresh: [] });
  });
});
