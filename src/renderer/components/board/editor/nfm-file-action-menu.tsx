import {
  blockHasType,
  editorHasBlockWithType,
  type BlockSchema,
  type InlineContentSchema,
  type StyleSchema,
} from "@blocknote/core";
import {
  FilePanel,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useEditorState,
} from "@blocknote/react";
import { BackIcon, ReplaceIcon } from "@/components/shared/icons";
import { TextCursorInput } from "@/components/shared/icons/generic-icons";
import { NodexFloatingSurface } from "@/components/ui/floating-surface";
import { cn } from "@/lib/utils";
import { type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";

export type NfmFileAction = {
  type: "caption" | "replace";
  blockId: string;
};

type NfmFileActionButtonProps = {
  onOpen: (blockId: string) => void;
};

function useSelectedFileBlock() {
  const editor = useBlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>();

  return useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => {
      if (!currentEditor.isEditable) return undefined;

      const selectedBlocks = currentEditor.getSelection()?.blocks || [
        currentEditor.getTextCursorPosition().block,
      ];
      if (selectedBlocks.length !== 1) return undefined;

      const selectedBlock = selectedBlocks[0];
      if (
        !blockHasType(selectedBlock, currentEditor, selectedBlock.type, {
          url: "string",
        })
      ) {
        return undefined;
      }

      return selectedBlock;
    },
  });
}

export function NfmFileCaptionButton({ onOpen }: NfmFileActionButtonProps) {
  const dict = useDictionary();
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>();
  const block = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => {
      if (!currentEditor.isEditable) return undefined;

      const selectedBlocks = currentEditor.getSelection()?.blocks || [
        currentEditor.getTextCursorPosition().block,
      ];
      if (selectedBlocks.length !== 1) return undefined;

      const selectedBlock = selectedBlocks[0];
      if (
        !blockHasType(selectedBlock, currentEditor, selectedBlock.type, {
          url: "string",
          caption: "string",
        })
      ) {
        return undefined;
      }

      return selectedBlock;
    },
  });

  if (block === undefined) return null;

  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label={dict.formatting_toolbar.file_caption.tooltip}
      mainTooltip={dict.formatting_toolbar.file_caption.tooltip}
      icon={<TextCursorInput />}
      onClick={() => onOpen(block.id)}
    />
  );
}

export function NfmFileReplaceButton({ onOpen }: NfmFileActionButtonProps) {
  const dict = useDictionary();
  const Components = useComponentsContext()!;
  const block = useSelectedFileBlock();

  if (block === undefined) return null;

  const label =
    dict.formatting_toolbar.file_replace.tooltip[block.type] ||
    dict.formatting_toolbar.file_replace.tooltip.file;

  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label={label}
      mainTooltip={label}
      icon={<ReplaceIcon />}
      onClick={() => onOpen(block.id)}
    />
  );
}

function useFileBlock(blockId: string) {
  const editor = useBlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>();

  const block = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => {
      const candidate = currentEditor.getBlock(blockId);
      if (
        !candidate ||
        !blockHasType(candidate, currentEditor, candidate.type, {
          url: "string",
        })
      ) {
        return undefined;
      }

      return candidate;
    },
  });

  return { block, editor };
}

function NfmFileActionPanel({
  children,
  className,
  onClose,
  title,
}: {
  children: ReactNode;
  className?: string;
  onClose: () => void;
  title: string;
}) {
  return (
    <NodexFloatingSurface
      aria-label={title}
      className={cn("overflow-hidden", className)}
      contentEditable={false}
      data-testid="nfm-file-action-panel"
      role="dialog"
    >
      <div className="flex h-9 items-center gap-1 border-b-[0.5px] border-token-border px-1.5">
        <button
          type="button"
          aria-label="Back to image actions"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-token-text-secondary outline-hidden hover:bg-token-foreground/6 hover:text-token-foreground focus-visible:ring-1 focus-visible:ring-token-focus-border"
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={onClose}
        >
          <BackIcon className="size-4" />
        </button>
        <span className="min-w-0 flex-1 truncate px-1 text-[13px] font-medium leading-5 text-token-foreground">
          {title}
        </span>
      </div>

      {children}
    </NodexFloatingSurface>
  );
}

function NfmFileCaptionPanel({ blockId, onClose }: { blockId: string; onClose: () => void }) {
  const dict = useDictionary();
  const Components = useComponentsContext()!;
  const { block, editor } = useFileBlock(blockId);

  if (
    block === undefined ||
    !blockHasType(block, editor, block.type, {
      url: "string",
      caption: "string",
    })
  ) {
    return null;
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!editorHasBlockWithType(editor, block.type, { caption: "string" })) return;
    editor.updateBlock(block.id, {
      props: { caption: event.currentTarget.value },
    });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    if (event.key === "Enter" && event.nativeEvent.isComposing) return;

    event.preventDefault();
    onClose();
  };

  return (
    <NfmFileActionPanel
      title={dict.formatting_toolbar.file_caption.tooltip}
      onClose={onClose}
      className="w-[16.5rem]"
    >
      <div className="p-2">
        <Components.Generic.Form.Root>
          <Components.Generic.Form.TextInput
            name="file-caption"
            icon={<TextCursorInput />}
            value={block.props.caption}
            autoFocus={true}
            placeholder={dict.formatting_toolbar.file_caption.input_placeholder}
            onKeyDown={handleKeyDown}
            onChange={handleChange}
          />
        </Components.Generic.Form.Root>
      </div>
    </NfmFileActionPanel>
  );
}

function NfmFileReplacePanel({ blockId, onClose }: { blockId: string; onClose: () => void }) {
  const dict = useDictionary();
  const { block } = useFileBlock(blockId);

  if (block === undefined) return null;

  const title =
    dict.formatting_toolbar.file_replace.tooltip[block.type] ||
    dict.formatting_toolbar.file_replace.tooltip.file;

  return (
    <NfmFileActionPanel title={title} onClose={onClose} className="min-w-[18rem]">
      <FilePanel blockId={block.id} />
    </NfmFileActionPanel>
  );
}

export function NfmFileActionMenu({
  action,
  onClose,
}: {
  action: NfmFileAction;
  onClose: () => void;
}) {
  if (action.type === "caption") {
    return <NfmFileCaptionPanel blockId={action.blockId} onClose={onClose} />;
  }

  return <NfmFileReplacePanel blockId={action.blockId} onClose={onClose} />;
}
