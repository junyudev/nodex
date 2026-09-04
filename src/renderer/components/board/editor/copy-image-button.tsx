import {
  type BlockSchema,
  blockHasType,
  type InlineContentSchema,
  type StyleSchema,
} from "@blocknote/core";
import { useBlockNoteEditor, useComponentsContext, useEditorState } from "./copy-image-button-deps";
import { CopyIcon } from "@/components/shared/icons";
import { useCallback } from "react";
import { toast } from "@/components/ui/toast";

import { copyImageToClipboard } from "./copy-image";
import { parseFileSource } from "../../../../shared/file-resources";
import { useFilePlacementRuntime } from "./file-runtime";

export function CopyImageButton({
  copyImageToClipboardImpl = copyImageToClipboard,
}: {
  copyImageToClipboardImpl?: typeof copyImageToClipboard;
}) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>();
  const fileRuntime = useFilePlacementRuntime();

  const block = useEditorState({
    editor,
    selector: ({ editor }) => {
      const selectedBlocks = editor.getSelection()?.blocks ?? [
        editor.getTextCursorPosition().block,
      ];

      if (selectedBlocks.length !== 1) return undefined;

      const selectedBlock = selectedBlocks[0];
      if (selectedBlock.type !== "image") return undefined;

      if (
        !blockHasType(selectedBlock, editor, selectedBlock.type, {
          url: "string",
        })
      ) {
        return undefined;
      }

      return selectedBlock;
    },
  });

  const onClick = useCallback(() => {
    if (!block) return;

    void (async () => {
      const source =
        parseFileSource(block.props.url) && fileRuntime
          ? await fileRuntime.readImageDataUrl(block.props.url)
          : block.props.url;
      return copyImageToClipboardImpl(source);
    })()
      .then((result) => {
        if (!result.ok) {
          toast.danger(result.message, {
            id: "editor-copy-image",
          });
          return;
        }

        toast.success("Copied image to clipboard.", {
          id: "editor-copy-image",
        });
        editor.focus();
      })
      .catch(() => {
        toast.danger("The image could not be read.", {
          id: "editor-copy-image",
        });
      });
  }, [block, copyImageToClipboardImpl, editor, fileRuntime]);

  if (!block) return null;

  return (
    <Components.FormattingToolbar.Button
      className={"bn-button"}
      label={"Copy image"}
      mainTooltip={"Copy image"}
      icon={<CopyIcon className="size-4" />}
      onClick={onClick}
    />
  );
}
