import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { CodexConversationHistoryMutation } from "../../../../shared/codex-conversation-history-page";
import type {
  CodexPromptRailIndex,
  CodexPromptRailReveal,
  CodexPromptRailRevealCommandResult,
  CodexPromptRailRevealRequest,
} from "../../../../shared/codex-prompt-rail-history";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import {
  useLocalConversationPromptRail,
  type LocalConversationPromptRailClient,
} from "./use-local-conversation-prompt-rail";

const index = (count = 1_000): CodexPromptRailIndex => ({
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

const revealMutation = (
  turnId: string,
  requestId: string,
  expectedTopologyGeneration: number,
): CodexConversationHistoryMutation => ({
  origin: {
    kind: "island",
    threadId: "thread-a",
    mutationId: requestId,
    expectedConversationGeneration: 4,
    expectedTopologyGeneration,
  },
  threadId: "thread-a",
  conversationGeneration: 4,
  topologyGeneration: expectedTopologyGeneration + 1,
  baseHistoryMutationRevision: 2,
  historyMutationRevision: 3,
  upsertTurns: [],
  upsertCanonicalTurns: [],
  removeTurnIds: [],
  turnItems: [],
  rowSplices: [],
  turnPagination: {
    olderCursor: null,
    backwardsCursor: null,
    oldestLoadedTurnId: turnId,
    isLoadingOlder: false,
    hasLoadedOldest: false,
    loadedTurnCount: 1,
    itemsView: "summary",
  },
  turnItemsPaginationUpserts: {},
  removeTurnItemsPaginationIds: [],
});

const reveal = (
  turnId: string,
  requestId: string,
  expectedTopologyGeneration: number,
): CodexPromptRailReveal => ({
  threadId: "thread-a",
  hostId: "host-a",
  generation: 8,
  turnId,
  topologyGeneration: expectedTopologyGeneration + 1,
  previews: [
    {
      itemId: `${turnId}:prompt`,
      promptPreview: `Prompt for ${turnId}`,
      responsePreview: `Response for ${turnId}`,
      isHeartbeat: false,
    },
  ],
  mutation: revealMutation(turnId, requestId, expectedTopologyGeneration),
});

describe("useLocalConversationPromptRail", () => {
  test("loads only shells, lazily previews one Turn, and identity-seeks beyond 1,000", async () => {
    const revealRequests: Array<Parameters<LocalConversationPromptRailClient["reveal"]>[0]> = [];
    const client: LocalConversationPromptRailClient = {
      loadIndex: async (request) => ({
        status: "completed",
        requestId: request.requestId,
        expectedTopologyGeneration: request.expectedTopologyGeneration,
        index: index(),
      }),
      reveal: async (request) => {
        revealRequests.push(request);
        const turnId =
          request.target.kind === "shell" ? request.target.shell.turnId : request.target.turnId;
        return {
          status: "completed",
          requestId: request.requestId,
          expectedTopologyGeneration: request.expectedTopologyGeneration,
          reveal: reveal(turnId, request.requestId, request.expectedTopologyGeneration),
        };
      },
    };
    const publishReveal = vi.fn(async () => undefined);
    const installedTarget = document.createElement("div");
    const revealInstalledTurn = vi.fn(async () => installedTarget);
    const hook = renderHook(() =>
      useLocalConversationPromptRail({
        enabled: true,
        threadId: "thread-a",
        topologyGeneration: 12,
        residentItems: [],
        client,
        publishReveal,
        revealInstalledTurn,
      }),
    );

    await waitFor(() => expect(hook.result.current.items).toHaveLength(1_000));
    expect(revealRequests).toHaveLength(0);

    act(() => hook.result.current.previewItem(hook.result.current.items[499]!));
    await waitFor(() => expect(hook.result.current.items[499]?.label).toBe("Prompt for turn-500"));
    expect(revealRequests).toHaveLength(1);
    expect(publishReveal).toHaveBeenCalledTimes(1);

    let revealedTarget: HTMLElement | null = null;
    await act(async () => {
      revealedTarget = await hook.result.current.revealItem(
        hook.result.current.items[499]!,
        "smooth",
      );
    });
    expect(revealRequests).toHaveLength(2);
    expect(publishReveal).toHaveBeenCalledTimes(2);
    expect(revealInstalledTurn).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: "turn-500" }),
      "smooth",
      expect.any(AbortSignal),
    );
    expect(revealedTarget).toBe(installedTarget);

    await act(async () => {
      await hook.result.current.revealKnownTurn("turn-1001");
    });
    expect(revealRequests[2]?.target).toEqual({ kind: "knownTurn", turnId: "turn-1001" });
    expect(publishReveal).toHaveBeenCalledTimes(3);
  });

  test("rehydrates an evicted hover preview before exact click navigation", async () => {
    const revealRequests: CodexPromptRailRevealRequest[] = [];
    const client: LocalConversationPromptRailClient = {
      loadIndex: async (request) => ({
        status: "completed",
        requestId: request.requestId,
        expectedTopologyGeneration: request.expectedTopologyGeneration,
        index: index(1),
      }),
      reveal: async (request) => {
        revealRequests.push(request);
        const turnId =
          request.target.kind === "shell" ? request.target.shell.turnId : request.target.turnId;
        return {
          status: "completed",
          requestId: request.requestId,
          expectedTopologyGeneration: request.expectedTopologyGeneration,
          reveal: reveal(turnId, request.requestId, request.expectedTopologyGeneration),
        };
      },
    };
    const publishReveal = vi.fn(async () => undefined);
    const realTarget = document.createElement("div");
    const revealInstalledTurn = vi.fn(async () => realTarget);
    const hook = renderHook(
      ({ residentItems }) =>
        useLocalConversationPromptRail({
          enabled: true,
          threadId: "thread-a",
          topologyGeneration: 12,
          residentItems,
          client,
          publishReveal,
          revealInstalledTurn,
        }),
      {
        initialProps: {
          residentItems: [] as ThreadUserMessageNavigationItem[],
        },
      },
    );

    await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
    const shell = hook.result.current.items[0]!;
    act(() => hook.result.current.previewItem(shell));
    await waitFor(() => expect(publishReveal).toHaveBeenCalledTimes(1));

    const { promptRailShell: _promptRailShell, ...residentShell } = shell;
    const resident: ThreadUserMessageNavigationItem = {
      ...residentShell,
      id: "turn-1:real-search-unit",
      label: "Resident prompt",
    };
    hook.rerender({ residentItems: [resident] });
    await waitFor(() => expect(hook.result.current.items[0]?.id).toBe(resident.id));
    // A tail-only pin may evict the hover target before it ever becomes visible.
    hook.rerender({ residentItems: [] });
    await waitFor(() => expect(hook.result.current.items[0]?.id).not.toBe(resident.id));

    let target: HTMLElement | null = null;
    await act(async () => {
      target = await hook.result.current.revealItem(hook.result.current.items[0]!, "smooth");
    });
    expect(revealRequests).toHaveLength(2);
    expect(publishReveal).toHaveBeenCalledTimes(2);
    expect(revealInstalledTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ turnId: "turn-1" }),
      "smooth",
      expect.any(AbortSignal),
    );
    expect(target).toBe(realTarget);
  });

  test("continues exact navigation across the topology installed by its mutation", async () => {
    let revealSignal: AbortSignal | undefined;
    let finishPublication: (() => void) | undefined;
    const client: LocalConversationPromptRailClient = {
      loadIndex: async (request) => ({
        status: "completed",
        requestId: request.requestId,
        expectedTopologyGeneration: request.expectedTopologyGeneration,
        index: index(1),
      }),
      reveal: async (request, options) => {
        revealSignal = options?.signal;
        const turnId =
          request.target.kind === "shell" ? request.target.shell.turnId : request.target.turnId;
        return {
          status: "completed",
          requestId: request.requestId,
          expectedTopologyGeneration: request.expectedTopologyGeneration,
          reveal: reveal(turnId, request.requestId, request.expectedTopologyGeneration),
        };
      },
    };
    const publishReveal = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPublication = resolve;
        }),
    );
    const realTarget = document.createElement("div");
    const revealInstalledTurn = vi.fn(async () => realTarget);
    const hook = renderHook(
      ({ topologyGeneration }) =>
        useLocalConversationPromptRail({
          enabled: true,
          threadId: "thread-a",
          topologyGeneration,
          residentItems: [],
          client,
          publishReveal,
          revealInstalledTurn,
        }),
      { initialProps: { topologyGeneration: 12 } },
    );

    await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
    let navigationPromise: Promise<HTMLElement | null> | undefined;
    await act(async () => {
      navigationPromise = hook.result.current.revealItem(hook.result.current.items[0]!, "smooth");
      await Promise.resolve();
    });
    await waitFor(() => expect(publishReveal).toHaveBeenCalledOnce());

    await act(async () => {
      hook.rerender({ topologyGeneration: 13 });
      await Promise.resolve();
    });
    expect(revealSignal?.aborted).toBe(false);

    let target: HTMLElement | null = null;
    await act(async () => {
      finishPublication?.();
      target = (await navigationPromise) ?? null;
    });

    expect(revealSignal?.aborted).toBe(false);
    expect(revealInstalledTurn).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: "turn-1", topologyGeneration: 13 }),
      "smooth",
      expect.any(AbortSignal),
    );
    expect(target).toBe(realTarget);
  });

  test("aborts the old request and rejects late topology or host generations", async () => {
    const pending: Array<{
      readonly request: Parameters<LocalConversationPromptRailClient["loadIndex"]>[0];
      readonly signal: AbortSignal | undefined;
      readonly resolve: (
        value: Awaited<ReturnType<LocalConversationPromptRailClient["loadIndex"]>>,
      ) => void;
    }> = [];
    const client: LocalConversationPromptRailClient = {
      loadIndex: (request, options) =>
        new Promise((resolve) => pending.push({ request, signal: options?.signal, resolve })),
      reveal: async (request) => ({
        status: "completed",
        requestId: request.requestId,
        expectedTopologyGeneration: request.expectedTopologyGeneration,
        reveal: {
          ...reveal("turn-1", request.requestId, request.expectedTopologyGeneration),
          hostId: "foreign-host",
        },
      }),
    };
    const publishReveal = vi.fn(async () => undefined);
    const hook = renderHook(
      ({ topologyGeneration }) =>
        useLocalConversationPromptRail({
          enabled: true,
          threadId: "thread-a",
          topologyGeneration,
          residentItems: [],
          client,
          publishReveal,
        }),
      { initialProps: { topologyGeneration: 1 } },
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    hook.rerender({ topologyGeneration: 2 });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]?.signal?.aborted).toBe(true);

    await act(async () => {
      pending[0]?.resolve({
        status: "completed",
        requestId: pending[0].request.requestId,
        expectedTopologyGeneration: 1,
        index: index(4),
      });
      pending[1]?.resolve({
        status: "completed",
        requestId: pending[1].request.requestId,
        expectedTopologyGeneration: 2,
        index: index(4),
      });
    });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(4));

    await act(async () => {
      await hook.result.current.revealItem(hook.result.current.items[0]!, "smooth");
    });
    expect(publishReveal).not.toHaveBeenCalled();
  });

  test("publishes a committed reveal even when a late UI abort drops its preview", async () => {
    let pendingReveal:
      | {
          readonly request: CodexPromptRailRevealRequest;
          readonly signal: AbortSignal | undefined;
          readonly resolve: (value: CodexPromptRailRevealCommandResult) => void;
        }
      | undefined;
    const client: LocalConversationPromptRailClient = {
      loadIndex: async (request) => ({
        status: "completed",
        requestId: request.requestId,
        expectedTopologyGeneration: request.expectedTopologyGeneration,
        index: index(1),
      }),
      reveal: (request, options) =>
        new Promise((resolve) => {
          pendingReveal = { request, signal: options?.signal, resolve };
        }),
    };
    const publishReveal = vi.fn(async () => undefined);
    const hook = renderHook(
      ({ topologyGeneration }) =>
        useLocalConversationPromptRail({
          enabled: true,
          threadId: "thread-a",
          topologyGeneration,
          residentItems: [],
          client,
          publishReveal,
        }),
      { initialProps: { topologyGeneration: 1 } },
    );

    await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
    act(() => hook.result.current.previewItem(hook.result.current.items[0]!));
    await waitFor(() => expect(pendingReveal).toBeDefined());
    const committedRequest = pendingReveal!.request;
    hook.rerender({ topologyGeneration: 2 });
    expect(pendingReveal?.signal?.aborted).toBe(true);

    await act(async () => {
      pendingReveal?.resolve({
        status: "completed",
        requestId: committedRequest.requestId,
        expectedTopologyGeneration: committedRequest.expectedTopologyGeneration,
        reveal: reveal(
          "turn-1",
          committedRequest.requestId,
          committedRequest.expectedTopologyGeneration,
        ),
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(publishReveal).toHaveBeenCalledTimes(1));
    expect(hook.result.current.items[0]?.label).toBe("Load prompt preview");
  });
});
