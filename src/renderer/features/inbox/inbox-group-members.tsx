import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NodexButton } from "@/components/ui/button";
import { libraryPageDetailQueryOptions } from "@/lib/library-page-detail-query";

export interface InboxGroupMember {
  readonly pageId: string;
  readonly label: string;
  readonly body: string | null;
}

function Member({
  pageId,
  member,
  index,
  onOpenPage,
  onRemove,
}: {
  readonly pageId: string;
  readonly member: InboxGroupMember | undefined;
  readonly index: number;
  readonly onOpenPage?: (pageId: string) => void;
  readonly onRemove?: (pageId: string) => void;
}) {
  // Opening a group can reach members outside the Inbox's current page of results.
  const detail = useQuery({ ...libraryPageDetailQueryOptions(pageId), enabled: !member });
  const page = detail.data;
  const label =
    member?.label ??
    (page?.dataSourceContext.kind === "member" ? page.dataSourceContext.pageKey : null) ??
    page?.page.title ??
    `Message ${index + 1}`;
  return (
    <div className="flex min-w-0 items-start gap-2">
      <button
        type="button"
        className="cursor-interaction min-w-0 flex-1 truncate text-left hover:text-token-foreground"
        onClick={() => onOpenPage?.(pageId)}
      >
        {label}
        {member?.body ? ` · ${member.body}` : ""}
      </button>
      {detail.error ? (
        <NodexButton size="xs" variant="ghost" onClick={() => void detail.refetch()}>
          Retry
        </NodexButton>
      ) : null}
      {onRemove ? (
        <NodexButton
          size="xs"
          variant="ghost"
          aria-label={`Remove ${label} from suggestion`}
          onClick={() => onRemove(pageId)}
        >
          Remove
        </NodexButton>
      ) : null}
    </div>
  );
}

/** Membership is inspectable without loading every source Page in the stream. */
export function InboxGroupMembers({
  pageIds,
  members,
  onOpenPage,
  onRemove,
}: {
  readonly pageIds: readonly string[];
  readonly members: readonly InboxGroupMember[];
  readonly onOpenPage?: (pageId: string) => void;
  readonly onRemove?: (pageId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (pageIds.length < 2) return null;
  return (
    <details
      className="text-xs text-token-description-foreground"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-interaction">{pageIds.length} messages</summary>
      {expanded ? (
        <div className="mt-1 flex flex-col gap-1">
          {pageIds.map((pageId, index) => (
            <Member
              key={pageId}
              pageId={pageId}
              index={index}
              member={members.find((member) => member.pageId === pageId)}
              onOpenPage={onOpenPage}
              onRemove={onRemove}
            />
          ))}
        </div>
      ) : null}
    </details>
  );
}
