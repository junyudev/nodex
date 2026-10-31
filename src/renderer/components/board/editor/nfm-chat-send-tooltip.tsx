import { describePageChatDelivery } from "@/lib/page-chat-delivery";
import { usePageChatDelivery } from "@/lib/use-page-chat-delivery";

/** Names where a send goes and, while that chat is in a Turn, whether it queues or steers. */
export function NfmChatSendTooltip({
  label,
  sessionId,
  startsNewTurn,
}: {
  readonly label: string;
  readonly sessionId: string | null;
  readonly startsNewTurn?: boolean;
}) {
  const note = describePageChatDelivery(usePageChatDelivery(sessionId, { startsNewTurn }));
  if (!note) return label;
  return (
    <span className="flex flex-col">
      <span>{label}</span>
      <span className="text-token-description-foreground">{note}</span>
    </span>
  );
}
