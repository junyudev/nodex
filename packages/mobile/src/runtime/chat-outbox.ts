import type { ChatItem, MobileParams } from "@nodex/mobile-protocol";
import type { LocalImage } from "./platform";

export type ChatOutboxStatus =
  | { readonly kind: "sending" | "sent" }
  | { readonly kind: "failed"; readonly unknown: boolean; readonly reason: string };

export type ChatOutboxEntry = Readonly<
  Pick<MobileParams<"chat.send">, "messageId" | "text" | "delivery">
> & {
  readonly images: readonly LocalImage[];
  readonly reasoningEffort: string | null;
  readonly status: ChatOutboxStatus;
};

/** Only an echoed sender identity confirms the visible local message. */
export function reconcileOutbox<Entry extends ChatOutboxEntry>(
  entries: readonly Entry[],
  items: readonly ChatItem[],
): readonly Entry[] {
  if (!entries.length) return entries;
  const received = new Set<string>();
  for (const item of items) {
    if (item.kind === "user" && item.messageId !== null) received.add(item.messageId);
  }
  const remaining = entries.filter((entry) => !received.has(entry.messageId));
  return remaining.length === entries.length ? entries : remaining;
}
