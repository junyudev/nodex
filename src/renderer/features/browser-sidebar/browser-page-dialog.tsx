import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { BrowserPageDialog } from "../../../shared/browser/browser-page-dialogs";
import type { BrowserSidebarTabIdentity } from "../../../shared/browser-sidebar";
import { NodexButton } from "@/components/ui/button";
import { BrowserPageOverlay } from "./browser-page-overlay";
import { readPermissionSiteLabel } from "./browser-permission-prompt";

export interface BrowserPageDialogAnswer {
  readonly accept: boolean;
  /** Stop the page from opening more dialogs. */
  readonly suppress: boolean;
}

export interface BrowserPageDialogOverlayProps {
  readonly identity: BrowserSidebarTabIdentity;
  readonly dialog: BrowserPageDialog | null;
  readonly onRespond: (
    dialog: BrowserPageDialog,
    answer: BrowserPageDialogAnswer,
  ) => Promise<boolean>;
}

/**
 * The dialog a page is waiting on, drawn over that page alone. The page is stopped until it is
 * answered, so the overlay takes the page's pointer input and leaves the rest of the app usable.
 */
export function BrowserPageDialogOverlay({
  identity,
  dialog,
  onRespond,
}: BrowserPageDialogOverlayProps) {
  if (!dialog) return null;
  return (
    <BrowserPageOverlay identity={identity}>
      <BrowserPageDialogCard key={dialog.id} dialog={dialog} onRespond={onRespond} />
    </BrowserPageOverlay>
  );
}

/** Keyboard focus belongs to the page, or to nothing, rather than to work elsewhere in the app. */
function focusIsFreeForPage(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active.localName === "webview";
}

export function BrowserPageDialogCard({
  dialog,
  onRespond,
}: {
  readonly dialog: BrowserPageDialog;
  readonly onRespond: BrowserPageDialogOverlayProps["onRespond"];
}) {
  const headingId = useId();
  const messageId = useId();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const [suppress, setSuppress] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const site = readPermissionSiteLabel(dialog.origin);

  useEffect(() => {
    // A page's dialog takes the keyboard from its own page, never from a chat being typed in.
    if (focusIsFreeForPage()) confirmRef.current?.focus({ preventScroll: true });
  }, []);

  const respond = async (accept: boolean) => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    const sent = await onRespond(dialog, { accept, suppress }).catch(() => false);
    // A sent answer removes the dialog from the tab; only a failure leaves this mounted.
    setPending(false);
    if (!sent) setFailed(true);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void respond(true);
  };
  const dismissOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    void respond(false);
  };

  return (
    <div className="pointer-events-auto absolute inset-0 flex items-start justify-center bg-[#00000022] px-4 pt-6">
      <form
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={dialog.message ? messageId : undefined}
        className="flex max-h-full w-full max-w-sm flex-col gap-3 rounded-xl bg-token-dropdown-background p-3 shadow-xl-spread ring-[0.5px] ring-token-border"
        onSubmit={submit}
        onKeyDown={dismissOnEscape}
      >
        <div className="flex flex-col gap-0.5">
          <p
            id={headingId}
            className="break-all text-sm font-medium text-token-text-primary select-text"
          >
            {site} says
          </p>
          {dialog.embeddingOrigin ? (
            <p className="break-all text-xs text-token-text-tertiary">
              Embedded in {readPermissionSiteLabel(dialog.embeddingOrigin)}
            </p>
          ) : null}
        </div>
        {dialog.message ? (
          <p
            id={messageId}
            className="min-h-0 overflow-y-auto text-sm break-words whitespace-pre-wrap text-token-text-secondary select-text"
          >
            {dialog.message}
          </p>
        ) : null}
        {dialog.canSuppress ? (
          <label className="flex cursor-interaction items-center gap-2 text-sm text-token-text-secondary">
            <input
              type="checkbox"
              className="size-4 accent-current"
              checked={suppress}
              disabled={pending}
              onChange={(event) => setSuppress(event.target.checked)}
            />
            Don’t let this page open more dialogs
          </label>
        ) : null}
        {failed ? (
          <p role="alert" className="text-sm text-token-charts-red">
            Couldn’t send your answer. Try again
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          {dialog.kind === "confirm" ? (
            <NodexButton
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => void respond(false)}
            >
              Cancel
            </NodexButton>
          ) : null}
          <NodexButton ref={confirmRef} type="submit" size="sm" disabled={pending}>
            OK
          </NodexButton>
        </div>
      </form>
    </div>
  );
}
