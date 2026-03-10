import { SideMenuExtension, SuggestionMenu } from "@blocknote/core/extensions";
import {
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useExtension,
  useExtensionState,
} from "@blocknote/react";
import { GripVertical, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  NfmDefaultDragHandleMenu,
  type NfmDragHandleMenuComponentProps,
} from "./nfm-drag-handle-menu";
import { resolveCardRefOwnerDragBlock } from "./side-menu-drag-target";
import { createSideMenuFreezeController } from "./side-menu-freeze-controller";

interface SideMenuBlock {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
}

interface SideMenuEditorRuntime {
  getBlock: (blockId: string) => unknown;
  getParentBlock: (blockId: string) => unknown;
  schema: {
    blockSpecs: Record<string, { implementation: { meta?: { fileBlockAccept?: boolean } } }>;
  };
}

interface NfmSideMenuProps {
  dragHandleMenu?: ComponentType<NfmDragHandleMenuComponentProps>;
}

function toStringProp(props: Record<string, unknown> | undefined, key: string): string {
  const value = props?.[key];
  return typeof value === "string" ? value : "";
}

function toNumberProp(props: Record<string, unknown> | undefined, key: string): number | null {
  const value = props?.[key];
  return typeof value === "number" ? value : null;
}

interface SideMenuButtonProps {
  label: string;
  className?: string;
  icon?: ReactNode;
  onClick?: () => void;
  onDragStart?: (event: { dataTransfer: DataTransfer | null; clientY: number }) => void;
  onDragEnd?: () => void;
  draggable?: boolean;
  tabIndex?: number;
}

function NfmAddBlockButton() {
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  const editor = useBlockNoteEditor();
  const suggestionMenu = useExtension(SuggestionMenu);
  const SideMenuButton = Components.SideMenu.Button as unknown as (props: SideMenuButtonProps) => ReactNode;
  type CursorTarget = Parameters<typeof editor.setTextCursorPosition>[0];
  const block = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block,
  }) as (CursorTarget & { content?: unknown[] }) | undefined;

  const handleClick = useCallback(() => {
    if (!block) return;

    const blockContent = Array.isArray(block.content) ? block.content : [];
    if (blockContent.length === 0) {
      editor.setTextCursorPosition(block);
      suggestionMenu.openSuggestionMenu("/");
      return;
    }

    const insertedBlock = editor.insertBlocks([{ type: "paragraph" }], block, "after")[0];
    if (!insertedBlock) return;

    editor.setTextCursorPosition(insertedBlock);
    suggestionMenu.openSuggestionMenu("/");
  }, [block, editor, suggestionMenu]);

  if (!block) return null;

  return (
    <SideMenuButton
      className="bn-button"
      label={dict.side_menu.add_block_label}
      tabIndex={-1}
      onClick={handleClick}
      icon={<Plus size={18} />}
    />
  );
}

export function NfmSideMenu(props: NfmSideMenuProps) {
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  const sideMenu = useExtension(SideMenuExtension);
  const editor = useBlockNoteEditor();
  const SideMenuButton = Components.SideMenu.Button as unknown as (props: SideMenuButtonProps) => ReactNode;
  const block = useExtensionState(SideMenuExtension, {
    selector: (state) => state?.block,
  }) as unknown as SideMenuBlock | undefined;

  const runtimeEditor = editor as unknown as SideMenuEditorRuntime;
  const freezeController = useMemo(
    () => createSideMenuFreezeController(sideMenu),
    [sideMenu],
  );

  const dragTargetBlock = useMemo(
    () => (block ? resolveCardRefOwnerDragBlock(runtimeEditor, block) : block),
    [block, runtimeEditor],
  ) as SideMenuBlock | undefined;

  const dataAttributes = useMemo(() => {
    if (!block) return {};

    const attrs: Record<string, string> = {
      "data-block-type": block.type ?? "",
    };

    if (block.type === "heading") {
      const level = toNumberProp(block.props, "level");
      if (level !== null) attrs["data-level"] = level.toString();
    }

    if (
      block.type
      && runtimeEditor.schema.blockSpecs[block.type]?.implementation?.meta?.fileBlockAccept
    ) {
      attrs["data-url"] = toStringProp(block.props, "url").length > 0 ? "true" : "false";
    }

    return attrs;
  }, [block, runtimeEditor.schema.blockSpecs]);

  useEffect(
    () => () => {
      freezeController.release();
    },
    [freezeController],
  );

  if (!block || !dragTargetBlock) return null;

  const DragHandleMenuComponent = props.dragHandleMenu ?? NfmDefaultDragHandleMenu;

  return (
    <Components.SideMenu.Root className="bn-side-menu" {...dataAttributes}>
      <NfmAddBlockButton />
      <Components.Generic.Menu.Root
        onOpenChange={freezeController.handleMenuOpenChange}
        position="left"
      >
        <Components.Generic.Menu.Trigger>
          <SideMenuButton
            label={dict.side_menu.drag_handle_label}
            draggable={true}
            onDragStart={(event: { dataTransfer: DataTransfer | null; clientY: number }) =>
              sideMenu.blockDragStart(event, dragTargetBlock as never)
            }
            onDragEnd={sideMenu.blockDragEnd}
            className="bn-button"
            tabIndex={-1}
            icon={<GripVertical size={24} data-test="dragHandle" />}
          />
        </Components.Generic.Menu.Trigger>
        <DragHandleMenuComponent
          releaseSideMenuFreeze={freezeController.release}
        />
      </Components.Generic.Menu.Root>
    </Components.SideMenu.Root>
  );
}
