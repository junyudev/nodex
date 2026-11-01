import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import {
  chatMessageRevealStore,
  type createChatMessageRevealStore,
} from "../chat-message-navigation";
import type { ConversationHistoryPort } from "../conversation-runtime";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import { highlightChatMessage } from "./highlight-chat-message";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { useLocalConversationThreadScrollController } from "./local-conversation-thread-scroll-controller";

/** Installs history through its publishing owner, then reveals the real virtualized message row. */
export function useChatMessageReveal(
  input: {
    readonly enabled?: boolean;
    readonly threadId: string | null;
    readonly history: ConversationHistoryPort | undefined;
    readonly items: readonly ThreadUserMessageNavigationItem[];
    readonly reveal: (item: ThreadUserMessageNavigationItem) => Promise<HTMLElement | null>;
  },
  store: ReturnType<typeof createChatMessageRevealStore> = chatMessageRevealStore,
): void {
  const pending = useSyncExternalStore(store.subscribe, store.read);
  const reducedMotion = useResolvedReducedMotion();
  const scroll = useLocalConversationThreadScrollController();
  const enabled = input.enabled ?? true;
  const reveal = useEffectEvent(async (messageId: string) => {
    const item = input.items.find((item) => item.messageId === messageId);
    if (!item) return null;
    return input.reveal(item);
  });
  const show = useEffectEvent((target: HTMLElement) => {
    scroll.setScrollMode("programmaticFind");
    scroll.scrollElementIntoView(target, reducedMotion ? "instant" : "smooth", "start");
    highlightChatMessage(target, reducedMotion);
  });
  useEffect(
    () => () => {
      const current = store.read();
      if (enabled && current?.threadId === input.threadId) store.consume(current);
    },
    [enabled, input.threadId, store],
  );
  const install = input.history?.promptRail?.installMessage;
  const sourceIdentity = input.history?.sourceIdentity ?? install;
  const available = Boolean(install);
  const installMessage = useEffectEvent(
    (messageId: string, signal: AbortSignal) =>
      input.history?.promptRail?.installMessage?.(messageId, signal) ?? Promise.resolve("stale"),
  );
  useEffect(() => {
    if (!enabled) return;
    if (!pending || pending.threadId !== input.threadId) return;
    if (!pending.messageId) {
      store.consume(pending);
      return;
    }
    if (!available) return;
    const controller = new AbortController();
    void (async () => {
      if ((await installMessage(pending.messageId, controller.signal)) !== "applied") return;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (controller.signal.aborted) return;
        const target = await reveal(pending.messageId);
        if (controller.signal.aborted) return;
        if (target) {
          show(target);
          return;
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    })()
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) store.consume(pending);
      });
    return () => controller.abort();
  }, [enabled, pending, input.threadId, sourceIdentity, available, store]);
}
