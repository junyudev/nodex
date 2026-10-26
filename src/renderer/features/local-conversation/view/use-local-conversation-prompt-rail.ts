import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CodexPromptRailPreview } from "../../../../shared/codex-prompt-rail-history";
import type { ConversationPromptRailPort, ConversationPromptTurn } from "../conversation-runtime";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import {
  buildLocalConversationPromptRailItems,
  isLocalConversationPromptRailShellItem,
  type LocalConversationPromptRailItem,
} from "../projection/local-conversation-prompt-rail-model";
import type { ThreadUserMessageNavigationRevealMode } from "./thread-user-message-navigation-rail";

const MAX_PREVIEWED_TURNS = 8;
const EMPTY_PREVIEWS: ReadonlyMap<string, readonly CodexPromptRailPreview[]> = new Map();

export interface UseLocalConversationPromptRailInput {
  /** The current history reader's prompt index; null where its owner cannot index Turns. */
  readonly port: ConversationPromptRailPort | null;
  readonly threadId: string | null;
  readonly residentItems: readonly ThreadUserMessageNavigationItem[];
  readonly revealResidentItem?: (
    item: ThreadUserMessageNavigationItem,
    mode: ThreadUserMessageNavigationRevealMode,
  ) => HTMLElement | null | Promise<HTMLElement | null>;
  /** Resolves the real resident marker after the installed Turn has rendered. */
  readonly revealInstalledTurn?: (
    turnId: string,
    mode: ThreadUserMessageNavigationRevealMode,
    signal: AbortSignal,
  ) => HTMLElement | null | Promise<HTMLElement | null>;
}

export interface LocalConversationPromptRailController {
  readonly items: LocalConversationPromptRailItem[];
  readonly previewItem: (item: ThreadUserMessageNavigationItem) => void;
  readonly revealItem: (
    item: ThreadUserMessageNavigationItem,
    mode: ThreadUserMessageNavigationRevealMode,
  ) => Promise<HTMLElement | null>;
}

interface ThreadPromptIndex {
  readonly threadId: string;
  readonly turns: readonly ConversationPromptTurn[];
}

/**
 * Prompt navigation over every Turn the conversation's owner can index, falling back to resident
 * messages. A replacement reader of the same conversation keeps its index until the next one
 * arrives, so installing a Turn does not collapse the rail.
 */
export function useLocalConversationPromptRail(
  input: UseLocalConversationPromptRailInput,
): LocalConversationPromptRailController {
  const { port, residentItems, revealInstalledTurn, revealResidentItem, threadId } = input;
  const [index, setIndex] = useState<ThreadPromptIndex | null>(null);
  const [previews, setPreviews] = useState<{
    readonly port: ConversationPromptRailPort | null;
    readonly byTurnId: ReadonlyMap<string, readonly CodexPromptRailPreview[]>;
  }>({ port: null, byTurnId: new Map() });
  const currentPortRef = useRef(port);
  useEffect(() => {
    currentPortRef.current = port;
  }, [port]);
  const previewRequestRef = useRef<{
    readonly port: ConversationPromptRailPort;
    readonly turnId: string;
    readonly controller: AbortController;
  } | null>(null);
  const navigationRef = useRef<{
    readonly threadId: string | null;
    readonly controller: AbortController;
  } | null>(null);

  useEffect(() => {
    if (!port || !threadId) return undefined;
    const controller = new AbortController();
    port
      .loadIndex(controller.signal)
      .then((turns) => {
        if (controller.signal.aborted) return;
        startTransition(() => setIndex(turns ? { threadId, turns } : null));
      })
      // An unreadable index leaves navigation over resident messages.
      .catch(() => {
        if (!controller.signal.aborted) setIndex(null);
      });
    return () => controller.abort();
  }, [port, threadId]);

  // Navigation outlives a replacement reader of its conversation, not the conversation.
  useEffect(
    () => () => {
      const navigation = navigationRef.current;
      if (navigation?.threadId !== threadId) return;
      navigation.controller.abort();
      navigationRef.current = null;
    },
    [threadId],
  );

  const previewItem = useCallback(
    (item: ThreadUserMessageNavigationItem): void => {
      if (!isLocalConversationPromptRailShellItem(item) || item.promptRailShell.hasPreview) return;
      const turnId = item.promptRailShell.turnId;
      const pending = previewRequestRef.current;
      if (!port?.preview || (pending?.port === port && pending.turnId === turnId)) return;
      pending?.controller.abort();
      const controller = new AbortController();
      previewRequestRef.current = { port, turnId, controller };
      void port
        .preview(turnId, controller.signal)
        .then((turnPreviews) => {
          // Previews belong to their reader; a replaced reader's late result stays unseen.
          if (controller.signal.aborted || !turnPreviews || currentPortRef.current !== port) return;
          startTransition(() =>
            setPreviews((current) => {
              const byTurnId = new Map(current.port === port ? current.byTurnId : []);
              byTurnId.delete(turnId);
              byTurnId.set(turnId, turnPreviews);
              for (const oldest of byTurnId.keys()) {
                if (byTurnId.size <= MAX_PREVIEWED_TURNS) break;
                byTurnId.delete(oldest);
              }
              return { port, byTurnId };
            }),
          );
        })
        .catch(() => undefined)
        .finally(() => {
          if (previewRequestRef.current?.controller === controller)
            previewRequestRef.current = null;
        });
    },
    [port],
  );

  const revealItem = useCallback(
    async (
      item: ThreadUserMessageNavigationItem,
      mode: ThreadUserMessageNavigationRevealMode,
    ): Promise<HTMLElement | null> => {
      if (!isLocalConversationPromptRailShellItem(item))
        return (await revealResidentItem?.(item, mode)) ?? null;
      const turnId = item.promptRailShell.turnId;
      const resident = residentItems.find((candidate) => candidate.turnId === turnId);
      if (resident) return (await revealResidentItem?.(resident, mode)) ?? null;
      if (!port) return null;

      navigationRef.current?.controller.abort();
      const controller = new AbortController();
      navigationRef.current = { threadId, controller };
      try {
        if ((await port.install(turnId, controller.signal)) !== "applied") return null;
        if (controller.signal.aborted) return null;
        return (await revealInstalledTurn?.(turnId, mode, controller.signal)) ?? null;
      } catch {
        return null;
      } finally {
        if (navigationRef.current?.controller === controller) navigationRef.current = null;
      }
    },
    [port, residentItems, revealInstalledTurn, revealResidentItem, threadId],
  );

  const turns = port && index?.threadId === threadId ? index.turns : null;
  const previewsByTurnId = previews.port === port ? previews.byTurnId : EMPTY_PREVIEWS;
  const items = useMemo(
    () => buildLocalConversationPromptRailItems({ turns, residentItems, previewsByTurnId }),
    [previewsByTurnId, residentItems, turns],
  );

  return { items, previewItem, revealItem };
}
