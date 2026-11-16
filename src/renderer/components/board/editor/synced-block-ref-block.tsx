import { useIntl } from "@/lib/i18n";
import { RefreshIcon } from "@/components/shared/icons";
import { createReactBlockSpec } from "@blocknote/react";
import { syncedBlockRefBlockConfig } from "../../../../shared/block-documents/blocknote-schema-config";
import { DocumentBearingShellBlock } from "./document-bearing-shell-block";

/**
 * Reference-only shell for a Synced Block source. The source body is never a
 * ProseMirror child of the host; an owned-Document boundary may mount it when
 * the reference becomes an interactive surface.
 */
export const createSyncedBlockRefBlockSpec = createReactBlockSpec(syncedBlockRefBlockConfig, {
  render: function SyncedBlockRefBlockView({ block }) {
    const intl = useIntl();
    return (
      <DocumentBearingShellBlock
        icon={RefreshIcon}
        label={intl.formatMessage({
          id: "editor.syncedBlockRefBlock.synced",
          defaultMessage: "Synced block",
        })}
        detail={
          block.props.sourceBlockId ||
          intl.formatMessage({
            id: "editor.syncedBlockRefBlock.sharedContent",
            defaultMessage: "Shared content",
          })
        }
        identity={block.props.sourceBlockId}
        shellBlockId={block.id}
      />
    );
  },
});
