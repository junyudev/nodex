import type { ReactNode } from "react";
import type { InboxItem } from "../../../shared/inbox";
import { readMarkdown } from "../../../shared/nodex-markdown";
import { MessageDocument } from "@/components/message/message-document";
import { useLibraryMetadata } from "@/lib/use-library-navigation";
import { inboxPageRoutingContext } from "./inbox-presentation";

/**
 * A message as its Page holds it now, with the Page's own access to the Files it shows. `lead`
 * opens its first line. A message someone else sent reads as a `brief`, receding beneath its
 * headline when it has one.
 */
export function InboxMessageDocument({
  item,
  lead,
  brief = false,
  recede = false,
}: {
  readonly item: InboxItem;
  readonly lead?: ReactNode;
  readonly brief?: boolean;
  readonly recede?: boolean;
}) {
  const library = useLibraryMetadata();
  return (
    <MessageDocument
      blocks={readMarkdown(item.body)}
      contentKey={item.body}
      lead={lead}
      brief={brief}
      recede={recede}
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
