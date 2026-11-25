import { describe, expect, test, it, vi } from "vite-plus/test";
import {
  COMPOSER_ENTER_BEHAVIOR_STORAGE_KEY,
  DEFAULT_COMPOSER_ENTER_BEHAVIOR,
  normalizeComposerEnterBehavior,
  readComposerEnterBehavior,
  writeComposerEnterBehavior,
} from "./composer-enter-behavior";
import type { CodexConversationSnapshot } from "@/lib/types";
import { resolveContextWindowIndicatorState } from "./context-window";
import type { AgentRuntimeSessionEvent } from "../../shared/agent-runtime-api";
import type { PromptTurnEntry } from "../../shared/prompt-turn";
import { createPromptTurnStore } from "./prompt-turn";
import fixtures from "../../shared/fixtures/task-shorthand-v1-conformance.json";
import { previewTaskShorthand, previewTaskShorthandInlineContent } from "./task-shorthand-preview";

describe("composer enter behavior", () => {
  const storageMap = new Map<string, string>();

  const mockStorage = {
    getItem(key: string): string | null {
      return storageMap.has(key) ? (storageMap.get(key) ?? null) : null;
    },
    setItem(key: string, value: string): void {
      storageMap.set(key, value);
    },
    removeItem(key: string): void {
      storageMap.delete(key);
    },
    clear(): void {
      storageMap.clear();
    },
  };

  function withMockLocalStorage(run: () => void): void {
    const storageGlobal = globalThis as { localStorage?: typeof mockStorage };
    const previousLocalStorage = storageGlobal.localStorage;
    storageGlobal.localStorage = mockStorage;
    try {
      run();
    } finally {
      if (previousLocalStorage) {
        storageGlobal.localStorage = previousLocalStorage;
        return;
      }
      delete storageGlobal.localStorage;
    }
  }

  describe("composer enter behavior", () => {
    test("defaults to enter and normalizes known values", () => {
      withMockLocalStorage(() => {
        mockStorage.clear();
        expect(normalizeComposerEnterBehavior(undefined)).toBe(DEFAULT_COMPOSER_ENTER_BEHAVIOR);
        expect(normalizeComposerEnterBehavior("enter")).toBe("enter");
        expect(normalizeComposerEnterBehavior("cmdIfMultiline")).toBe("cmdIfMultiline");
        expect(normalizeComposerEnterBehavior("cmd-if-multiline")).toBe("cmdIfMultiline");
        expect(normalizeComposerEnterBehavior("unexpected")).toBe(DEFAULT_COMPOSER_ENTER_BEHAVIOR);
      });
    });

    test("reads and writes persisted values", () => {
      withMockLocalStorage(() => {
        mockStorage.clear();
        expect(readComposerEnterBehavior()).toBe(DEFAULT_COMPOSER_ENTER_BEHAVIOR);

        const persisted = writeComposerEnterBehavior("cmdIfMultiline");
        expect(persisted).toBe("cmdIfMultiline");
        expect(mockStorage.getItem(COMPOSER_ENTER_BEHAVIOR_STORAGE_KEY)).toBe("cmdIfMultiline");
        expect(readComposerEnterBehavior()).toBe("cmdIfMultiline");
      });
    });
  });
});

