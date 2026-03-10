import { FormattingToolbar, getFormattingToolbarItems } from "@blocknote/react";
import { CopyImageButton } from "./copy-image-button";

export function NfmFormattingToolbar() {
  const toolbarItems = getFormattingToolbarItems();
  const copyImageButton = <CopyImageButton key="copyImageButton" />;
  const fileDownloadButtonIndex = toolbarItems.findIndex(
    (item) => item.key === "fileDownloadButton",
  );

  if (fileDownloadButtonIndex < 0) {
    return <FormattingToolbar>{[...toolbarItems, copyImageButton]}</FormattingToolbar>;
  }

  const itemsWithCopy = [...toolbarItems];
  itemsWithCopy.splice(fileDownloadButtonIndex + 1, 0, copyImageButton);
  return <FormattingToolbar>{itemsWithCopy}</FormattingToolbar>;
}
