import type { ThreadStageActions } from "../../thread-stage-types";

/**
 * Names another conversation as the source of a message or an answer, and opens it when its
 * identity and navigation are available.
 */
export function ConversationAttribution({
  label,
  openLabel,
  threadId,
  onOpenThread,
}: {
  readonly label: string;
  readonly openLabel: string;
  readonly threadId: string | null;
  readonly onOpenThread?: ThreadStageActions["onOpenThread"];
}) {
  if (!threadId || !onOpenThread) return <span>{label}</span>;
  return (
    <button
      type="button"
      aria-label={openLabel}
      className="cursor-interaction rounded-sm hover:text-token-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
      onClick={() => void onOpenThread(threadId)}
    >
      {label}
    </button>
  );
}
