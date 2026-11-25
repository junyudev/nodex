import { expect, it, vi, describe, test, afterEach } from "vite-plus/test";
import type { AgentRuntimeInspection } from "../../../shared/agent-runtime-api";
import { createChatMessageRevealStore, createOpenChatAtMessage } from "./chat-message-navigation";
import type {
  CodexPromptRailIndex,
  CodexPromptRailIndexRequest,
  CodexPromptRailReveal,
  CodexPromptRailRevealRequest,
} from "../../../shared/codex-prompt-rail-history";
import {
  createCodexPromptRailPort,
  resolveCodexPromptRailRevealTarget,
  type CodexPromptRailClient,
} from "./codex-prompt-rail-port";
import type { CodexPerformanceSpan } from "../../lib/codex-performance-span";
import { CodexThreadNavigation } from "./codex-thread-navigation";
import {
  RuntimeConversationNavigation,
  type RuntimeNavigationRecord,
} from "./runtime-conversation-navigation";

describe("chat message navigation", () => {
  const inspection = {
    sessionId: "chat",
    projectId: "project",
    threadId: "root",
  } as AgentRuntimeInspection;
  it("opens the chat with an exact message reveal, preserving the chat's Project", async () => {
    const openSession = vi.fn();
    const store = createChatMessageRevealStore();
    const open = createOpenChatAtMessage({
      inspect: async () => inspection,
      openSession,
      reveal: store.request,
    });
    expect(await open({ sessionId: "chat", messageId: "message" })).toBe(true);
    expect(openSession).toHaveBeenCalledWith({ id: "chat", projectId: "project" });
    const first = store.read()!;
    expect(first).toEqual({ sessionId: "chat", threadId: "root", messageId: "message" });
    await open({ sessionId: "chat", messageId: "newer" });
    store.consume(first);
    expect(store.read()?.messageId).toBe("newer");
    store.consume(store.read()!);
    expect(store.read()).toBeNull();
  });
  it("ignores a missing chat and superseded asynchronous navigation", async () => {
    let resolve!: (value: AgentRuntimeInspection) => void;
    const inspect = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockRejectedValueOnce(new Error("Deleted"));
    const openSession = vi.fn();
    const open = createOpenChatAtMessage({ inspect, openSession, reveal: vi.fn() });
    const old = open({ sessionId: "old", messageId: "message" });
    expect(await open({ sessionId: "missing", messageId: "message" })).toBe(false);
    resolve(inspection);
    expect(await old).toBe(false);
    expect(openSession).not.toHaveBeenCalled();
  });
});

