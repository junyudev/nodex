import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import type { InboxItem, InboxProposal, InboxPageBasis } from "../../../shared/inbox";
import type { Project } from "../../../shared/types";
import {
  ActivitySpinnerIcon,
  ArchiveIcon,
  CheckmarkIcon,
  DispatchIcon,
  EditIcon,
  RetryIcon,
  ThreadIcon,
  AskAiIcon,
} from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  INBOX_ACTION_ICONS,
  InboxIconAction,
  InboxIconActions,
  type InboxIcon,
} from "./inbox-icon-action";
import { InboxCopyAction } from "./inbox-copy-action";
import { InboxGroupMembers, type InboxGroupMember } from "./inbox-group-members";
import { UserMessageText } from "@/features/local-conversation/view/shared/user-message-collapse";
import { InboxMessageEditor } from "./inbox-message-editor";
import { INBOX_EASE_OUT } from "./inbox-stream-item";
import { InboxOutcomeLine } from "./inbox-outcome";
import {
  describeInboxAction,
  describeInboxOutcome,
  inboxTriageModel,
  isChatAction,
} from "./inbox-presentation";
import {
  InboxDispatchEditor,
  draftForInboxItem,
  type InboxDispatchDraft,
} from "./inbox-dispatch-editor";
import type { InboxActions } from "./use-inbox-actions";

/** New strip content settles in place rather than popping. */
function Settle({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <motion.div
      key={id}
      initial={{ opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: INBOX_EASE_OUT }}
      className="flex flex-col gap-2"
    >
      {children}
    </motion.div>
  );
}

/** One line of the strip, or the action row beneath the card. */
function Row({ children }: { readonly children: ReactNode }) {
  return <div className="flex min-h-6 items-center gap-2">{children}</div>;
}

function Notice({
  tone,
  children,
}: {
  readonly tone: "error" | "quiet";
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2 text-[13px] leading-5 text-token-description-foreground">
      <span
        aria-hidden="true"
        className={cn(
          "mt-[7px] size-1.5 shrink-0 rounded-full",
          tone === "error" ? "bg-token-error-foreground" : "bg-token-description-foreground/50",
        )}
      />
      <span className="line-clamp-2 min-w-0">{children}</span>
    </div>
  );
}

/** The decision the row asks for, always at the trailing edge where it is easy to find. */
function Decision({
  label,
  target,
  why = null,
  icon: Icon,
  variant = "primary",
  onClick,
}: {
  readonly label: string;
  /** Canonical destination; the user can check it before deciding. */
  readonly target: string | null;
  /** What the suggestion does and why, a hover away. */
  readonly why?: ReactNode;
  readonly icon: InboxIcon;
  readonly variant?: "primary" | "ghost";
  readonly onClick: () => void;
}) {
  const button = (
    <NodexButton size="xs" variant={variant} className="min-w-0 gap-1.5" onClick={onClick}>
      <Icon className="icon-xs shrink-0" />
      <span className="truncate">{target ?? label}</span>
    </NodexButton>
  );
  return target ? (
    <NodexTooltip
      tooltipContent={
        <div className="flex max-w-80 flex-col gap-1">
          <span>{target}</span>
          {why}
        </div>
      }
      side="top"
    >
      {button}
    </NodexTooltip>
  ) : (
    button
  );
}

/** The summary of a chat suggestion, and for every suggestion why it was made and by whom. */
function SuggestionWhy({ proposal }: { readonly proposal: InboxProposal }) {
  const why = [proposal.rationale, proposal.producedBy].filter(Boolean).join(" — ");
  return (
    <>
      {isChatAction(proposal.action) ? <span>{proposal.summary}</span> : null}
      {why ? <span className="text-token-description-foreground">{why}</span> : null}
    </>
  );
}

/**
 * A chat suggestion is the prompt it will send, read like the message above it; where it goes
 * is on the decision. Other suggestions say what they do in one line.
 */
function SuggestionStrip({ proposal }: { readonly proposal: InboxProposal }) {
  const action = proposal.action;
  return (
    <div data-testid="inbox-suggestion" className="min-w-0 text-token-foreground">
      {isChatAction(action) ? (
        <UserMessageText text={action.prompt} />
      ) : (
        <p className="min-w-0 text-sm leading-snug">{proposal.summary}</p>
      )}
    </div>
  );
}

/** What a message's card holds beneath the message, and the row of ways to act under the card. */
export interface InboxTriageParts {
  /** Replaces the message's text while the user rewrites it; null otherwise. */
  readonly editor: ReactNode;
  /** Copy and Edit, which act on the text itself and sit on it; null while an editor is open. */
  readonly messageActions: ReactNode;
  /** What Nodex made of the message; null when there is nothing to say. */
  readonly strip: ReactNode;
  /** Icon actions and the menu, then the decision at the right; null while an editor is open. */
  readonly actions: ReactNode;
}

/**
 * What Nodex made of one message: a concrete suggestion, a generation failure, or a manual
 * dispatch before advice arrives. Only a button here can make anything run. `Edit` rewrites the message
 * itself; dispatching by hand lives in the message menu.
 */
