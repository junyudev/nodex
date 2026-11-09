import type { PageReference } from "../../../../../shared/page-reference";
import { buildPageDeepLink } from "@/lib/page-deeplink";
import { PageIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import { useConversationPageNavigation } from "../../conversation-page-navigation";

/** The Pages a message pointed at, kept as references the reader can reopen. */
export function UserMessagePageReferences({
  references,
  onOpenPage,
}: {
  readonly references: readonly PageReference[];
  readonly onOpenPage?: (pageId: string, titleSnapshot?: string) => void;
}) {
  const navigation = useConversationPageNavigation();
  const openPage = onOpenPage ?? navigation;
  if (references.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {references.map((reference) => {
        const selected = reference.selectedBlockIds.length;
        return (
          <a
            key={reference.pageId}
            href={buildPageDeepLink(reference)}
            data-user-message-page-reference={reference.pageId}
            className={cn(
              "inline-flex h-6 max-w-64 items-center gap-1 rounded-full px-2 text-xs text-token-text-secondary ring-[0.5px] ring-inset ring-token-border",
              openPage ? "cursor-interaction hover:bg-token-foreground/5" : "cursor-default",
            )}
            onClick={(event) => {
              event.preventDefault();
              openPage?.(reference.pageId, reference.titleSnapshot);
            }}
          >
            <PageIcon className="size-3.5 shrink-0 text-token-description-foreground" />
            <span className="truncate">{reference.titleSnapshot || "Untitled"}</span>
            {selected > 0 ? (
              <span className="shrink-0 text-token-description-foreground">
                · {selected === 1 ? "1 block" : `${selected} blocks`}
              </span>
            ) : null}
          </a>
        );
      })}
    </div>
  );
}
