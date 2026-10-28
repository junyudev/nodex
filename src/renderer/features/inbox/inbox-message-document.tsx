import type { InboxItem } from "../../../shared/inbox";
import { readMarkdown } from "../../../shared/nodex-markdown";
import { MessageDocument } from "@/components/message/message-document";
import { useLibraryMetadata } from "@/lib/use-library-navigation";
import { inboxPageRoutingContext } from "./inbox-presentation";

/** A message as its Page holds it now, with the Page's own access to the Files it shows. */
export function InboxMessageDocument({ item }: { readonly item: InboxItem }) {
  const library = useLibraryMetadata();
  return (
    <MessageDocument
      blocks={readMarkdown(item.body)}
      contentKey={item.body}
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
