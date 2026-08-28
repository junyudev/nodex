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
  render: ({ block }) => (
    <DocumentBearingShellBlock
      icon={RefreshIcon}
      label="Synced block"
      detail={block.props.sourceBlockId || "Shared content"}
      identity={block.props.sourceBlockId}
      shellBlockId={block.id}
    />
  ),
});
