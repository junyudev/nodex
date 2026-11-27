import { useIntl } from "@/lib/i18n";
import { InboxIcon } from "@/components/shared/icons";
import { LIBRARY_INBOX, type InboxScope } from "../../../shared/inbox";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { cn } from "@/lib/utils";
import {
  changeInboxDraft,
  EMPTY_INBOX_DRAFT,
  isEmptyInboxDraft,
  recoverInboxDraft,
  type InboxDraft,
} from "../inbox/inbox-capture-state";
import { InboxCaptureRecovery } from "../inbox/inbox-capture-recovery";
import { InboxComposer } from "../inbox/inbox-composer";
import { useInboxSummary } from "../inbox/use-inbox";
import { useSendInboxMessage } from "../inbox/use-inbox-actions";
import { useInboxCapture, useInboxCaptureState } from "../inbox/use-inbox-capture";
import { useInboxImageAccess } from "../inbox/use-inbox-image-access";
import { chooseMiniImages } from "./choose-mini-images";
import { MINI_SURFACE_CLASS } from "./mini-card";
import { MiniLocationMenu, useMiniLocation, type MiniProject } from "./mini-location-menu";
import type { MiniStart } from "./mini-model";

/** Mini's one form: its draft and its unsaved Inbox sends are kept under this name, per Profile. */
const MINI_FORM_ID = "mini-panel";
const NO_VISIBLE_PAGES: readonly string[] = [];

/**
 * The Inbox composer, made for starting work: `Enter` starts a chat where the chip says, on the
 * default Agent, and `Cmd/Ctrl+Enter` saves the message to that place's Inbox instead. The draft
 * outlives the panel being closed; a start waits in Mini's outbox until it goes through.
 */
export function MiniComposer({
  projects,
  focusToken,
  dictateToken,
  visible,
  onStart,
  onStarted,
  onSaved,
}: {
  /** Null until read. */
  readonly projects: readonly MiniProject[] | null;
  readonly focusToken: number;
  readonly dictateToken: number;
  readonly visible: boolean;
  /** Stores a chat to start; resolves once it is safe to clear the draft. */
  readonly onStart: (start: MiniStart) => Promise<void>;
  /** The draft is clear and the start is on its way. */
  readonly onStarted: () => void;
  readonly onSaved: (scope: InboxScope) => void;
}) {
  const intl = useIntl();
  const location = useMiniLocation(projects);
  const inbox: InboxScope = location.project
    ? { kind: "project", projectId: location.project.id }
    : LIBRARY_INBOX;
  const summary = useInboxSummary(inbox);
  const send = useSendInboxMessage();
  const routed = useInboxImageAccess(inbox.kind === "project" ? inbox : { kind: "library" });
  const images = routed ? { ...routed, chooseImages: chooseMiniImages } : null;
  const capture = useInboxCapture({
    windowSessionId: MINI_FORM_ID,
    scope: LIBRARY_INBOX,
    destination: inbox,
    storeEpoch: summary.data?.storeEpoch ?? null,
    visiblePageIds: NO_VISIBLE_PAGES,
    onSend: send,
  });

  const startChat = async () => {
    const draft = capture.draft;
    if (isEmptyInboxDraft(draft) || !location.resolved) return;
    // Stored before the draft is cleared, so the message is never only in flight.
    await onStart({
      sessionId: createUuidV7(),
      launchId: createUuidV7(),
      messageId: createUuidV7(),
      projectId: location.project?.id ?? null,
      project: location.project?.name ?? null,
      draft,
      startedAt: Date.now(),
      status: "sending",
      sentAt: null,
      error: null,
    });
    capture.changeDraft(() => EMPTY_INBOX_DRAFT);
    onStarted();
  };
  const failure =
    capture.validationError ??
    (capture.error
      ? intl.formatMessage({
          id: "mini.composer.draftNotSaved",
          defaultMessage: "Draft could not be saved. Your text is still here.",
        })
      : null);

  return (
    <>
      <InboxComposer
        draft={capture.draft}
        onDraftChange={capture.changeDraft}
        images={images}
        disabled={!capture.ready || capture.savingDraft || !location.resolved}
        readOnly={!capture.canEdit || capture.savingDraft}
        focusToken={focusToken}
        dictateToken={dictateToken}
        visible={visible}
        placeholder={intl.formatMessage({
          id: "mini.composer.placeholder",
          defaultMessage: "Ask Nodex to do something…",
        })}
        fieldLabel={intl.formatMessage({ id: "mini.composer.message", defaultMessage: "New chat" })}
        sendLabel={intl.formatMessage({ id: "mini.composer.start", defaultMessage: "Start chat" })}
        onSend={startChat}
        alternate={{
          label: intl.formatMessage({ id: "mini.composer.save", defaultMessage: "Save to Inbox" }),
          icon: InboxIcon,
          run: async () => {
            const result = await capture.submit();
            // A save that did not go through waits below, under its reason, with Mini open.
            if (result.outcome === "sent") onSaved(inbox);
          },
        }}
        leadingAccessory={
          <MiniLocationMenu
            project={location.project}
            resolved={location.resolved}
            projects={projects ?? []}
            onChange={location.choose}
          />
        }
      />
      {failure || capture.pending.length > 0 ? (
        <div
          data-mini-drawn
          className={cn("mt-2 rounded-[18px] px-2 pt-2 pb-0.5", MINI_SURFACE_CLASS)}
        >
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
    </>
  );
}

/** Puts a draft back into Mini's composer, after what is already there. */
export function useRestoreMiniDraft() {
  const { write } = useInboxCaptureState(MINI_FORM_ID, LIBRARY_INBOX);
  return (draft: InboxDraft) =>
    write((current) => changeInboxDraft(current, (mine) => recoverInboxDraft(mine, draft)));
}
