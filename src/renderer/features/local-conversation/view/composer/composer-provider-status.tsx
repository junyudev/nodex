import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ConversationProviderStatus } from "../../thread-stage-types";

/** One compact line for execution state that is not an error in the user's input. */
export function ComposerProviderStatus({
  status,
  onErrorMessage,
}: {
  status: ConversationProviderStatus;
  onErrorMessage: (message: string | null) => void;
}) {
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  return (
    <div
      role="status"
      className={cn(
        "flex min-w-0 items-center gap-2 px-3 pb-2 text-xs",
        status.tone === "danger" ? "text-(--destructive)" : "text-token-text-tertiary",
      )}
    >
      <span className="min-w-0 truncate">{status.message}</span>
      {status.actions?.map((action) => (
        <button
          key={action.label}
          type="button"
          disabled={pendingLabel !== null}
          className="shrink-0 cursor-interaction rounded-sm text-token-text-secondary hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-60"
          onClick={() => {
            setPendingLabel(action.label);
            onErrorMessage(null);
            void action
              .run()
              .catch((cause: unknown) =>
                onErrorMessage(
                  cause instanceof Error ? cause.message : `Could not ${action.label}`,
                ),
              )
              .finally(() => setPendingLabel(null));
          }}
        >
          {pendingLabel === action.label ? action.pendingLabel : action.label}
        </button>
      ))}
    </div>
  );
}