const NO_MEMBERS: readonly InboxGroupMember[] = [];

export function InboxTriage({
  item,
  projects,
  suggestionsEnabled,
  actions,
  manualDraft,
  groupedWithKey,
  menu,
  inboxProjectId,
  onManualDraftChange,
  onEditAsPage,
  children,
  members = NO_MEMBERS,
  onOpenPage,
  onOpenSession,
  awaitingIndicator = false,
}: {
  readonly item: InboxItem;
  /** Shows the spinner of the newest message still waiting for advice. */
  readonly awaitingIndicator?: boolean;
  readonly members?: readonly InboxGroupMember[];
  readonly onOpenPage?: (pageId: string) => void;
  readonly onOpenSession?: (sessionId: string) => void;
  readonly projects: readonly Project[];
  /** The Project whose Inbox holds the message, or null for the Library Inbox. */
  readonly inboxProjectId: string | null;
  readonly suggestionsEnabled: boolean;
  readonly actions: InboxActions;
  /** A hand-written dispatch opened from the message menu. */
  readonly manualDraft: InboxDispatchDraft | null;
  /** Set when this message's suggestion is shown on a newer message of the same group. */
  readonly groupedWithKey: string | null;
  /** The message's menu, the first of the action row's icons. */
  readonly menu: ReactNode;
  readonly onManualDraftChange: (draft: InboxDispatchDraft | null) => void;
  /** Opens the message's Page, where a body too rich or long to rewrite in place is edited. */
  readonly onEditAsPage: () => void;
  /** Places the strip and the action row around the message. */
  readonly children: (parts: InboxTriageParts) => ReactNode;
}) {
  const [editing, setEditing] = useState<{
    readonly baseText: string;
    readonly basis: InboxPageBasis;
  } | null>(null);
  const model = inboxTriageModel(item, suggestionsEnabled);
  const done = () => void actions.setState([item.pageId], "done");
  const keep = () => void actions.keep([item.pageId]);
  const handleManually = () => onManualDraftChange(draftForInboxItem(item, inboxProjectId));
  const editAction = item.bodyEditable ? (
    <InboxIconAction
      label="Edit"
      icon={EditIcon}
      onClick={() => setEditing({ baseText: item.body, basis: item.basis })}
    />
  ) : (
    <InboxIconAction label="Edit as Page" icon={EditIcon} onClick={onEditAsPage} />
  );
  const keepAction = <InboxIconAction label="Keep" icon={ArchiveIcon} onClick={keep} />;
  const doneAction = <InboxIconAction label="Mark done" icon={CheckmarkIcon} onClick={done} />;
  const copyAction = <InboxCopyAction item={item} />;
  const handleManuallyAction = (
    <InboxIconAction label="Handle manually" icon={DispatchIcon} onClick={handleManually} />
  );
  const menuOnly = (
    <Row>
      <InboxIconActions>{menu}</InboxIconActions>
    </Row>
  );

  const groupMembers = (proposal: InboxProposal) => (
    <InboxGroupMembers
      pageIds={proposal.pageIds}
      members={members}
      onOpenPage={onOpenPage}
      onRemove={(pageId) => {
        void actions.requestSuggestion(
          proposal.pageIds.filter((id) => id !== pageId),
          proposal.basis.filter((basis) => basis.pageId !== pageId),
          {
            proposal,
            correction:
              "Revise the suggestion for only the remaining supplied messages. Do not include work from the removed message.",
          },
        );
      }}
    />
  );

  const parts = (): Omit<InboxTriageParts, "editor" | "messageActions"> => {
    if (manualDraft) {
      return {
        strip: (
          <div className="flex flex-col gap-2">
            <InboxGroupMembers
              pageIds={(manualDraft.basis ?? manualDraft.proposal?.basis ?? [item.basis]).map(
                (basis) => basis.pageId,
              )}
              members={members}
              onOpenPage={onOpenPage}
            />
            <InboxDispatchEditor
              embedded
              initial={manualDraft}
              projects={projects}
              inboxProjectId={inboxProjectId}
              onCancel={() => onManualDraftChange(null)}
              onSubmit={(action) =>
                manualDraft.proposal
                  ? actions.confirm(manualDraft.proposal, action)
                  : actions.dispatch(
                      (manualDraft.basis ?? [item.basis]).map((basis) => basis.pageId),
                      action,
                      manualDraft.basis ?? [item.basis],
                    )
              }
            />
          </div>
        ),
        actions: null,
      };
    }

    if (groupedWithKey && model.kind === "suggestion") {
      return {
        strip: (
          <span className="text-xs text-token-description-foreground">
            Suggested together with {groupedWithKey} below
          </span>
        ),
        actions: (
          <Row>
            <InboxIconActions>{menu}</InboxIconActions>
          </Row>
        ),
      };
    }

    switch (model.kind) {
      case "suggesting":
        return {
          // Until advice arrives the card is the message alone; it can still be handled by hand
          // without waiting. The spinner holds the place where the decision then appears.
          strip: null,
          actions: (
            <Row>
              <InboxIconActions>
                {menu}
                {doneAction}
                {handleManuallyAction}
              </InboxIconActions>
              {awaitingIndicator ? (
                // Ends where the card's corner curve meets its bottom edge, not at the
                // outer edge the curve has already left.
                <span
                  role="status"
                  aria-label="Finding where this goes"
                  className="mr-(--inbox-card-radius) flex text-token-description-foreground"
                >
                  <ActivitySpinnerIcon className="icon-xs" />
                </span>
              ) : null}
            </Row>
          ),
        };
      case "suggestion": {
        const proposal = model.proposal;
        const presentation = describeInboxAction(proposal.action, {
          targetProjectName: proposal.targetProjectName,
          chat: proposal.chat,
        });
        return {
          strip: (
            <Settle id={proposal.proposalId}>
              {groupMembers(proposal)}
              <SuggestionStrip proposal={proposal} />
            </Settle>
          ),
          actions: (
            <Row>
              <InboxIconActions>
                {menu}
                {proposal.action.type === "keep" ? null : keepAction}
                {doneAction}
              </InboxIconActions>
              <Decision
                label={presentation.verb}
                target={presentation.target}
                why={<SuggestionWhy proposal={proposal} />}
                icon={INBOX_ACTION_ICONS[proposal.action.type]}
                onClick={() => void actions.confirm(proposal)}
              />
            </Row>
          ),
        };
      }
      case "suggestion-failed":
        return {
          strip: (
            <Settle id="suggestion-failed">
              <Notice tone="error">Couldn’t suggest — {model.message}</Notice>
            </Settle>
          ),
          actions: (
            <Row>
              <InboxIconActions>
                {menu}
                <InboxIconAction
                  label="Retry"
                  icon={RetryIcon}
                  onClick={() => void actions.requestSuggestion([item.pageId], [item.basis])}
                />
                {keepAction}
                {doneAction}
                {handleManuallyAction}
              </InboxIconActions>
            </Row>
          ),
        };
      case "dispatch-failed":
        return {
          strip: (
            <Settle id="dispatch-failed">
              <Notice tone="error">
                {model.proposal.failureKind === "unknown"
                  ? "Delivery not confirmed"
                  : "Couldn’t deliver"}{" "}
                — {model.message}
              </Notice>
            </Settle>
          ),
          actions: (
            <Row>
              <InboxIconActions>
                {menu}
                {model.proposal.failureKind === "unknown" ? (
                  model.proposal.chat && onOpenSession ? (
                    <InboxIconAction
                      label="Open chat"
                      icon={ThreadIcon}
                      onClick={() => onOpenSession(model.proposal.chat!.sessionId)}
                    />
                  ) : null
                ) : model.proposal.failureKind === "rejected" ? null : (
                  <InboxIconAction
                    label="Retry"
                    icon={RetryIcon}
                    onClick={() => void actions.retryDispatch(model.proposal.proposalId)}
                  />
                )}
                {keepAction}
                {doneAction}
                {model.proposal.failureKind === "unknown" ? (
                  <InboxIconAction
                    label="Send again"
                    icon={DispatchIcon}
                    onClick={handleManually}
                  />
                ) : (
                  handleManuallyAction
                )}
              </InboxIconActions>
            </Row>
          ),
        };
      case "undecided":
        return {
          // With nothing suggested, the card is the message alone.
          strip: null,
          actions: (
            <Row>
              <InboxIconActions>
                {menu}
                {suggestionsEnabled ? (
                  <InboxIconAction
                    label="Suggest"
                    icon={AskAiIcon}
                    onClick={() => void actions.requestSuggestion([item.pageId], [item.basis])}
                  />
                ) : null}
                {keepAction}
                {doneAction}
              </InboxIconActions>
              <Decision
                label="Handle manually"
                target={null}
                icon={DispatchIcon}
                variant="ghost"
                onClick={handleManually}
              />
            </Row>
          ),
        };
      case "handled":
        return {
          strip: <InboxOutcomeLine outcome={describeInboxOutcome(item)} />,
          actions: menuOnly,
        };
    }
  };

  // While the message is being rewritten, what Nodex made of the old text steps aside.
  if (editing) {
    return children({
      editor: (
        <InboxMessageEditor
          text={editing.baseText}
          currentText={item.body}
          onCancel={() => setEditing(null)}
          onSave={async (text) => {
            const saved = await actions.edit(item.pageId, editing.baseText, text, editing.basis);
            if (saved) setEditing(null);
            return saved;
          }}
        />
      ),
      messageActions: null,
      strip: null,
      actions: null,
    });
  }
  // A delivered or failed delivery's text is settled, and a dispatch editor is already open.
  const editable = !manualDraft && model.kind !== "handled" && model.kind !== "dispatch-failed";
  return children({
    editor: null,
    messageActions: (
      <>
        {copyAction}
        {editable ? editAction : null}
      </>
    ),
    ...parts(),
  });
}
