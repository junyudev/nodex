import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from "electron";
import type { Actions } from "electron-context-menu";
import { getFileManagerRevealLabel } from "../shared/file-link-openers";
import {
  APP_FILESYSTEM_HOST,
  APP_FILESYSTEM_PREFIX,
  restoreNativeAppFilesystemPath,
} from "../shared/app-protocol";

export function nativeContextImagePath(source: string): string | null {
  try {
    const url = new URL(source);
    if (
      url.protocol !== "app:" ||
      url.hostname !== APP_FILESYSTEM_HOST ||
      !url.pathname.startsWith(`${APP_FILESYSTEM_PREFIX}/`)
    )
      return null;
    return restoreNativeAppFilesystemPath(
      decodeURIComponent(url.pathname.slice(APP_FILESYSTEM_PREFIX.length)),
    );
  } catch {
    return null;
  }
}

export function nativeImageContextMenuItems(
  actions: Actions,
  params: ContextMenuParams,
  window: BrowserWindow,
  platform: string,
  reveal: (path: string) => void,
): MenuItemConstructorOptions[] {
  actions.cut({}).accelerator = "CmdOrCtrl+X";
  actions.copy({}).accelerator = "CmdOrCtrl+C";
  actions.paste({}).accelerator = "CmdOrCtrl+V";
  if (params.mediaType !== "image") return [];
  const items: MenuItemConstructorOptions[] = [];
  const path = nativeContextImagePath(params.srcURL);
  if (path)
    items.push({
      label: getFileManagerRevealLabel(platform),
      click: () => reveal(path),
    });
  items.push(actions.copyImage({}));
  if (params.frame == null || params.frame === window.webContents.mainFrame)
    items.push(actions.saveImageAs({}));
  return items;
}
