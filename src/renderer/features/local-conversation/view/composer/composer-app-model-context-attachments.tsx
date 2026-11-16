import { useIntl } from "@/lib/i18n";
import {
  isCodexAppModelContextVisible,
  type CodexAppModelContextAttachment,
} from "../../../../../shared/codex-untrusted-app-input";
import { NodexTooltip } from "../../../../components/ui/tooltip";

/** Hidden model-only updates never become visible Composer attachments. */
export function ComposerAppModelContextAttachments({
  attachments,
  onRemove,
}: {
  readonly attachments: readonly CodexAppModelContextAttachment[];
  readonly onRemove: (id: string) => void;
}) {
  const intl = useIntl();
  return attachments.filter(isCodexAppModelContextVisible).map((attachment) => {
    const label = attachment.composerLabel ?? attachment.sourceName ?? attachment.title;
    return (
      <NodexTooltip
        key={attachment.id}
        tooltipContent={intl.formatMessage(
          {
            id: "conversation.composerAppModelContextAttachments.remove",
            defaultMessage: "Remove {label} context",
          },
          { label },
        )}
      >
        <button
          type="button"
          aria-label={intl.formatMessage(
            {
              id: "conversation.composerAppModelContextAttachments.remove",
              defaultMessage: "Remove {label} context",
            },
            { label },
          )}
          className="inline-flex max-w-48 items-center gap-1 rounded-full px-2 py-1 text-xs text-token-foreground ring-[0.5px] ring-inset ring-token-border hover:bg-token-foreground/5"
          onClick={() => onRemove(attachment.id)}
        >
          <span className="min-w-0 truncate">{label}</span>
          <span aria-hidden="true" className="shrink-0 text-token-description-foreground">
            ×
          </span>
        </button>
      </NodexTooltip>
    );
  });
}
