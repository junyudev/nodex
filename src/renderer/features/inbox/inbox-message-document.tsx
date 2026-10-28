import type { ReactNode } from "react";
import type { InboxItem } from "../../../shared/inbox";
import { readMarkdown } from "../../../shared/nodex-markdown";
import { MessageDocument } from "@/components/message/message-document";
import { useLibraryMetadata } from "@/lib/use-library-navigation";
import { inboxPageRoutingContext } from "./inbox-presentation";

/**
 * A message as its Page holds it now, with the Page's own access to the Files it shows. `lead`
 * opens its first line.
 */
export function InboxMessageDocument({
  item,
  lead,
}: {
  readonly item: InboxItem;
  readonly lead?: ReactNode;
}) {
  const library = useLibraryMetadata();
  return (
    <MessageDocument
      blocks={readMarkdown(item.body)}
      contentKey={item.body}
      lead={lead}
      fileAuthority={
        library.data
          ? {
              contentRoutingContext: inboxPageRoutingContext(item),
              storeEpoch: library.data.storeEpoch,
              libraryId: library.data.libraryId,
              readSource: { kind: "page", page_id: item.pageId },
            }
          : null
      }
    />
  );
}
