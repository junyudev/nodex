import { describe, expect, test, vi } from "vite-plus/test";
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
