import { randomUUID } from "node:crypto";
import type { BrowserPageDialog } from "../../shared/browser/browser-page-dialogs";
import type {
  BrowserNativePageDialog,
  BrowserPageDialogCallback,
} from "../platform/electron/BrowserPageDialogAdapter";
import { permissionOrigin } from "./browser-permission-store";

/** Includes the final ellipsis; bounds untrusted page text in every tab snapshot. */
export const BROWSER_PAGE_DIALOG_MESSAGE_LIMIT = 4_096;

export function pageDialogDetails(
  info: BrowserNativePageDialog,
  pageUrl: string,
): Pick<BrowserPageDialog, "origin" | "embeddingOrigin" | "message"> {
  const pageOrigin = permissionOrigin(pageUrl);
  const origin = permissionOrigin(info.frame.url) ?? pageOrigin ?? "null";
  return {
    origin,
    ...(pageOrigin && pageOrigin !== origin ? { embeddingOrigin: pageOrigin } : {}),
    message:
      info.messageText.length > BROWSER_PAGE_DIALOG_MESSAGE_LIMIT
        ? `${info.messageText.slice(0, BROWSER_PAGE_DIALOG_MESSAGE_LIMIT - 1)}…`
        : info.messageText,
  };
}

/** Synchronous dialog state for one guest; the guest listener Scope owns its lifetime. */
export class BrowserPageDialogs {
  private pending: { dialog: BrowserPageDialog; callback: BrowserPageDialogCallback } | undefined;
  private readonly counts = new Map<string, number>();
  private readonly suppressed = new Set<string>();

  constructor(private readonly publish: (dialog: BrowserPageDialog | undefined) => void) {}

  open(info: BrowserNativePageDialog, pageUrl: string, callback: BrowserPageDialogCallback): void {
    if (info.dialogType !== "alert" && info.dialogType !== "confirm") return callback(false, "");
    const details = pageDialogDetails(info, pageUrl);
    const count = (this.counts.get(details.origin) ?? 0) + 1;
    this.counts.set(details.origin, count);
    if (this.suppressed.has(details.origin)) return callback(false, "");
    // Chromium normally serializes dialogs. Never orphan the prior callback if that changes.
    this.dismiss();
    const dialog: BrowserPageDialog = {
      ...details,
      id: randomUUID(),
      kind: info.dialogType,
      canSuppress: count > 1,
    };
    this.pending = { dialog, callback };
    this.publish(dialog);
  }

  respond(dialogId: string, accept: boolean, suppress = false): boolean {
    const pending = this.pending;
    if (!pending || pending.dialog.id !== dialogId) return false;
    if (suppress) this.suppressed.add(pending.dialog.origin);
    this.dismiss(accept);
    return true;
  }

  dismiss(accept = false): void {
    const pending = this.pending;
    if (!pending) return;
    // Clear before resuming Chromium: callback/CDP ingress may reenter synchronously.
    this.settle();
    pending.callback(accept, "");
  }

  /** Native cancellation or a CDP answer already resumed the page. Drop our answer. */
  settle(): void {
    if (!this.pending) return;
    this.pending = undefined;
    this.publish(undefined);
  }

  committed(): void {
    this.counts.clear();
    this.suppressed.clear();
  }
}
