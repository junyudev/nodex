import { forwardRef, useImperativeHandle } from "react";
import type { CodexPromptRailReveal } from "../../../../shared/codex-prompt-rail-history";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import { ThreadUserMessageNavigationRailLazy } from "./thread-user-message-navigation-rail-lazy";
import type { ThreadUserMessageNavigationRevealMode } from "./thread-user-message-navigation-rail";
import {
  useLocalConversationPromptRail,
  type LocalConversationPromptRailClient,
} from "./use-local-conversation-prompt-rail";

export const LOCAL_CONVERSATION_PROMPT_RAIL_INSTALL_RENDER_ATTEMPTS = 60;

export interface WaitForLocalConversationPromptRailResidentTargetInput {
  readonly turnId: string;
  readonly mode: ThreadUserMessageNavigationRevealMode;
  readonly signal: AbortSignal;
  readonly readResidentItems: () => readonly ThreadUserMessageNavigationItem[];
  readonly revealResidentItem: (
    item: ThreadUserMessageNavigationItem,
    mode: ThreadUserMessageNavigationRevealMode,
  ) => HTMLElement | null | Promise<HTMLElement | null>;
  readonly waitForNextRender?: () => Promise<void>;
  readonly maxAttempts?: number;
}

const waitForNextAnimationFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Waits by stable Turn identity, then resolves the real renderer marker produced by the mutation. */
export async function waitForLocalConversationPromptRailResidentTarget(
  input: WaitForLocalConversationPromptRailResidentTargetInput,
): Promise<HTMLElement | null> {
  const waitForNextRender = input.waitForNextRender ?? waitForNextAnimationFrame;
  const maxAttempts = Math.max(
    1,
    Math.min(
      input.maxAttempts ?? LOCAL_CONVERSATION_PROMPT_RAIL_INSTALL_RENDER_ATTEMPTS,
      LOCAL_CONVERSATION_PROMPT_RAIL_INSTALL_RENDER_ATTEMPTS,
    ),
  );

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (input.signal.aborted) return null;
    const residentItem = input.readResidentItems().find((item) => item.turnId === input.turnId);
    if (residentItem) {
      return await input.revealResidentItem(residentItem, input.mode);
    }
    await waitForNextRender();
  }
  return null;
}

export interface LocalConversationPromptRailHandle {
  readonly revealKnownTurn: (
    turnId: string,
    mode?: ThreadUserMessageNavigationRevealMode,
  ) => Promise<HTMLElement | null>;
}

export interface LocalConversationPromptRailProps {
  readonly enabled: boolean;
  readonly threadId: string | null;
  readonly topologyGeneration: number | null;
  readonly residentItems: ThreadUserMessageNavigationItem[];
  readonly client?: LocalConversationPromptRailClient;
  readonly publishReveal: (reveal: CodexPromptRailReveal) => Promise<void>;
  readonly revealResidentItem?: (
    item: ThreadUserMessageNavigationItem,
    mode: ThreadUserMessageNavigationRevealMode,
  ) => HTMLElement | null | Promise<HTMLElement | null>;
  readonly revealInstalledTurn?: (
    reveal: CodexPromptRailReveal,
    mode: ThreadUserMessageNavigationRevealMode,
    signal: AbortSignal,
  ) => HTMLElement | null | Promise<HTMLElement | null>;
}

/** Bounded shell rail; only a Main-authored one-Turn mutation crosses the reveal boundary. */
export const LocalConversationPromptRail = forwardRef<
  LocalConversationPromptRailHandle,
  LocalConversationPromptRailProps
>(function LocalConversationPromptRail(
  {
    enabled,
    threadId,
    topologyGeneration,
    residentItems,
    client,
    publishReveal,
    revealInstalledTurn,
    revealResidentItem,
  },
  ref,
) {
  const controller = useLocalConversationPromptRail({
    enabled,
    threadId,
    topologyGeneration,
    residentItems,
    client,
    publishReveal,
    revealInstalledTurn,
    revealResidentItem,
  });
  useImperativeHandle(ref, () => ({ revealKnownTurn: controller.revealKnownTurn }), [
    controller.revealKnownTurn,
  ]);

  return (
    <ThreadUserMessageNavigationRailLazy
      items={controller.items}
      onPreviewItem={controller.previewItem}
      onRevealItem={controller.revealItem}
    />
  );
});
