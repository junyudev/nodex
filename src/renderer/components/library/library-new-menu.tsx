import type { ReactElement } from "react";

import { BoardIcon, PageIcon } from "@/components/shared/icons";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { useApplyLibraryOperation } from "@/lib/use-library-navigation";
import { requestPageTitleFocus } from "@/lib/page-title-focus-intent";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
} from "../../../shared/database-identities";
import type { LibraryRouteTarget, LibraryWriteParent } from "../../../shared/library-module";
import { createUuidV7 } from "../../../shared/uuid-v7";

const LIBRARY_ROOT_PARENT: LibraryWriteParent = { kind: "library" };

export function LibraryNewMenu({
  triggerButton,
  parent = LIBRARY_ROOT_PARENT,
  onCreated,
}: {
  readonly triggerButton: ReactElement;
  readonly parent?: LibraryWriteParent;
  readonly onCreated: (target: LibraryRouteTarget) => void;
}) {
  const commands = useLibraryCreateCommands({ parent, onCreated });

  return (
    <NodexDropdownMenu
      triggerButton={triggerButton}
      disabled={commands.isPending}
      align="end"
      contentWidth="sm"
    >
      <NodexDropdownItem leftSlot={<PageIcon />} onSelect={() => void commands.createPage()}>
        Page
      </NodexDropdownItem>
      <NodexDropdownItem leftSlot={<BoardIcon />} onSelect={() => void commands.createDatabase()}>
        Database
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );
}

/** Creates Library content under `parent`; each command resolves to the created target. */
export function useLibraryCreateCommands({
  parent = LIBRARY_ROOT_PARENT,
  onCreated,
}: {
  readonly parent?: LibraryWriteParent;
  readonly onCreated?: (target: LibraryRouteTarget) => void;
} = {}) {
  const { mutation } = useApplyLibraryOperation();

  const createPage = async (): Promise<LibraryRouteTarget | null> => {
    try {
      const receipt = await mutation.mutateAsync({
        kind: "create_page",
        pageId: createUuidV7(),
        documentId: createUuidV7(),
        title: "Untitled",
        parent,
      });
      if (receipt.createdTarget?.kind !== "page") return null;
      requestPageTitleFocus(receipt.createdTarget.pageId);
      onCreated?.(receipt.createdTarget);
      return receipt.createdTarget;
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Could not create Page");
      return null;
    }
  };

  const createDatabase = async () => {
    try {
      const receipt = await mutation.mutateAsync({
        kind: "create_database",
        databaseId: parseDatabaseId(createUuidV7()),
        dataSourceId: parseDataSourceId(createUuidV7()),
        viewId: parseDatabaseViewId(createUuidV7()),
        name: "Untitled",
        parent,
      });
      if (receipt.createdTarget?.kind === "database") onCreated?.(receipt.createdTarget);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Could not create Database");
    }
  };

  return {
    isPending: mutation.isPending,
    createPage,
    createDatabase,
  };
}
