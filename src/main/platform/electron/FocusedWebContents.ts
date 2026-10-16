import { webContents, type WebContents } from "electron";

/**
 * Child-frame guests can report their host's native focus even when hidden.
 * The focused frame identifies the actual owner for native menu commands.
 */
export function getFocusedFrameOwner(
  native: Pick<typeof webContents, "getAllWebContents" | "fromFrame"> = webContents,
): WebContents | null {
  for (const contents of native.getAllWebContents()) {
    if (contents.isDestroyed() || !contents.isFocused()) continue;
    const frame = contents.focusedFrame;
    if (!frame) continue;
    const owner = native.fromFrame(frame);
    if (owner && !owner.isDestroyed()) return owner;
  }
  return null;
}
