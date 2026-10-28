import { loadPageDocumentMaterialization } from "@/lib/page-prompt-context";
import { toast } from "@/components/ui/toast";
import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import type {
  InboxChatAgent,
  InboxItem,
  InboxProposal,
  InboxPageBasis,
} from "../../../shared/inbox";
import type { Project } from "../../../shared/types";
import {
  ActivitySpinnerIcon,
  ArchiveIcon,
  CheckmarkIcon,
  CompactChevronDownIcon,
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
import { MessageText } from "@/components/message/message-document";
import { inboxDraftFromBody, type InboxDraft } from "./inbox-capture-state";
import { InboxMessageEditor } from "./inbox-message-editor";
import { INBOX_EASE_OUT } from "./inbox-stream-item";
import { InboxOutcomeLine } from "./inbox-outcome";
import {
  describeInboxAction,
  inboxPageRoutingContext,
  inboxRowOffers,
  inboxTriageModel,
  isChatAction,
  type InboxOutcome,
  type InboxRowOffers,
} from "./inbox-presentation";
import { useInboxOutcome } from "./use-inbox-outcome";
import {
  InboxDispatchEditor,
  draftForInboxItem,
  type InboxDispatchDraft,
} from "./inbox-dispatch-editor";
import type { InboxActions } from "./use-inbox-actions";
import { InboxAgentLabel, InboxAgentPicker, type InboxAgents } from "./inbox-agent-picker";
import { InboxChatPlan } from "./inbox-chat-plan";
import {
  describeInboxAgent,
  sameInboxChatAgent,
  type InboxAgentPresentation,
} from "./inbox-agent-model";

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
  menu = null,
  onClick,
}: {
  readonly label: string;
  /** Canonical destination; the user can check it before deciding. */
  readonly target: string | null;
  /** What the suggestion does and why, a hover away. */
  readonly why?: ReactNode;
  readonly icon: InboxIcon;
  readonly variant?: "primary" | "ghost";
  /** The other half of a split decision, which changes how it runs rather than running it. */
  readonly menu?: ReactNode;
  readonly onClick: () => void;
}) {
  const button = (
    <NodexButton
      size="xs"
      variant={variant}
      className={cn("min-w-0 gap-1.5", menu && "rounded-e-none")}
      onClick={onClick}
    >
      <Icon className="icon-xs shrink-0" />
      <span className="truncate">{target ?? label}</span>
    </NodexButton>
  );
  const decision = target ? (
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
  return menu ? (
    <div className="flex min-w-0 items-center gap-px">
      {decision}
      {menu}
    </div>
  ) : (
    decision
  );
}

/**
 * The summary of a chat suggestion and why it was made. A new chat also says what it runs on,
 * kept apart from the Agent that wrote the suggestion.
 */
function SuggestionWhy({
  proposal,
  runsOn,
}: {
  readonly proposal: InboxProposal;
  readonly runsOn: InboxAgentPresentation | null;
}) {
  return (
    <>
      {isChatAction(proposal.action) ? <span>{proposal.summary}</span> : null}
      {proposal.rationale ? (
        <span className="text-token-description-foreground">{proposal.rationale}</span>
      ) : null}
      {runsOn ? (
        <span className="flex min-w-0 items-start gap-1 pt-1">
          <span className="shrink-0">Runs on</span>
          <InboxAgentLabel presentation={runsOn} full className="items-start [&>svg]:mt-0.5" />
        </span>
      ) : null}
      {proposal.producedBy ? (
        <span className="text-token-description-foreground">
          Suggested by {proposal.producedBy}
        </span>
      ) : null}
    </>
  );
}

/**
 * A new chat's menu half: opens the model menu for this message alone. A choice that differs
 * from the Inbox's own stays visible on the button, so the decision never hides it.
 */
function ChatAgentMenu({
  agents,
  value,
  changed,
  onChange,
}: {
  readonly agents: InboxAgents;
  readonly value: InboxChatAgent;
  readonly changed: boolean;
  readonly onChange: (next: InboxChatAgent) => void;
}) {
  return (
    <InboxAgentPicker
      agents={agents}
      purpose="chat"
      scope="message"
      value={value}
      onChange={onChange}
      trigger={
        <NodexButton
          size="xs"
          variant="primary"
          aria-label="Choose the model for this chat"
          className="min-w-0 gap-1 rounded-s-none px-1.5"
        >
          {changed ? (
            <InboxAgentLabel
              presentation={describeInboxAgent(agents, value)}
              className="max-w-44 gap-1"
            />
          ) : null}
          <CompactChevronDownIcon className="icon-2xs shrink-0" />
        </NodexButton>
      }
    />
  );
}

/**
 * A chat suggestion is the prompt it will send, read like the message above it; where it goes
 * is on the decision. Other suggestions say what they do in one line.
 */
function SuggestionStrip({
  proposal,
  agents,
}: {
  readonly proposal: InboxProposal;
  readonly agents: InboxAgents;
}) {
  const action = proposal.action;
  return (
    <div
      data-testid="inbox-suggestion"
      className="flex min-w-0 flex-col gap-2 text-token-foreground"
    >
      {isChatAction(action) ? (
        <MessageText text={action.prompt} />
      ) : (
        <p className="min-w-0 text-sm leading-snug">{proposal.summary}</p>
      )}
      {/* A planned chat shows how it will run before anything is sent. */}
      {action.type === "new_chat" ? (
        <InboxChatPlan agents={agents} delegates={action.delegates} plan={action.plan} />
      ) : null}
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
  agents,
  suggestionsEnabled,
  actions,
  manualDraft,
  groupedWithKey,
  menu,
  inboxProjectId,
  onManualDraftChange,
  children,
  members = NO_MEMBERS,
  onOpenPage,
  onOpenSession,
  awaitingIndicator = false,
  decided = null,
}: {
  readonly item: InboxItem;
  /**
   * Where this window just sent the message. The card shows it in place of everything else
   * until the message folds away, so a decision never makes a message simply vanish.
   */
  readonly decided?: InboxOutcome | null;
  /** Shows the spinner of the newest message still waiting for advice. */
  readonly awaitingIndicator?: boolean;
  readonly members?: readonly InboxGroupMember[];
  readonly onOpenPage?: (pageId: string) => void;
  readonly onOpenSession?: (sessionId: string) => void;
  readonly projects: readonly Project[];
  /** What a new chat can run on, and the Inbox's own choice. */
  readonly agents: InboxAgents;
  /** The Project whose Inbox holds the message, or null for the Library Inbox. */
  readonly inboxProjectId: string | null;
  readonly suggestionsEnabled: boolean;
  readonly actions: InboxActions;
  /** A hand-written dispatch opened from the message menu. */
  readonly manualDraft: InboxDispatchDraft | null;
  /** Set when this message's suggestion is shown on a newer message of the same group. */
  readonly groupedWithKey: string | null;
  /**
   * The message's menu, the first of the action row's icons; it leaves out what the row offers.
   * `handleManually` opens the dispatch editor from the decision as the row currently has it.
   */
  readonly menu: (offers: InboxRowOffers, handleManually: () => void) => ReactNode;
  readonly onManualDraftChange: (draft: InboxDispatchDraft | null) => void;
  /** Places the strip and the action row around the message. */
  readonly children: (parts: InboxTriageParts) => ReactNode;
}) {
  // A model chosen on the decision for one suggestion's new chat, in place of the one the
  // suggestion chose; null runs it on the Inbox's own. Another suggestion starts afresh.
  const [chatChoice, setChatChoice] = useState<{
    readonly proposalId: string;
    readonly agent: InboxChatAgent | null;
  } | null>(null);
  const suggested = item.proposal?.action.type === "new_chat" ? item.proposal.action : null;
  const choice = chatChoice?.proposalId === item.proposal?.proposalId ? chatChoice : null;
  // The suggestion's new chat as the row has it, once a model is chosen here.
  const rowAction = suggested && choice ? { ...suggested, agent: choice.agent } : null;
  const chatAgent = (rowAction ?? suggested)?.agent ?? agents.settings.chatAgent;
  const chooseAgent = (proposalId: string, agent: InboxChatAgent) =>
    setChatChoice({
      proposalId,
      agent: sameInboxChatAgent(agent, agents.settings.chatAgent) ? null : agent,
    });
  const [editing, setEditing] = useState<{
    readonly baseBody: string;
    readonly draft: InboxDraft;
    readonly basis: InboxPageBasis;
  } | null>(null);

  const model = inboxTriageModel(item, suggestionsEnabled);
  const offers = inboxRowOffers(model, { suggestionsEnabled, grouped: groupedWithKey != null });
  const handled = useInboxOutcome(item);
  const done = () => void actions.setState([item.pageId], "done");
  const keep = () => void actions.keep([item.pageId]);
  const handleManually = () =>
    onManualDraftChange(draftForInboxItem(item, inboxProjectId, rowAction));
  const menuNode = menu(offers, handleManually);
  const editAction = (
    <InboxIconAction
      label="Edit"
      icon={EditIcon}
      onClick={() => {
        void (async () => {
          const body = item.bodyTruncated
            ? (
                await loadPageDocumentMaterialization({
                  routingContext: inboxPageRoutingContext(item),
                  pageId: item.pageId,
                })
              ).markdown
            : item.body;
          setEditing({ baseBody: body, draft: inboxDraftFromBody(body), basis: item.basis });
        })().catch(() => toast.danger("Couldn’t load the message"));
      }}
    />
  );
  const keepAction = <InboxIconAction label="Keep" icon={ArchiveIcon} onClick={keep} />;
  const doneAction = offers.done ? (
    <InboxIconAction label="Mark done" icon={CheckmarkIcon} onClick={done} />
  ) : null;
  const copyAction = <InboxCopyAction item={item} />;
  const handleManuallyAction = offers.handleManually ? (
    <InboxIconAction label="Handle manually" icon={DispatchIcon} onClick={handleManually} />
  ) : null;
  const menuOnly = (
    <Row>
      <InboxIconActions>{menuNode}</InboxIconActions>
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

  const outcomeParts = (
    outcome: InboxOutcome,
  ): Omit<InboxTriageParts, "editor" | "messageActions"> => {
    const target = outcome.open;
    return {
      strip: (
        <Settle id="outcome">
          <InboxOutcomeLine outcome={outcome} />
        </Settle>
      ),
      actions:
        target?.kind === "session" && onOpenSession ? (
          <Row>
            <InboxIconActions>
              <InboxIconAction
                label="Open chat"
                icon={ThreadIcon}
                onClick={() => onOpenSession(target.sessionId)}
              />
            </InboxIconActions>
          </Row>
        ) : null,
    };
  };

  const parts = (): Omit<InboxTriageParts, "editor" | "messageActions"> => {
    if (decided) return outcomeParts(decided);
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
              agents={agents}
              inboxProjectId={inboxProjectId}
              onCancel={() => onManualDraftChange(null)}
              onSubmit={(action, chat) =>
                manualDraft.proposal
                  ? actions.confirm(manualDraft.proposal, action, chat)
                  : actions.dispatch(
                      (manualDraft.basis ?? [item.basis]).map((basis) => basis.pageId),
                      action,
                      manualDraft.basis ?? [item.basis],
                      chat,
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
        actions: menuOnly,
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
                {menuNode}
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
        const newChat = proposal.action.type === "new_chat";
        return {
          strip: (
            <Settle id={proposal.proposalId}>
              {groupMembers(proposal)}
              <SuggestionStrip proposal={proposal} agents={agents} />
            </Settle>
          ),
          actions: (
            <Row>
              <InboxIconActions>
                {menuNode}
                {proposal.action.type === "keep" ? null : keepAction}
                {doneAction}
              </InboxIconActions>
              <Decision
                label={presentation.verb}
                target={presentation.target}
                why={
                  <SuggestionWhy
                    proposal={proposal}
                    runsOn={newChat ? describeInboxAgent(agents, chatAgent) : null}
                  />
                }
                icon={INBOX_ACTION_ICONS[proposal.action.type]}
                menu={
                  newChat ? (
                    <ChatAgentMenu
                      agents={agents}
                      value={chatAgent}
                      changed={!sameInboxChatAgent(chatAgent, agents.settings.chatAgent)}
                      onChange={(next) => chooseAgent(proposal.proposalId, next)}
                    />
                  ) : null
                }
                onClick={() =>
                  void (rowAction
                    ? actions.confirm(proposal, rowAction)
                    : actions.confirm(proposal))
                }
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
                {menuNode}
                {offers.suggest ? (
                  <InboxIconAction
                    label="Retry"
                    icon={RetryIcon}
                    onClick={() => void actions.requestSuggestion([item.pageId], [item.basis])}
                  />
                ) : null}
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
                {menuNode}
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
                {model.proposal.failureKind !== "unknown" ? (
                  handleManuallyAction
                ) : offers.handleManually ? (
                  <InboxIconAction
                    label="Send again"
                    icon={DispatchIcon}
                    onClick={handleManually}
                  />
                ) : null}
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
                {menuNode}
                {offers.suggest ? (
                  <InboxIconAction
                    label="Suggest"
                    icon={AskAiIcon}
                    onClick={() => void actions.requestSuggestion([item.pageId], [item.basis])}
                  />
                ) : null}
                {keepAction}
                {doneAction}
              </InboxIconActions>
              {offers.handleManually ? (
                <Decision
                  label="Handle manually"
                  target={null}
                  icon={DispatchIcon}
                  variant="ghost"
                  onClick={handleManually}
                />
              ) : null}
            </Row>
          ),
        };
      case "handled":
        return outcomeParts(handled);
    }
  };

  // While the message is being rewritten, what Nodex made of the old text steps aside.
  if (editing) {
    return children({
      editor: (
        <InboxMessageEditor
          body={editing.baseBody}
          draft={editing.draft}
          currentBody={item.body}
          routing={inboxPageRoutingContext(item)}
          onCancel={() => setEditing(null)}
          onSave={async (body) => {
            const saved = await actions.edit(item.pageId, editing.baseBody, body, editing.basis);
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
  const editable =
    !manualDraft && !decided && model.kind !== "handled" && model.kind !== "dispatch-failed";
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
