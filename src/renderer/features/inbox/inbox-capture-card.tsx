import { FormattedMessage, getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { InboxIcon, NewChatIcon } from "@/components/shared/icons";
import { ProjectMarker } from "@/components/workbench/project-marker";
import { cn } from "@/lib/utils";
import type { InboxScope, InboxStartRequest } from "../../../shared/inbox";
import type { ProjectAppearance } from "../../../shared/project-appearance";
import { InboxCaptureRecovery } from "./inbox-capture-recovery";
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

/** A capture once it is saved, so its host can confirm where it went. */
export interface InboxCaptureSent {
  readonly destination: InboxCaptureDestination;
  readonly pageId: string;
  readonly start: InboxStartRequest | null;
}

const NO_VISIBLE_PAGES: readonly string[] = [];

/** The capture's own labels share the composer's material, so they read over any surface. */
export const CAPTURE_CHIP_CLASS =
  "flex items-center gap-1.5 rounded-full bg-token-input-background px-2.5 py-1 text-xs text-token-text-secondary electron:elevation-prominent extension:border extension:border-token-border";

export function inboxDestinationLabel(
  destination: InboxCaptureDestination,
  intl: IntlShape = getIntl(),
): string {
  return destination.project
    ? intl.formatMessage(
        { id: "inbox.inboxQuickCapture.valueInbox", defaultMessage: "{value1} Inbox" },
        { value1: destination.project.name },
      )
    : intl.formatMessage({ id: "inbox.inboxQuickCapture.inbox", defaultMessage: "Inbox" });
}

/**
 * A capture starts where its sender chose: a chosen Project's work starts there at once, and
 * Library work goes where Nodex decides.
 */
export const captureStartRequest = (scope: InboxScope): InboxStartRequest =>
  scope.kind === "project" ? { kind: "new_chat" } : { kind: "routed" };

/** What starting does from an Inbox, named after its Project when it has one. */
export function captureStartLabel(projectName: string | null, intl: IntlShape = getIntl()): string {
  return projectName !== null
    ? intl.formatMessage(
        { id: "inbox.inboxCaptureCard.startIn", defaultMessage: "Start a chat in {project}" },
        { project: projectName },
      )
    : intl.formatMessage({
        id: "inbox.inboxCaptureCard.startRouted",
        defaultMessage: "Start now — Nodex picks where",
      });
}

/** The chip naming where a capture lands, when its sender cannot change it. */
export function InboxCaptureDestinationChip({
  destination,
}: {
  readonly destination: InboxCaptureDestination;
}) {
  const intl = useIntl();
  return (
    <span className={cn(CAPTURE_CHIP_CLASS, "min-w-0")}>
      <InboxCaptureDestinationGlyph destination={destination} />
      <span className="truncate">{inboxDestinationLabel(destination, intl)}</span>
    </span>
  );
}

export function InboxCaptureDestinationGlyph({
  destination,
}: {
  readonly destination: InboxCaptureDestination;
}) {
  return destination.project ? (
    <ProjectMarker appearance={destination.project.appearance} className="size-3.5" />
  ) : (
    <InboxIcon className="icon-xs" />
  );
}

/**
 * One message written to an Inbox from wherever its sender is: the chip naming where it lands,
 * `Add title`, and that Inbox's composer, saved and sent the way the Inbox sends. `Enter` sends;
 * `Cmd/Ctrl+Enter` sends with a request to start the work now. Its host frames it, as a dialog
 * over a Nodex window or as the Capture panel over any app.
 */
export function InboxCaptureCard({
  destination,
  destinationControl,
  formScope,
  windowSessionId,
  seed = null,
  focusToken,
  chooseImages,
  visible = true,
  onSent,
}: {
  readonly destination: InboxCaptureDestination;
  /** Replaces the destination chip where the sender may choose the Inbox. */
  readonly destinationControl?: ReactNode;
  /** The Inbox whose form this is, when the sender can send it elsewhere. */
  readonly formScope?: InboxScope;
  readonly windowSessionId: string;
  /** Text selected where the capture began, added to the message. */
  readonly seed?: string | null;
  readonly focusToken: number;
  /** The host's own image picker; see `MessageImageAccess.chooseImages`. */
  readonly chooseImages?: () => Promise<readonly File[]>;
  /** False while its host keeps it mounted out of sight; see `InboxComposer`. */
  readonly visible?: boolean;
  readonly onSent: (sent: InboxCaptureSent) => void;
}) {
  const intl = useIntl();
  const summary = useInboxSummary(destination.scope);
  const send = useSendInboxMessage();
  const routedImages = useInboxImageAccess(
    destination.scope.kind === "project" ? destination.scope : { kind: "library" },
  );
  const images = routedImages && chooseImages ? { ...routedImages, chooseImages } : routedImages;
  const capture = useInboxCapture({
    windowSessionId,
    scope: formScope ?? destination.scope,
    destination: destination.scope,
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
  const [titleOpen, setTitleOpen] = useState(false);
  const titleShowing = titleOpen || capture.draft.title !== "";
  const failure =
    capture.validationError ??
    (capture.error
      ? intl.formatMessage({
          id: "inbox.inboxQuickCapture.draftCouldNotBeSaved",
          defaultMessage: "Draft could not be saved. Your text is still here.",
        })
      : null);

  const submit = async (start: InboxStartRequest | undefined) => {
    const result = await capture.submit(start ? { start } : undefined);
    if (result.outcome === "sent" && result.pageId)
      onSent({ destination, pageId: result.pageId, start: result.start });
  };

  return (
    <div data-testid="inbox-capture-card">
      <div data-testid="inbox-quick-capture" className="mb-2 flex items-center gap-2 px-2">
        {destinationControl ?? <InboxCaptureDestinationChip destination={destination} />}
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
            <FormattedMessage id="inbox.inboxQuickCapture.addTitle" defaultMessage="Add title" />
          </button>
        )}
      </div>
      <InboxComposer
        draft={capture.draft}
        onDraftChange={capture.changeDraft}
        images={images}
        disabled={!capture.ready || capture.savingDraft}
        readOnly={!capture.canEdit || capture.savingDraft}
        focusToken={focusToken}
        titleOpen={titleOpen}
        onTitleOpenChange={setTitleOpen}
        placeholder={
          destination.project
            ? intl.formatMessage(
                {
                  id: "inbox.inboxQuickCapture.addAThoughtToValue",
                  defaultMessage: "Add a thought to {value1}…",
                },
                { value1: destination.project.name },
              )
            : undefined
        }
        onSend={() => submit(undefined)}
        alternate={{
          label: captureStartLabel(destination.project?.name ?? null, intl),
          icon: NewChatIcon,
          run: () => submit(captureStartRequest(destination.scope)),
        }}
        visible={visible}
      />
      {/* A message that could not be saved waits here, under its reason, to be retried. */}
      {failure || capture.pending.length > 0 ? (
        <div className="mt-2 rounded-2xl bg-token-input-background px-2 pt-2 pb-0.5 electron:elevation-prominent extension:border extension:border-token-border">
          {failure ? (
            <p role="alert" className="mb-2 px-2 text-xs text-token-error-foreground">
              {failure}
            </p>
          ) : null}
          <InboxCaptureRecovery
            captures={capture.pending}
            storeEpoch={summary.data?.storeEpoch ?? null}
            ready={capture.ready}
            onRetry={capture.retry}
            onRecover={capture.recover}
          />
        </div>
      ) : null}
    </div>
  );
}
