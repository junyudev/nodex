import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CodexPromptRailIndex,
  CodexPromptRailIndexCommandResult,
  CodexPromptRailIndexRequest,
  CodexPromptRailPreview,
  CodexPromptRailReveal,
  CodexPromptRailRevealCommandResult,
  CodexPromptRailRevealRequest,
  CodexPromptRailRevealTarget,
} from "../../../../shared/codex-prompt-rail-history";
import type { CodexThreadHistoryFeatureUnavailable } from "../../../../shared/codex-thread-history-features";
import { loadCodexPromptRailIndex, revealCodexPromptRailTurn } from "../../../lib/api";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import {
  buildLocalConversationPromptRailItems,
  isLocalConversationPromptRailShellItem,
  resolveCodexPromptRailRevealTarget,
  type LocalConversationPromptRailItem,
} from "../projection/local-conversation-prompt-rail-model";
import type { ThreadUserMessageNavigationRevealMode } from "./thread-user-message-navigation-rail";

const MAX_PREVIEWED_TURNS = 8;
let nextRequestOrdinal = 0;

const makeRequestId = (kind: "index" | "reveal"): string => {
  nextRequestOrdinal += 1;
  return `prompt-rail:${kind}:${Date.now()}:${nextRequestOrdinal}`;
};

export interface LocalConversationPromptRailClient {
  readonly loadIndex: (
    request: CodexPromptRailIndexRequest,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<CodexPromptRailIndexCommandResult>;
  readonly reveal: (
    request: CodexPromptRailRevealRequest,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<CodexPromptRailRevealCommandResult>;
}

const defaultClient: LocalConversationPromptRailClient = {
  loadIndex: loadCodexPromptRailIndex,
  reveal: revealCodexPromptRailTurn,
};

export interface UseLocalConversationPromptRailInput {
  readonly enabled: boolean;
  readonly threadId: string | null;
  readonly topologyGeneration: number | null;
  readonly residentItems: readonly ThreadUserMessageNavigationItem[];
  readonly client?: LocalConversationPromptRailClient;
  /** The owner publishes the bounded Main-authored mutation; renderer never constructs history. */
  readonly publishReveal: (reveal: CodexPromptRailReveal) => Promise<void>;
  readonly revealResidentItem?: (
    item: ThreadUserMessageNavigationItem,
    mode: ThreadUserMessageNavigationRevealMode,
  ) => HTMLElement | null | Promise<HTMLElement | null>;
  /** Resolves the real resident navigation item after the reveal mutation has rendered. */
  readonly revealInstalledTurn?: (
    reveal: CodexPromptRailReveal,
    mode: ThreadUserMessageNavigationRevealMode,
    signal: AbortSignal,
  ) => HTMLElement | null | Promise<HTMLElement | null>;
}

export interface LocalConversationPromptRailController {
  readonly items: LocalConversationPromptRailItem[];
  readonly index: CodexPromptRailIndex | null;
  readonly loadingIndex: boolean;
  readonly availability: CodexThreadHistoryFeatureUnavailable | null;
  readonly error: string | null;
  readonly previewItem: (item: ThreadUserMessageNavigationItem) => void;
  readonly revealItem: (
    item: ThreadUserMessageNavigationItem,
    mode: ThreadUserMessageNavigationRevealMode,
  ) => Promise<HTMLElement | null>;
  readonly revealKnownTurn: (
    turnId: string,
    mode?: ThreadUserMessageNavigationRevealMode,
  ) => Promise<HTMLElement | null>;
  readonly reload: () => void;
}

interface ActiveRevealRequest {
  readonly contextKey: string;
  readonly requestId: string;
  readonly targetTurnId: string;
  readonly controller: AbortController;
  readonly promise: Promise<CodexPromptRailReveal | null>;
}

interface AcceptedRevealTopologyTransition {
  readonly requestId: string;
  readonly sourceContextKey: string;
  readonly targetContextKey: string;
}

interface CachedReveal {
  readonly contextKey: string;
  readonly turnId: string;
  readonly reveal: CodexPromptRailReveal;
}

const turnIdForTarget = (target: CodexPromptRailRevealTarget): string =>
  target.kind === "shell" ? target.shell.turnId : target.turnId;

const currentIndexResult = (input: {
  readonly result: CodexPromptRailIndexCommandResult;
  readonly requestId: string;
  readonly threadId: string;
  readonly topologyGeneration: number;
}): CodexPromptRailIndex | null => {
  if (input.result.status !== "completed") return null;
  if (
    input.result.requestId !== input.requestId ||
    input.result.expectedTopologyGeneration !== input.topologyGeneration ||
    input.result.index.threadId !== input.threadId
  ) {
    return null;
  }
  return input.result.index;
};

const currentUnavailableResult = (input: {
  readonly result: CodexPromptRailIndexCommandResult | CodexPromptRailRevealCommandResult;
  readonly requestId: string;
  readonly threadId: string;
}): CodexThreadHistoryFeatureUnavailable | null => {
  if (input.result.status !== "unavailable") return null;
  if (
    input.result.requestId !== input.requestId ||
    input.result.availability.threadId !== input.threadId ||
    input.result.availability.feature !== "prompt-rail"
  ) {
    return null;
  }
  return input.result.availability;
};

const currentRevealResult = (input: {
  readonly result: CodexPromptRailRevealCommandResult;
  readonly requestId: string;
  readonly threadId: string;
  readonly topologyGeneration: number;
  readonly hostId: string;
  readonly generation: number;
  readonly turnId: string;
}): CodexPromptRailReveal | null => {
  if (input.result.status !== "completed") return null;
  const reveal = input.result.reveal;
  if (
    input.result.requestId !== input.requestId ||
    input.result.expectedTopologyGeneration !== input.topologyGeneration ||
    reveal.threadId !== input.threadId ||
    reveal.hostId !== input.hostId ||
    reveal.generation !== input.generation ||
    reveal.turnId !== input.turnId ||
    reveal.mutation.threadId !== input.threadId ||
    reveal.mutation.topologyGeneration !== reveal.topologyGeneration ||
    reveal.mutation.origin.kind !== "island" ||
    reveal.mutation.origin.threadId !== input.threadId ||
    reveal.mutation.origin.mutationId !== input.requestId ||
    reveal.mutation.origin.expectedTopologyGeneration !== input.topologyGeneration
  ) {
    return null;
  }
  return reveal;
};

export function useLocalConversationPromptRail(
  input: UseLocalConversationPromptRailInput,
): LocalConversationPromptRailController {
  const {
    enabled,
    publishReveal,
    residentItems,
    revealInstalledTurn,
    revealResidentItem,
    threadId,
    topologyGeneration,
  } = input;
  const client = input.client ?? defaultClient;
  const [index, setIndex] = useState<CodexPromptRailIndex | null>(null);
  const [previewsByTurnId, setPreviewsByTurnId] = useState<
    ReadonlyMap<string, readonly CodexPromptRailPreview[]>
  >(() => new Map());
  const [loadingIndex, setLoadingIndex] = useState(false);
  const [availability, setAvailability] = useState<CodexThreadHistoryFeatureUnavailable | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [reloadOrdinal, setReloadOrdinal] = useState(0);
  const contextKey = `${threadId ?? ""}\u0000${topologyGeneration ?? -1}`;
  const activeContextRef = useRef(contextKey);
  activeContextRef.current = contextKey;
  const revealRequestRef = useRef<ActiveRevealRequest | null>(null);
  const acceptedRevealTopologyTransitionRef = useRef<AcceptedRevealTopologyTransition | null>(null);
  const revealCacheRef = useRef<CachedReveal | null>(null);
  const navigationControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const acceptedTransition = acceptedRevealTopologyTransitionRef.current;
    const isAcceptedRevealTopology = acceptedTransition?.targetContextKey === contextKey;
    if (!isAcceptedRevealTopology) {
      revealRequestRef.current?.controller.abort();
      revealRequestRef.current = null;
      navigationControllerRef.current?.abort();
      navigationControllerRef.current = null;
      acceptedRevealTopologyTransitionRef.current = null;
    }
    revealCacheRef.current = null;
    setIndex(null);
    setPreviewsByTurnId(new Map());
    setAvailability(null);
    setError(null);

    if (!enabled || !threadId || topologyGeneration === null) {
      setLoadingIndex(false);
      return undefined;
    }

    const controller = new AbortController();
    const requestId = makeRequestId("index");
    setLoadingIndex(true);
    void client
      .loadIndex(
        { requestId, threadId, expectedTopologyGeneration: topologyGeneration },
        { signal: controller.signal },
      )
      .then((result) => {
        if (controller.signal.aborted || activeContextRef.current !== contextKey) return;
        const unavailable = currentUnavailableResult({ result, requestId, threadId });
        if (unavailable) {
          setAvailability(unavailable);
          return;
        }
        const next = currentIndexResult({ result, requestId, threadId, topologyGeneration });
        if (!next) return;
        startTransition(() => {
          setAvailability(null);
          setIndex(next);
        });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || activeContextRef.current !== contextKey) return;
        setError(cause instanceof Error ? cause.message : "Could not load prompt history");
      })
      .finally(() => {
        if (controller.signal.aborted || activeContextRef.current !== contextKey) return;
        setLoadingIndex(false);
      });
    return () => controller.abort();
  }, [client, contextKey, enabled, reloadOrdinal, threadId, topologyGeneration]);

  useEffect(
    () => () => {
      revealRequestRef.current?.controller.abort();
      navigationControllerRef.current?.abort();
    },
    [],
  );

  const effectiveIndex =
    index?.threadId === threadId && enabled && topologyGeneration !== null ? index : null;

  const loadReveal = useCallback(
    (
      target: CodexPromptRailRevealTarget,
      options: { readonly reuseCompleted?: boolean } = {},
    ): Promise<CodexPromptRailReveal | null> => {
      const activeIndex = effectiveIndex;
      const targetTurnId = turnIdForTarget(target);
      if (!threadId || topologyGeneration === null || !activeIndex) return Promise.resolve(null);

      const cached = revealCacheRef.current;
      if (
        options.reuseCompleted !== false &&
        cached?.contextKey === contextKey &&
        cached.turnId === targetTurnId &&
        cached.reveal.hostId === activeIndex.hostId &&
        cached.reveal.generation === activeIndex.generation
      ) {
        return Promise.resolve(cached.reveal);
      }
      const existing = revealRequestRef.current;
      if (existing?.contextKey === contextKey && existing.targetTurnId === targetTurnId) {
        return existing.promise;
      }
      existing?.controller.abort();

      const controller = new AbortController();
      const requestId = makeRequestId("reveal");
      const promise = client
        .reveal(
          {
            requestId,
            threadId,
            hostId: activeIndex.hostId,
            generation: activeIndex.generation,
            expectedTopologyGeneration: topologyGeneration,
            target,
          },
          { signal: controller.signal },
        )
        .then(async (result) => {
          const unavailable = currentUnavailableResult({ result, requestId, threadId });
          if (unavailable) {
            if (!controller.signal.aborted && activeContextRef.current === contextKey) {
              startTransition(() => {
                setAvailability(unavailable);
                setIndex(null);
              });
            }
            return null;
          }
          const reveal = currentRevealResult({
            result,
            requestId,
            threadId,
            topologyGeneration,
            hostId: activeIndex.hostId,
            generation: activeIndex.generation,
            turnId: targetTurnId,
          });
          if (!reveal) return null;
          acceptedRevealTopologyTransitionRef.current = {
            requestId,
            sourceContextKey: contextKey,
            targetContextKey: `${reveal.threadId}\u0000${reveal.topologyGeneration}`,
          };
          // A completed response means Main already committed the island. Publication must win
          // over a late UI abort so owner and followers cannot diverge from Main.
          await publishReveal(reveal);
          const activeContext = activeContextRef.current;
          const isCurrentContext =
            activeContext === contextKey ||
            activeContext === `${reveal.threadId}\u0000${reveal.topologyGeneration}`;
          if (controller.signal.aborted || !isCurrentContext) return null;
          revealCacheRef.current = { contextKey, turnId: targetTurnId, reveal };
          startTransition(() => {
            setPreviewsByTurnId((current) => {
              const next = new Map(current);
              next.delete(targetTurnId);
              next.set(targetTurnId, reveal.previews);
              while (next.size > MAX_PREVIEWED_TURNS) {
                const oldest = next.keys().next().value as string | undefined;
                if (!oldest) break;
                next.delete(oldest);
              }
              return next;
            });
          });
          return reveal;
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted && activeContextRef.current === contextKey) {
            setError(cause instanceof Error ? cause.message : "Could not reveal prompt history");
          }
          return null;
        })
        .finally(() => {
          if (revealRequestRef.current?.promise === promise) revealRequestRef.current = null;
        });
      revealRequestRef.current = { contextKey, requestId, targetTurnId, controller, promise };
      return promise;
    },
    [client, contextKey, effectiveIndex, publishReveal, threadId, topologyGeneration],
  );

  const previewItem = useCallback(
    (item: ThreadUserMessageNavigationItem): void => {
      if (!isLocalConversationPromptRailShellItem(item)) return;
      if (item.promptRailShell.hasPreview) return;
      void loadReveal({ kind: "shell", shell: item.promptRailShell.shell });
    },
    [loadReveal],
  );

  const installAndReveal = useCallback(
    async (
      target: CodexPromptRailRevealTarget,
      mode: ThreadUserMessageNavigationRevealMode,
    ): Promise<HTMLElement | null> => {
      // A preview mutation may have been evicted before the user clicks. A click is an exact
      // navigation command, so it never trusts a completed hover cache.
      const reveal = await loadReveal(target, { reuseCompleted: false });
      const activeContext = activeContextRef.current;
      const isCurrentContext =
        activeContext === contextKey ||
        activeContext === `${reveal?.threadId ?? ""}\u0000${reveal?.topologyGeneration ?? -1}`;
      if (!reveal || topologyGeneration === null || !isCurrentContext) {
        return null;
      }

      navigationControllerRef.current?.abort();
      const controller = new AbortController();
      navigationControllerRef.current = controller;
      const navigationContext = activeContextRef.current;
      if (
        controller.signal.aborted ||
        (navigationContext !== contextKey &&
          navigationContext !== `${reveal.threadId}\u0000${reveal.topologyGeneration}`)
      ) {
        return null;
      }
      return (await revealInstalledTurn?.(reveal, mode, controller.signal)) ?? null;
    },
    [contextKey, loadReveal, revealInstalledTurn, topologyGeneration],
  );

  const revealItem = useCallback(
    async (
      item: ThreadUserMessageNavigationItem,
      mode: ThreadUserMessageNavigationRevealMode,
    ): Promise<HTMLElement | null> => {
      if (!isLocalConversationPromptRailShellItem(item)) {
        return (await revealResidentItem?.(item, mode)) ?? null;
      }
      const resident = residentItems.find(
        (candidate) => candidate.turnId === item.promptRailShell.shell.turnId,
      );
      if (resident) return (await revealResidentItem?.(resident, mode)) ?? null;
      return installAndReveal({ kind: "shell", shell: item.promptRailShell.shell }, mode);
    },
    [installAndReveal, residentItems, revealResidentItem],
  );

  const revealKnownTurn = useCallback(
    async (
      turnId: string,
      mode: ThreadUserMessageNavigationRevealMode = "smooth",
    ): Promise<HTMLElement | null> => {
      if (!effectiveIndex) return null;
      const resident = residentItems.find((item) => item.turnId === turnId);
      if (resident) return (await revealResidentItem?.(resident, mode)) ?? null;
      const target = resolveCodexPromptRailRevealTarget(effectiveIndex, turnId);
      return installAndReveal(target, mode);
    },
    [effectiveIndex, installAndReveal, residentItems, revealResidentItem],
  );

  const items = useMemo(
    () =>
      buildLocalConversationPromptRailItems({
        index: effectiveIndex,
        residentItems,
        previewsByTurnId,
      }),
    [effectiveIndex, previewsByTurnId, residentItems],
  );

  return {
    items,
    index: effectiveIndex,
    loadingIndex,
    availability,
    error,
    previewItem,
    revealItem,
    revealKnownTurn,
    reload: () => setReloadOrdinal((current) => current + 1),
  };
}
