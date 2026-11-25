import type { BrowserWebContentsLike } from "./BrowserElectronPlatform";

export interface BrowserNativePageDialog {
  frame: { readonly url: string };
  dialogType: string;
  messageText: string;
}

export type BrowserPageDialogCallback = (accept: boolean, userInput: string) => void;

/**
 * Replaces Electron's internal -run-dialog / -cancel-dialogs events for Browser page guests.
 * There is no public deferred-answer alternative: disableDialogs answers immediately and
 * CDP cannot suppress the native box. src/main/browser-platform.nightly.integration.ts guards this seam.
 * The caller's guest listener Scope owns release; a released guest keeps a dismiss-only listener.
 */
export function installBrowserPageDialogAdapter(
  contents: BrowserWebContentsLike,
  open: (info: BrowserNativePageDialog, callback: BrowserPageDialogCallback) => void,
  cancel: () => void,
): () => void {
  const run = (...args: unknown[]) =>
    open(args[0] as BrowserNativePageDialog, args[1] as BrowserPageDialogCallback);
  const closed = (_event: unknown, method: unknown) => {
    if (method === "Page.javascriptDialogClosed") cancel();
  };
  const dismiss = (_info: unknown, callback: unknown) =>
    (callback as BrowserPageDialogCallback)(false, "");
  contents.removeAllListeners("-run-dialog");
  contents.on("-run-dialog", run);
  contents.on("-cancel-dialogs", cancel);
  contents.debugger?.on?.("message", closed);
  return () => {
    contents.removeListener("-run-dialog", run);
    contents.on("-run-dialog", dismiss);
    contents.removeListener("-cancel-dialogs", cancel);
    contents.debugger?.removeListener?.("message", closed);
  };
}
