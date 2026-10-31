import type { OpenUserAttachmentImagePreviewOptions } from "./types";

export type UserAttachmentImagePreviewOpener = (
  options: OpenUserAttachmentImagePreviewOptions,
) => Promise<boolean>;

let activeOpener: UserAttachmentImagePreviewOpener | null = null;

/** Connects image entry surfaces to the active Workbench without prop drilling. */
export function registerUserAttachmentImagePreviewOpener(
  opener: UserAttachmentImagePreviewOpener,
): () => void {
  activeOpener = opener;
  return () => {
    if (activeOpener === opener) activeOpener = null;
  };
}

export async function openUserAttachmentImagePreview(
  options: OpenUserAttachmentImagePreviewOptions,
): Promise<boolean> {
  if (!activeOpener) return false;
  return activeOpener(options);
}
