import {
  blockHasType,
  type BlockSchema,
  type InlineContentSchema,
  type StyleSchema,
} from "@blocknote/core";
import {
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useEditorState,
} from "@blocknote/react";
import { DownloadIcon } from "@/components/shared/icons";
import { toast } from "@/components/ui/toast";
import {
  createImageDownloadFilename,
  downloadImageDataUrl,
  materializeImageSourceAsDataUrl,
} from "@/features/user-attachment-image-editor";
import { readManagedImageDataUrl } from "@/lib/assets";
import { parseFileSource } from "../../../../shared/file-resources";
import { useFilePlacementRuntime } from "./file-runtime";

export function NfmFileDownloadButton() {
  const dict = useDictionary();
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>();
  const fileRuntime = useFilePlacementRuntime();

  const block = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => {
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

  if (block === undefined) return null;

  const onClick = () => {
    editor.focus();
    void (async () => {
      try {
        const source = block.props.url;
        const dataUrl =
          parseFileSource(source) && fileRuntime
            ? await fileRuntime.readImageDataUrl(source)
            : await materializeImageSourceAsDataUrl(source, {
                readManagedAsset: readManagedImageDataUrl,
              });
        const props = block.props as typeof block.props & {
          caption?: string;
          name?: string;
        };
        downloadImageDataUrl(
          dataUrl,
          createImageDownloadFilename(source, props.name || props.caption),
        );
      } catch {
        toast.danger("Could not download image", {
          id: "editor-download-image",
        });
      }
    })();
  };

  const label =
    dict.formatting_toolbar.file_download.tooltip[block.type] ||
    dict.formatting_toolbar.file_download.tooltip.file;

  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label={label}
      mainTooltip={label}
      icon={<DownloadIcon />}
      onClick={onClick}
    />
  );
}
