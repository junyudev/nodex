import {
  BrowserWindow,
  Menu,
  session,
  shell,
  webContents,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import type { BrowserPageEmulationTarget } from "../../browser/browser-page-emulation";

export type BrowserWebContentsLike = Pick<
  WebContents,
  | "id"
  | "canGoBack"
  | "canGoForward"
  | "capturePage"
  | "executeJavaScript"
  | "getTitle"
  | "getURL"
  | "goBack"
  | "goForward"
  | "isDestroyed"
  | "isLoading"
  | "inspectElement"
  | "loadURL"
  | "reload"
  | "reloadIgnoringCache"
  | "send"
  | "setWindowOpenHandler"
  | "setZoomFactor"
  | "stop"
  | "session"
> & {
  debugger?: BrowserPageEmulationTarget["debugger"] & {
    detach?(): void;
    on?(eventName: string, listener: (...args: unknown[]) => void): unknown;
    removeListener?(eventName: string, listener: (...args: unknown[]) => void): unknown;
  };
  findInPage?: (
    text: string,
    options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean },
  ) => number;
  isCurrentlyAudible?: () => boolean;
  navigationHistory?: {
    clear?(): void;
    getActiveIndex(): number;
    getAllEntries(): Array<{
      pageState?: string;
      title: string;
      url: string;
    }>;
    restore(options: {
      entries: Array<{
        pageState?: string;
        title: string;
        url: string;
      }>;
      index?: number;
    }): Promise<void>;
  };
  print?: (
    options: { printBackground: boolean },
    callback: (success: boolean, failureReason: string) => void,
  ) => void;
  on(eventName: string, listener: (...args: unknown[]) => void): BrowserWebContentsLike;
  removeListener(eventName: string, listener: (...args: unknown[]) => void): BrowserWebContentsLike;
  stopFindInPage?: (action: "clearSelection" | "keepSelection" | "activateSelection") => void;
};

/** Stateless Electron adapter for the Browser aggregate's synchronous physical operations. */
export interface BrowserElectronPlatform {
  readonly sessionFromPartition: typeof session.fromPartition;
  readonly openExternal: typeof shell.openExternal;
  readonly presentContextMenu: (
    template: MenuItemConstructorOptions[],
    ownerWebContentsId: number,
  ) => void;
  readonly webContentsFromId: (id: number) => BrowserWebContentsLike | null;
}

export const browserElectronPlatform: BrowserElectronPlatform = {
  sessionFromPartition: (partition) => session.fromPartition(partition),
  openExternal: (url, options) => shell.openExternal(url, options),
  presentContextMenu: (template, ownerWebContentsId) => {
    const owner = webContents.fromId(ownerWebContentsId);
    const window = owner ? BrowserWindow.fromWebContents(owner) : null;
    Menu.buildFromTemplate(template).popup(window ? { window } : {});
  },
  webContentsFromId: (id) => webContents.fromId(id) ?? null,
};
