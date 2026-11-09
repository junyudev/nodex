import { useLayoutEffect, useRef, useState } from "react";
import { InboxIcon } from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { ProjectMarker } from "@/components/workbench/project-marker";
import { cn } from "@/lib/utils";
import type { InboxScope } from "../../../shared/inbox";
import type { ProjectAppearance } from "../../../shared/project-appearance";
import { InboxComposer } from "./inbox-composer";
import { useInboxSummary } from "./use-inbox";
import { useSendInboxMessage } from "./use-inbox-actions";
import { useInboxCapture } from "./use-inbox-capture";
import { useInboxImageAccess } from "./use-inbox-image-access";

/** The Inbox a capture lands in, as the capture names it. */
export interface InboxCaptureDestination {
  readonly scope: InboxScope;
  /** The Project's name and marker, or null for the Library Inbox. */
  readonly project: { readonly name: string; readonly appearance: ProjectAppearance } | null;
}

export interface InboxQuickCaptureRequest {
  readonly destination: InboxCaptureDestination;
  /** Text selected where the capture began, added to the message. */
  readonly seed: string | null;
}

const NO_VISIBLE_PAGES: readonly string[] = [];
/** The capture's own labels share the composer's material, so they read over any page. */
const CAPTURE_CHIP_CLASS =
  "flex items-center gap-1.5 rounded-full bg-token-input-background px-2.5 py-1 text-xs text-token-text-secondary electron:elevation-prominent extension:border extension:border-token-border";

export function inboxDestinationLabel(destination: InboxCaptureDestination): string {
  return destination.project ? `${destination.project.name} Inbox` : "Inbox";
}

/**
 * Writes one message to an Inbox from wherever the user is, without leaving it. It is that
 * Inbox's own composer: the same draft, images and title, saved and sent the same way.
 */
export function InboxQuickCapture({
  request,
  windowSessionId,
  onClose,
  onOpenInbox,
}: {
  readonly request: InboxQuickCaptureRequest;
  readonly windowSessionId: string;
  readonly onClose: () => void;
  readonly onOpenInbox: (scope: InboxScope) => void;
}) {
  const { destination, seed } = request;
  const summary = useInboxSummary(destination.scope);
  const send = useSendInboxMessage();
  const images = useInboxImageAccess(destination.scope);
  const capture = useInboxCapture({
    windowSessionId,
    scope: destination.scope,
    storeEpoch: summary.data?.storeEpoch ?? null,
    visiblePageIds: NO_VISIBLE_PAGES,
    onSend: send,
  });
  const seeded = useRef(false);
  useLayoutEffect(() => {
    if (seeded.current || !seed || !capture.canEdit) return;
    seeded.current = true;
    capture.changeDraft((draft) => ({
      ...draft,
      text: draft.text.trim() ? `${draft.text.trimEnd()}\n\n${seed}` : seed,
    }));
  }, [capture, seed]);

  // A message that could not be saved waits in its Inbox, where it can be retried or recovered.
  const [deliveryFailed, setDeliveryFailed] = useState(false);
  const [titleOpen, setTitleOpen] = useState(false);
  const titleShowing = titleOpen || capture.draft.title !== "";
  const label = inboxDestinationLabel(destination);
  const failure =
    capture.validationError ??
    (capture.error ? "Draft could not be saved. Your text is still here." : null);

  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent
        unstyledContent
        showCloseButton={false}
        overlayClassName="bg-black/[0.1333]"
        initialFocus={false}
        finalFocus={false}
        className="top-[max(16px,18vh)] w-[min(640px,92vw)] translate-y-0 bg-transparent p-0"
      >
        <NodexDialogTitle className="sr-only">Capture to {label}</NodexDialogTitle>
        <NodexDialogDescription className="sr-only">
          Write a message to {label}. Nodex names it unless you add a title.
        </NodexDialogDescription>
        <div data-testid="inbox-quick-capture" className="mb-2 flex items-center gap-2 px-2">
          <span className={cn(CAPTURE_CHIP_CLASS, "min-w-0")}>
            {destination.project ? (
              <ProjectMarker appearance={destination.project.appearance} className="size-3.5" />
            ) : (
              <InboxIcon className="icon-xs" />
            )}
            <span className="truncate">{label}</span>
          </span>
          {titleShowing || !capture.canEdit ? null : (
            <button
              type="button"
              className={cn(
                CAPTURE_CHIP_CLASS,
                "cursor-interaction ml-auto shrink-0 hover:text-token-text-primary focus-visible:outline-2 focus-visible:outline-token-focus-border",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setTitleOpen(true)}
            >
              Add title
            </button>
          )}
        </div>
        <InboxComposer
          draft={capture.draft}
          onDraftChange={capture.changeDraft}
          images={images}
          disabled={!capture.ready || capture.savingDraft}
          readOnly={!capture.canEdit || capture.savingDraft}
          focusToken={0}
          titleOpen={titleOpen}
          onTitleOpenChange={setTitleOpen}
          placeholder={
            destination.project ? `Add a thought to ${destination.project.name}…` : undefined
          }
          onSend={async () => {
            const outcome = await capture.submit();
            setDeliveryFailed(outcome === "failed");
            if (outcome !== "sent") return;
            onClose();
            toast.success(`Sent to ${label}`, {
              id: "inbox-quick-capture-sent",
              action: { label: "Open", onClick: () => onOpenInbox(destination.scope) },
            });
          }}
        />
        {failure || deliveryFailed ? (
          <p role="alert" className="flex items-center gap-1 px-4 pt-2 text-xs">
            <span className="text-token-error-foreground">
              {failure ?? `Couldn’t save this message. It’s waiting in ${label} to retry.`}
            </span>
            {failure ? null : (
              <button
                type="button"
                className="cursor-interaction text-token-text-primary underline-offset-2 hover:underline"
                onClick={() => {
                  onClose();
                  onOpenInbox(destination.scope);
                }}
              >
                Open
              </button>
            )}
          </p>
        ) : null}
      </NodexDialogContent>
    </NodexDialog>
  );
}