describe("context window", () => {
  function makeConversation(): CodexConversationSnapshot {
    return {
      threadId: "thr_context",
      projectId: "project-1",
      source: null,
      threadName: "Context thread",
      threadPreview: "",
      modelProvider: "openai",
      cwd: "/tmp/project",
      statusType: "active",
      statusActiveFlags: [],
      archived: false,
      createdAt: 1,
      updatedAt: 2,
      linkedAt: new Date(0).toISOString(),
      resumeState: "resumed",
      turns: [],
      requests: [],
      queuedFollowUps: {
        status: "ready",
        ledgerRevision: 0,
        projectionRevision: 0,
        entries: [],
        inFlightFollowUpId: null,
        editingFollowUpId: null,
        error: null,
      },
      pendingSteers: [],
      backgroundTerminalRows: [],
      capabilityFlags: {
        canEditUserTurns: true,
        canForkFromTurn: true,
        canSearch: true,
        canCollapseTurns: true,
      },
    };
  }

  describe("codex context window indicator", () => {
    test("uses measured current context independently of cumulative and per-turn token accounting", () => {
      const conversation = makeConversation();
      conversation.contextUsage = { used: 15, size: 200000 };
      conversation.latestTokenUsageInfo = {
        total: {
          totalTokens: 900000,
          inputTokens: 900000,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 300000,
          inputTokens: 300000,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 1000000,
      };
      expect(resolveContextWindowIndicatorState(conversation)).toEqual({
        status: "ready",
        percentFull: 0,
        usedTokens: 15,
        windowTokens: 200000,
      });
      conversation.contextUsage = { used: 20, size: 0 };
      expect(resolveContextWindowIndicatorState(conversation)).toMatchObject({
        status: "usageOnly",
        usedTokens: 20,
        windowTokens: null,
      });
    });
    test("keeps the raw token count when usage exceeds the model context window", () => {
      const conversation = makeConversation();
      conversation.latestTokenUsageInfo = {
        total: {
          totalTokens: 300_000,
          inputTokens: 260_000,
          cachedInputTokens: 10_000,
          cacheWriteInputTokens: 0,
          outputTokens: 40_000,
          reasoningOutputTokens: 5_000,
        },
        last: {
          totalTokens: 300_000,
          inputTokens: 260_000,
          cachedInputTokens: 10_000,
          cacheWriteInputTokens: 0,
          outputTokens: 40_000,
          reasoningOutputTokens: 5_000,
        },
        modelContextWindow: 258_000,
      };

      const state = resolveContextWindowIndicatorState(conversation);

      expect(state.status).toBe("ready");
      expect(state.percentFull).toBe(100);
      expect(state.usedTokens).toBe(300_000);
      expect(state.windowTokens).toBe(258_000);
    });

    test("ignores stale token usage while conversation is not resumed", () => {
      const conversation = makeConversation();
      conversation.resumeState = "needs_resume";
      conversation.latestTokenUsageInfo = {
        total: {
          totalTokens: 100,
          inputTokens: 70,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 30,
          reasoningOutputTokens: 5,
        },
        last: {
          totalTokens: 100,
          inputTokens: 70,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 30,
          reasoningOutputTokens: 5,
        },
        modelContextWindow: 1000,
      };

      const state = resolveContextWindowIndicatorState(conversation);

      expect(state.status).toBe("unavailable");
      expect(state.usedTokens).toBe(null);
    });
  });

  test("unknown measurements and missing capacity remain distinct from measured zero", () => {
    const conversation = makeConversation();
    expect(resolveContextWindowIndicatorState(conversation)).toEqual({
      status: "unavailable",
      percentFull: null,
      usedTokens: null,
      windowTokens: null,
    });
    conversation.contextUsage = { used: 42_000, size: 0 };
    expect(resolveContextWindowIndicatorState(conversation)).toEqual({
      status: "usageOnly",
      percentFull: null,
      usedTokens: 42_000,
      windowTokens: null,
    });
    conversation.contextUsage = { used: 0, size: 200_000 };
    expect(resolveContextWindowIndicatorState(conversation)).toEqual({
      status: "ready",
      percentFull: 0,
      usedTokens: 0,
      windowTokens: 200_000,
    });
    conversation.contextUsage = { used: NaN, size: 200_000 };
    expect(resolveContextWindowIndicatorState(conversation).status).toBe("unavailable");
  });
});

describe("prompt turn", () => {
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  function harness() {
    let listener: (event: AgentRuntimeSessionEvent) => void = () => {};
    let entries: readonly PromptTurnEntry[] = [];
    const release = vi.fn();
    const source = {
      read: vi.fn(
        async ({
          messageIds,
        }: {
          messageIds: readonly string[];
        }): Promise<readonly PromptTurnEntry[]> =>
          entries.filter((entry) => messageIds.includes(entry.messageId)),
      ),
      subscribe: vi.fn(async (_session: string, next: typeof listener) => {
        listener = next;
        return release;
      }),
    };
    return {
      source,
      release,
      store: createPromptTurnStore(source),
      set: (next: typeof entries) => {
        entries = next;
      },
      reset: () =>
        listener({
          type: "reset-required",
          sessionId: "chat",
          threadId: "root",
          reason: "runtime-restarted",
        }),
    };
  }
  describe("Prompt Turn store", () => {
    it("shares a chat subscription, batches reads, and releases the last observer", async () => {
      const h = harness();
      h.set([
        { messageId: "first", phase: "done", reply: "Answer", runId: "old" },
        { messageId: "second", phase: "working", reply: null, runId: "new" },
      ]);
      const first = { sessionId: "chat", messageId: "first" };
      const second = { sessionId: "chat", messageId: "second" };
      const stopA = h.store.subscribe(first, vi.fn());
      const stopB = h.store.subscribe(first, vi.fn());
      const stopC = h.store.subscribe(second, vi.fn());
      await settle();
      expect(h.source.subscribe).toHaveBeenCalledTimes(1);
      expect(h.source.read.mock.calls[0]?.[0].messageIds).toEqual(["first", "second"]);
      expect(h.store.read(first)).toMatchObject({ phase: "done", reply: "Answer" });
      expect(h.store.read(second).phase).toBe("working");
      stopA();
      stopB();
      expect(h.release).not.toHaveBeenCalled();
      stopC();
      expect(h.release).toHaveBeenCalledOnce();
    });
    it("bounds batches and acquires nothing for a missing message anchor", async () => {
      const h = harness();
      const stops = Array.from({ length: 205 }, (_, index) =>
        h.store.subscribe({ sessionId: "chat", messageId: `m${index}` }, () => {}),
      );
      h.store.subscribe({ sessionId: "legacy", messageId: "" }, () => {})();
      await settle();
      expect(h.source.read.mock.calls.map(([input]) => input.messageIds.length)).toEqual([
        100, 100, 5,
      ]);
      expect(h.source.subscribe).toHaveBeenCalledTimes(1);
      stops.forEach((stop) => stop());
    });
    it("discards stale responses after release and repairs reset events", async () => {
      const h = harness();
      let resolve!: (entries: readonly PromptTurnEntry[]) => void;
      h.source.read.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const target = { sessionId: "chat", messageId: "first" };
      const stop = h.store.subscribe(target, () => {});
      await settle();
      h.reset();
      h.set([{ messageId: "first", phase: "waiting", reply: null, runId: "run" }]);
      resolve([{ messageId: "first", phase: "working", reply: null, runId: "run" }]);
      await settle();
      expect(h.store.read(target).phase).toBe("waiting");
      stop();
      expect(h.store.read(target).phase).toBe("unknown");
    });
  });
});

describe("task shorthand preview", () => {
  it.each(fixtures)("keeps preview grammar aligned for $title", (fixture) => {
    const result = previewTaskShorthand(fixture.title);
    expect(Boolean(result)).toBe(fixture.match);
    if (!fixture.match || !result) return;
    expect(result).toMatchObject({
      priority: fixture.priority,
      estimate: fixture.estimate,
      tags: fixture.tags,
      title: fixture.rewrittenTitle,
    });
  });

  it("recognizes only prefixes completed before a rich-title boundary", () => {
    expect(
      previewTaskShorthandInlineContent([
        { type: "text", text: "1XL ", styles: {} },
        {
          type: "link",
          href: "https://nodex.dev",
          content: [{ type: "text", text: "Fix import", styles: {} }],
        },
      ]),
    ).toMatchObject({ priority: 1, estimate: "XL" });
    expect(
      previewTaskShorthandInlineContent([
        { type: "text", text: "1", styles: {} },
        {
          type: "link",
          href: "https://nodex.dev",
          content: [{ type: "text", text: "XL", styles: {} }],
        },
        { type: "text", text: " Fix import", styles: {} },
      ]),
    ).toBeNull();
    expect(
      previewTaskShorthandInlineContent([
        { type: "text", text: "4abc", styles: {} },
        { type: "pageMention", props: { targetPageId: "page-1" } },
      ]),
    ).toBeNull();
  });
});
