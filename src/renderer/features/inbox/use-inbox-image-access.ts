import type { MessageImageAccess } from "@/components/message/message-images-input";
import { changeFileLifecycle } from "@/lib/library-file-commands";
import { importLibraryFile } from "@/lib/library-file-resources";
import { useLibraryMetadata } from "@/lib/use-library-navigation";
import type { ContentRoutingContext } from "../../../shared/content-routing-context";

/**
 * Images written into an Inbox message become Library Files in the content they are routed to,
 * before the message Page exists; the message body then references them.
 */
export function useInboxImageAccess(routing: ContentRoutingContext): MessageImageAccess | null {
  const library = useLibraryMetadata();
  if (!library.data) return null;
  const authority = {
    contentRoutingContext: routing,
    storeEpoch: library.data.storeEpoch,
    libraryId: library.data.libraryId,
  };
  return {
    importImage: async (file) => {
      const imported = await importLibraryFile(
        authority,
        { kind: "browser_file", file },
        file.name,
      );
      return {
        fileId: imported.file.file_id,
        name: imported.file.default_name,
        importedRevision: imported.file.revision,
      };
    },
    // Core keeps a File that anything uses, and the revision keeps one changed since import.
    discardImport: async (fileId, importedRevision) => {
      await changeFileLifecycle(
        authority,
        { file_id: fileId, revision: importedRevision },
        "trash",
      );
    },
    readAuthority: { ...authority, readSource: { kind: "direct" } },
  };
}
