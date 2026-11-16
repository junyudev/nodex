import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from "electron";
import type { Actions, Labels } from "electron-context-menu";
import { getMainIntl } from "./i18n/main-intl";
import { getFileManagerRevealMessage } from "../shared/file-link-openers";
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

/** The dependency substitutes selected text after applying these labels. */
export function nativeEditorContextMenuLabels(params: ContextMenuParams): Labels {
  return {
    learnSpelling: getMainIntl().formatMessage({
      id: "main.editorContextMenu.learnSpelling",
      defaultMessage: "&Learn Spelling",
    }),
    searchWithGoogle: getMainIntl().formatMessage({
      id: "main.editorContextMenu.searchWithGoogle",
      defaultMessage: "&Search with Google",
    }),
    cut: getMainIntl().formatMessage({ id: "main.editorContextMenu.cut", defaultMessage: "Cu&t" }),
    copy: getMainIntl().formatMessage({
      id: "main.editorContextMenu.copy",
      defaultMessage: "&Copy",
    }),
    paste: getMainIntl().formatMessage({
      id: "main.editorContextMenu.paste",
      defaultMessage: "&Paste",
    }),
    selectAll: getMainIntl().formatMessage({
      id: "main.editorContextMenu.selectAll",
      defaultMessage: "Select &All",
    }),
    saveImageAs: getMainIntl().formatMessage({
      id: "main.editorContextMenu.saveImageAs",
      defaultMessage: "Sa&ve Image As…",
    }),
    copyLink: getMainIntl().formatMessage({
      id: "main.editorContextMenu.copyLink",
      defaultMessage: "Copy Lin&k",
    }),
    copyImage: getMainIntl().formatMessage({
      id: "main.editorContextMenu.copyImage",
      defaultMessage: "Cop&y Image",
    }),
    inspect: getMainIntl().formatMessage({
      id: "main.editorContextMenu.inspect",
      defaultMessage: "I&nspect Element",
    }),
    lookUpSelection: getMainIntl().formatMessage(
      { id: "main.editorContextMenu.lookUpSelection", defaultMessage: "Look Up “{selection}”" },
      { selection: "{selection}" },
    ),
    ...(params.dictionarySuggestions.length === 0
      ? {
          dictionarySuggestions: getMainIntl().formatMessage({
            id: "main.editorContextMenu.noSpellingSuggestions",
            defaultMessage: "No Guesses Found",
          }),
        }
      : {}),
  };
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
      label: getMainIntl().formatMessage(getFileManagerRevealMessage(platform)),
      click: () => reveal(path),
    });
  items.push(actions.copyImage({}));
  if (params.frame == null || params.frame === window.webContents.mainFrame)
    items.push(actions.saveImageAs({}));
  return items;
}
