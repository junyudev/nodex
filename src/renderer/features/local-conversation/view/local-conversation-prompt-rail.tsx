import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import { ThreadUserMessageNavigationRailLazy } from "./thread-user-message-navigation-rail-lazy";
import type { ThreadUserMessageNavigationRevealMode } from "./thread-user-message-navigation-rail";
import {
  useLocalConversationPromptRail,
  type UseLocalConversationPromptRailInput,
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

export type LocalConversationPromptRailProps = UseLocalConversationPromptRailInput;

/** Prompt navigation; only the conversation owner's install crosses into resident history. */
export function LocalConversationPromptRail(props: LocalConversationPromptRailProps) {
  const controller = useLocalConversationPromptRail(props);
  return (
    <ThreadUserMessageNavigationRailLazy
      items={controller.items}
      onPreviewItem={controller.previewItem}
      onRevealItem={controller.revealItem}
    />
  );
}
