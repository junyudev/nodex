import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  BlockColorsItem,
  DragHandleMenu,
  RemoveBlockItem,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  useComponentsContext,
  useDictionary,
  useExtensionState,
} from "@blocknote/react";

export type SendBlocksMode = "card" | "project";

interface NfmDragHandleMenuProps {
  canSendBlocks: boolean;
  onSendBlocks: (mode: SendBlocksMode, fallbackBlockId: string) => void;
}

export function NfmDragHandleMenu({
  canSendBlocks,
  onSendBlocks,
}: NfmDragHandleMenuProps) {
  const dict = useDictionary();
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
      <RemoveBlockItem>{dict.drag_handle.delete_menuitem}</RemoveBlockItem>
      <BlockColorsItem>{dict.drag_handle.colors_menuitem}</BlockColorsItem>
      <TableRowHeaderItem>{dict.drag_handle.header_row_menuitem}</TableRowHeaderItem>
      <TableColumnHeaderItem>{dict.drag_handle.header_column_menuitem}</TableColumnHeaderItem>
    </DragHandleMenu>
  );
}
