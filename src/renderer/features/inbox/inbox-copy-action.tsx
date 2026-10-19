import type { InboxItem } from "../../../shared/inbox";
import { CheckmarkIcon, CopyIcon } from "@/components/shared/icons";
import { toast } from "@/components/ui/toast";
import { writeTextToClipboard } from "@/lib/clipboard";
import { loadPageDocumentMaterialization } from "@/lib/page-prompt-context";
import { useCopyFeedback } from "@/lib/use-copy-feedback";
import { InboxIconAction } from "./inbox-icon-action";
import { inboxPageRoutingContext } from "./inbox-presentation";

/** The whole message; a body the stream shows only in part is read from its Page. */
async function inboxMessageText(item: InboxItem): Promise<string> {
  if (!item.bodyTruncated) return item.body;
  const page = await loadPageDocumentMaterialization({
    routingContext: inboxPageRoutingContext(item),
    pageId: item.pageId,
  });
  return page.nfm;
}

export function InboxCopyAction({ item }: { readonly item: InboxItem }) {
  const { copied, copy } = useCopyFeedback(1_500);
  return (
    <InboxIconAction
      label={copied ? "Copied" : "Copy"}
      icon={copied ? CheckmarkIcon : CopyIcon}
      onClick={() =>
        void copy(async () => writeTextToClipboard(await inboxMessageText(item))).then(
          (didCopy) => {
            if (!didCopy) toast.danger("Couldn’t copy the message");
          },
        )
      }
    />
  );
}
