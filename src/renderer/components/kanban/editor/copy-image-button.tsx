import {
  type BlockSchema,
  blockHasType,
  type InlineContentSchema,
  type StyleSchema,
} from "@blocknote/core";
import {
  useBlockNoteEditor,
  useComponentsContext,
  useEditorState,
} from "@blocknote/react";
import { Copy } from "lucide-react";
import { useCallback } from "react";

import { copyImageToClipboard } from "./copy-image";

export function CopyImageButton() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor<
    BlockSchema,
    InlineContentSchema,
    StyleSchema
  >();

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

    void copyImageToClipboard({
      source: block.props.url,
      resolveFileUrl: editor.resolveFileUrl?.bind(editor),
    })
      .then(() => {
        editor.focus();
      })
      .catch((error) => {
        console.error("Failed to copy image", error);
      });
  }, [block, editor]);

  if (!block) return null;

  return (
    <Components.FormattingToolbar.Button
      className={"bn-button"}
      label={"Copy image"}
      mainTooltip={"Copy image"}
      icon={<Copy className="size-4" />}
      onClick={onClick}
    />
  );
}