describe("codex prompt rail port", () => {
  const index = (count: number): CodexPromptRailIndex => ({
    threadId: "thread-a",
    hostId: "host-a",
    generation: 8,
    shells: Array.from({ length: count }, (_, position) => ({
      turnId: `turn-${position + 1}`,
      pageBackwardsCursor: `cursor-${Math.floor(position / 100)}`,
      descendingOffset: position % 100,
    })),
    complete: count < 1_000,
    truncatedBy: count === 1_000 ? "page-budget" : null,
    approximateBytes: count * 64,
    loadedAtMs: 1_000,
  });

  const reveal = (
    request: CodexPromptRailRevealRequest,
    overrides: Partial<CodexPromptRailReveal> = {},
  ): CodexPromptRailReveal => {
    const turnId =
      request.target.kind === "shell" ? request.target.shell.turnId : request.target.turnId;
    return {
      threadId: request.threadId,
      hostId: request.hostId,
      generation: request.generation,
      turnId,
      topologyGeneration: request.expectedTopologyGeneration,
      previews: [
        {
          itemId: `${turnId}:prompt`,
          promptPreview: `Prompt for ${turnId}`,
          responsePreview: "",
          isHeartbeat: false,
        },
      ],
      turnCursor: `cursor:${turnId}`,
      ...overrides,
    };
  };

  const client = (
    overrides: Partial<CodexPromptRailClient> = {},
  ): CodexPromptRailClient & { readonly reveals: CodexPromptRailRevealRequest[] } => {
    const reveals: CodexPromptRailRevealRequest[] = [];
    return {
      reveals,
      loadPromptRailIndex: vi.fn(async (request: CodexPromptRailIndexRequest) => ({
        status: "completed" as const,
        requestId: request.requestId,
        expectedTopologyGeneration: request.expectedTopologyGeneration,
        index: index(1_000),
      })),
      revealPromptRail: vi.fn(async (request: CodexPromptRailRevealRequest) => {
        reveals.push(request);
        return {
          status: "completed" as const,
          requestId: request.requestId,
          expectedTopologyGeneration: request.expectedTopologyGeneration,
          reveal: reveal(request),
        };
      }),
      preparePromptRailNavigation: vi.fn(async () => undefined),
      ...overrides,
    };
  };

  const signal = () => new AbortController().signal;

  describe("Codex prompt rail port", () => {
    test("indexes item-free shells, previews without installing, and installs a revalidated Turn", async () => {
      const native = client();
      const port = createCodexPromptRailPort({
        client: native,
        threadId: "thread-a",
        topologyGeneration: 12,
      });

      const turns = await port.loadIndex(signal());
      expect(turns).toHaveLength(1_000);
      expect(turns?.[0]).toEqual({ turnId: "turn-1" });
      expect(native.revealPromptRail).not.toHaveBeenCalled();

      expect((await port.preview?.("turn-500", signal()))?.[0]?.promptPreview).toBe(
        "Prompt for turn-500",
      );
      expect(native.reveals[0]).toMatchObject({
        hostId: "host-a",
        generation: 8,
        expectedTopologyGeneration: 12,
        target: { kind: "shell", shell: { turnId: "turn-500", descendingOffset: 99 } },
      });
      expect(native.preparePromptRailNavigation).not.toHaveBeenCalled();

      expect(await port.install("turn-500", signal())).toBe("applied");
      expect(native.reveals).toHaveLength(2);
      expect(native.preparePromptRailNavigation).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: "turn-500", turnCursor: "cursor:turn-500" }),
      );
    });

    test("seeks a known Turn beyond the 1,000-shell window by identity", () => {
      expect(resolveCodexPromptRailRevealTarget(index(1_000), "turn-1000").kind).toBe("shell");
      expect(resolveCodexPromptRailRevealTarget(index(1_000), "turn-1001")).toEqual({
        kind: "knownTurn",
        turnId: "turn-1001",
      });
    });

    test("unavailable or foreign index results leave the rail on resident messages", async () => {
      const unavailable = createCodexPromptRailPort({
        client: client({
          loadPromptRailIndex: async (request) => ({
            status: "unavailable",
            requestId: request.requestId,
            availability: {
              status: "unavailable",
              feature: "prompt-rail",
              reason: "capability-unproven",
              threadId: "thread-a",
              hostId: "host-a",
              hostGeneration: 8,
              sourceEpoch: "epoch-a",
              appServerVersion: "0.0.0",
              historyMode: "paginated",
            },
          }),
        }),
        threadId: "thread-a",
        topologyGeneration: 12,
      });
      expect(await unavailable.loadIndex(signal())).toBeNull();

      const stale = createCodexPromptRailPort({
        client: client({
          loadPromptRailIndex: async (request) => ({
            status: "completed",
            requestId: request.requestId,
            expectedTopologyGeneration: 11,
            index: index(4),
          }),
        }),
        threadId: "thread-a",
        topologyGeneration: 12,
      });
      expect(await stale.loadIndex(signal())).toBeNull();
      expect(await stale.install("turn-1", signal())).toBe("stale");
    });

    test("never installs a reveal from another host or topology, or after navigation stops", async () => {
      for (const overrides of [{ hostId: "foreign-host" }, { topologyGeneration: 13 }]) {
        const native = client({
          revealPromptRail: async (request) => ({
            status: "completed",
            requestId: request.requestId,
            expectedTopologyGeneration: request.expectedTopologyGeneration,
            reveal: reveal(request, overrides),
          }),
        });
        const port = createCodexPromptRailPort({
          client: native,
          threadId: "thread-a",
          topologyGeneration: 12,
        });
        await port.loadIndex(signal());
        expect(await port.install("turn-1", signal())).toBe("stale");
        expect(native.preparePromptRailNavigation).not.toHaveBeenCalled();
      }

      const native = client();
      const port = createCodexPromptRailPort({
        client: native,
        threadId: "thread-a",
        topologyGeneration: 12,
      });
      await port.loadIndex(signal());
      const stopped = new AbortController();
      stopped.abort();
      expect(await port.install("turn-1", stopped.signal)).toBe("stale");
      expect(native.preparePromptRailNavigation).not.toHaveBeenCalled();
    });
  });
});

