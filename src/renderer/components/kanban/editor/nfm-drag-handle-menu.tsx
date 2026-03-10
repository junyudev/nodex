import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  BlockColorsItem,
  DragHandleMenu,
  useBlockNoteEditor,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  useComponentsContext,
  useDictionary,
  useExtensionState,
} from "@blocknote/react";
import type { ReactNode } from "react";
import { deleteSideMenuBlock } from "./side-menu-freeze-controller";

export type SendBlocksMode = "card" | "project";

export interface NfmDragHandleMenuComponentProps {
  releaseSideMenuFreeze: () => void;
}

interface NfmDragHandleMenuProps extends NfmDragHandleMenuComponentProps {
  canSendBlocks: boolean;
  onSendBlocks: (mode: SendBlocksMode, fallbackBlockId: string) => void;
}

function NfmRemoveBlockItem({
  children,
  releaseSideMenuFreeze,
}: {
  children: ReactNode;
  releaseSideMenuFreeze: () => void;
}) {
  const components = useComponentsContext();
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, {
    selector: (state) => state?.block,
  });

  if (!components || block === undefined) return null;

  return (
    <components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={() => {
        deleteSideMenuBlock({
          block,
          editor,
          releaseSideMenuFreeze,
        });
      }}
    >
      {children}
    </components.Generic.Menu.Item>
  );
}

function NfmDefaultDragHandleMenuItems({
  releaseSideMenuFreeze,
}: NfmDragHandleMenuComponentProps) {
  const dict = useDictionary();

  return (
    <>
      <NfmRemoveBlockItem releaseSideMenuFreeze={releaseSideMenuFreeze}>
        {dict.drag_handle.delete_menuitem}
      </NfmRemoveBlockItem>
      <BlockColorsItem>{dict.drag_handle.colors_menuitem}</BlockColorsItem>
      <TableRowHeaderItem>{dict.drag_handle.header_row_menuitem}</TableRowHeaderItem>
      <TableColumnHeaderItem>{dict.drag_handle.header_column_menuitem}</TableColumnHeaderItem>
    </>
  );
}

export function NfmDefaultDragHandleMenu(
  props: NfmDragHandleMenuComponentProps,
) {
  return (
    <DragHandleMenu>
      <NfmDefaultDragHandleMenuItems {...props} />
    </DragHandleMenu>
  );
}

export function NfmDragHandleMenu({
  canSendBlocks,
  onSendBlocks,
  releaseSideMenuFreeze,
}: NfmDragHandleMenuProps) {
  const components = useComponentsContext();
  const block = useExtensionState(SideMenuExtension, {
    selector: (state) => state?.block,
  });

  const currentBlockId = block?.id;
  const showSendBlocks = canSendBlocks && typeof currentBlockId === "string" && currentBlockId.length > 0;

  return (
    <DragHandleMenu>
      {showSendBlocks && components && (
        <>
          <components.Generic.Menu.Root position="right" sub={true}>
            <components.Generic.Menu.Trigger sub={true}>
              <components.Generic.Menu.Item
                className="bn-menu-item"
                subTrigger={true}
              >
                Send blocks
              </components.Generic.Menu.Item>
            </components.Generic.Menu.Trigger>
            <components.Generic.Menu.Dropdown
              sub={true}
              className="bn-menu-dropdown"
            >
              <components.Generic.Menu.Item
                className="bn-menu-item"
                onClick={() => onSendBlocks("card", currentBlockId)}
              >
                Append to card...
              </components.Generic.Menu.Item>
              <components.Generic.Menu.Item
                className="bn-menu-item"
                onClick={() => onSendBlocks("project", currentBlockId)}
              >
                Turn into cards...
              </components.Generic.Menu.Item>
            </components.Generic.Menu.Dropdown>
          </components.Generic.Menu.Root>
          <components.Generic.Menu.Divider />
        </>
      )}
      <NfmDefaultDragHandleMenuItems releaseSideMenuFreeze={releaseSideMenuFreeze} />
    </DragHandleMenu>
  );
}
