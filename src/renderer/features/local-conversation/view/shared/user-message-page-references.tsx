import { useIntl } from "@/lib/i18n";
import type { PageReference } from "../../../../../shared/page-reference";
import { buildPageDeepLink } from "@/lib/page-deeplink";
import { PageIcon } from "@/components/shared/icons";
import { useNodexReferenceInteraction } from "@/components/nodex-reference/nodex-reference";
import { cn } from "@/lib/utils";

/** The Pages a message pointed at, kept as references the reader can reopen. */
export function UserMessagePageReferences({
  references,
}: {
  readonly references: readonly PageReference[];
}) {
  if (references.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {references.map((reference) => (
        <UserMessagePageReferenceChip key={reference.pageId} reference={reference} />
      ))}
    </div>
  );
}

function UserMessagePageReferenceChip({ reference }: { readonly reference: PageReference }) {
  const intl = useIntl();
  const selected = reference.selectedBlockIds.length;
  const title =
    reference.titleSnapshot ||
    intl.formatMessage({
      id: "conversation.userMessagePageReferences.untitled",
      defaultMessage: "Untitled",
    });
  const { interactive, handlers } = useNodexReferenceInteraction({
    destination: { kind: "page", pageId: reference.pageId },
    openable: true,
    title,
  });
  return (
    <a
      href={buildPageDeepLink(reference)}
      data-user-message-page-reference={reference.pageId}
      className={cn(
        "inline-flex h-6 max-w-64 items-center gap-1 rounded-full px-2 text-xs text-token-text-secondary ring-[0.5px] ring-inset ring-token-border",
        interactive ? "cursor-interaction hover:bg-token-foreground/5" : "cursor-default",
      )}
      {...handlers}
    >
      <PageIcon className="size-3.5 shrink-0 text-token-description-foreground" />
      <span className="truncate">{title}</span>
      {selected > 0 ? (
        <span className="shrink-0 text-token-description-foreground">
          · {selected === 1 ? "1 block" : `${selected} blocks`}
        </span>
      ) : null}
    </a>
  );
}