describe("codex thread navigation", () => {
  function harness() {
    const spans: Array<{
      marks: string[];
      measures: string[];
      ended: string[];
      outcomes: string[];
      attributes: unknown;
    }> = [];
    const owner = new CodexThreadNavigation((attributes, onTerminal) => {
      const state = {
        marks: [] as string[],
        measures: [] as string[],
        ended: [] as string[],
        outcomes: [] as string[],
        attributes,
      };
      spans.push(state);
      const finish = (outcome: string) => {
        state.outcomes.push(outcome);
        onTerminal();
      };
      const span: CodexPerformanceSpan = {
        trace: { traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" },
        isRecording: () => state.outcomes.length === 0,
        mark: (name) => {
          state.marks.push(name);
        },
        measure: (name) => {
          state.measures.push(name);
          let ended = false;
          return {
            end: () => {
              if (!ended) state.ended.push(name);
              ended = true;
            },
          };
        },
        abort: (reason) => finish(`aborted:${reason}`),
        fail: (reason) => finish(`failed:${reason}`),
        end: () => finish("success"),
        recordAnalyticsSuccess: () => true,
      };
      return span;
    });
    return { owner, spans };
  }

  describe("Thread navigation measurement owner", () => {
    it("supersedes A and ignores its late hydration and paint while B is pending", () => {
      const { owner, spans } = harness();
      owner.start("a", "cold");
      owner.hydrationStarted("a");
      owner.start("b", "warm");
      owner.hydrationFinished("a");
      owner.historyReady("a");
      owner.complete("a");
      expect(spans[0]?.outcomes).toEqual(["aborted:superseded"]);
      expect(owner.isPending("b")).toBe(true);
      owner.hydrationStarted("b");
      owner.hydrationFinished("b");
      owner.historyReady("b");
      owner.complete("b");
      owner.complete("b");
      expect(spans[1]?.marks).toEqual([
        "navigation_dispatched",
        "hydration_started",
        "hydration_finished",
        "history_ready",
        "content_visible",
      ]);
      expect(spans[1]?.ended).toEqual(["thread.navigation_wait", "thread.render_wait"]);
      expect(spans[1]?.outcomes).toEqual(["success"]);
      expect(owner.isPending("b")).toBe(false);
      expect(owner.getTrace("a")).toBeNull();
    });

    it("keeps selected view identity while an older view cleanup runs", () => {
      const { owner, spans } = harness();
      const old = owner.viewEntered("a", { kind: "detail" });
      const current = owner.viewEntered("b", { kind: "side_chat" });
      old();
      owner.start("b", "warm", "local", "route_entered");
      expect(spans[0]?.attributes).toMatchObject({ view: { kind: "side_chat" } });
      current();
      owner.viewEntered("b", { kind: "detail" });
      expect(spans[0]?.attributes).toMatchObject({ view: { kind: "detail" } });
      owner.dispose();
      expect(spans[0]?.outcomes).toEqual(["aborted:app_disposed"]);
    });

    it("settles failures, cancellation and navigation away once", () => {
      const { owner, spans } = harness();
      owner.start("a", "cold");
      owner.hydrationFailed("a", new Error("native unavailable"));
      owner.hydrationFailed("a", new Error("duplicate"));
      owner.start("b", "cold");
      owner.hydrationFailed("b", new DOMException("canceled", "AbortError"));
      owner.start("c", "warm");
      owner.routeChanged("c");
      expect(owner.isPending("c")).toBe(true);
      owner.routeChanged(null);
      owner.dispose();
      expect(spans.map((span) => span.outcomes)).toEqual([
        ["failed:hydration_failed"],
        ["aborted:hydration_canceled"],
        ["aborted:navigation_away"],
      ]);
    });
  });
});

describe("runtime conversation navigation", () => {
  const chat = { sessionId: "session", threadId: "thread" };
  const other = { sessionId: "other", threadId: "other-thread" };

  function setup(options: { readonly local?: boolean; readonly tracing?: boolean } = {}) {
    let now = 1_000;
    const records: RuntimeNavigationRecord[] = [];
    const spans: { readonly marks: string[]; terminal: string | null }[] = [];
    const navigation = new RuntimeConversationNavigation({
      now: () => now,
      recordsLocally: () => options.local ?? true,
      report: (record) => records.push(record),
      startSpan: (): CodexPerformanceSpan => {
        const span = { marks: [] as string[], terminal: null as string | null };
        spans.push(span);
        return {
          trace: null,
          abort: (reason) => {
            span.terminal = `aborted:${reason}`;
          },
          end: () => {
            span.terminal = "success";
          },
          fail: (reason) => {
            span.terminal = `failure:${reason}`;
          },
          isRecording: () => options.tracing ?? false,
          mark: (name) => span.marks.push(name),
          measure: () => ({ end: () => {} }),
          recordAnalyticsSuccess: () => false,
        };
      },
    });
    return {
      navigation,
      records,
      spans,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Runtime conversation navigation", () => {
    test("records dispatch through first painted content without trace sampling", () => {
      const { navigation, records, advance } = setup();
      navigation.dispatch(chat, { resident: false });
      expect(navigation.workId(chat)).toBe("nav-1");
      const leave = navigation.enter(chat, { resident: false, provider: "claude" });
      for (const stage of [
        "snapshot_requested",
        "snapshot_received",
        "projection_installed",
      ] as const) {
        advance(10);
        navigation.mark(chat, stage);
      }
      advance(5);
      navigation.committed(chat, false);
      advance(20);
      navigation.visible(chat);
      leave();

      expect(records).toEqual([
        {
          attempt: 1,
          workId: "nav-1",
          cohort: "cold",
          provider: "claude",
          stages: {
            navigation_dispatched: 0,
            route_entered: 0,
            snapshot_requested: 10,
            snapshot_received: 20,
            projection_installed: 30,
            content_committed: 35,
          },
          outcome: "success",
          reason: "content_visible",
          durationMs: 55,
          work: null,
        },
      ]);
      expect(navigation.workId(chat)).toBeNull();
    });

    test("names its cohort from what the window already holds", () => {
      const { navigation, records } = setup();
      for (const resident of [false, false, true]) {
        navigation.dispatch(chat, { resident });
        navigation.committed(chat, false);
        navigation.visible(chat);
      }
      expect(records.map((record) => record.cohort)).toEqual(["cold", "warm", "cache"]);
    });

    test("ends a conversation without items as visibly empty, and nothing before a commit", () => {
      const { navigation, records } = setup();
      navigation.dispatch(chat, { resident: false });
      navigation.visible(chat);
      expect(records).toEqual([]);
      navigation.committed(chat, true);
      navigation.visible(chat);
      expect(records.map(({ outcome, reason }) => ({ outcome, reason }))).toEqual([
        { outcome: "success", reason: "empty_visible" },
      ]);
    });

    test("gives cancelled, superseded, re-entered and failed navigations their own outcome", () => {
      const { navigation, records } = setup();
      navigation.dispatch(chat, { resident: false });
      navigation.routeChanged(null);
      navigation.dispatch(chat, { resident: false });
      navigation.dispatch(other, { resident: false });
      navigation.dispatch(other, { resident: false });
      navigation.mark(other, "snapshot_requested");
      navigation.failed(other);
      navigation.dispatch(chat, { resident: false });
      navigation.dispose();
      expect(records.map(({ attempt, outcome, reason }) => ({ attempt, outcome, reason }))).toEqual(
        [
          { attempt: 1, outcome: "aborted", reason: "navigation_away" },
          { attempt: 2, outcome: "aborted", reason: "superseded" },
          { attempt: 3, outcome: "aborted", reason: "reentered" },
          { attempt: 4, outcome: "failure", reason: "snapshot_failed" },
          { attempt: 5, outcome: "aborted", reason: "app_disposed" },
        ],
      );
    });

    test("survives a surface remount and ends once every surface has left", () => {
      vi.useFakeTimers();
      const { navigation, records } = setup();
      const first = navigation.enter(chat, { resident: false, provider: "codex" });
      first();
      const remounted = navigation.enter(chat, { resident: false, provider: "codex" });
      vi.runAllTimers();
      expect(navigation.isPending(chat)).toBe(true);
      remounted();
      vi.runAllTimers();
      expect(records.map(({ outcome, reason, stages }) => ({ outcome, reason, stages }))).toEqual([
        {
          outcome: "aborted",
          reason: "navigation_away",
          stages: { navigation_dispatched: 0, route_entered: 0 },
        },
      ]);
    });

    test("exports to tracing alone when local metrics are off, and costs nothing with neither", () => {
      const traced = setup({ local: false, tracing: true });
      traced.navigation.dispatch(chat, { resident: false });
      traced.navigation.mark(chat, "snapshot_requested");
      traced.navigation.committed(chat, false);
      traced.navigation.visible(chat);
      expect(traced.records).toEqual([]);
      expect(traced.spans[0]).toEqual({
        marks: ["navigation_dispatched", "snapshot_requested", "content_committed"],
        terminal: "success",
      });

      const silent = setup({ local: false, tracing: false });
      silent.navigation.dispatch(chat, { resident: false });
      expect(silent.navigation.isPending(chat)).toBe(false);
      expect(silent.navigation.workId(chat)).toBeNull();
    });
  });
});
