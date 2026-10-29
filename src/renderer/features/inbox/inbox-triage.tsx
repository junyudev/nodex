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
import {
  inboxSuggestionsOffered,
  type InboxSuggestionPolicy,
} from "../../../shared/inbox-suggestion-policy";
import type { Project } from "../../../shared/types";
import {
  ActivitySpinnerIcon,
  ArchiveIcon,
  CheckmarkIcon,
  CompactChevronDownIcon,
  DispatchIcon,
  EditIcon,
  RefreshIcon,
  RetryIcon,
  ThreadIcon,
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
  describeInboxFiring,
  inboxPageRoutingContext,
  inboxRowOffers,
  inboxTriageModel,
  isChatAction,
  type InboxOutcome,
  type InboxRowOffers,
} from "./inbox-presentation";
import { scheduledTaskChatAgent, useInboxFiringTask } from "./inbox-firing";
import { useInboxOutcome } from "./use-inbox-outcome";
import {
  InboxDispatchEditor,
  draftForInboxItem,
  type InboxDispatchDraft,
  type InboxDispatchFiring,
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

/** Advice on its way, held in the place an icon or the decision takes once it arrives. */
function AdviceSpinner({
  className,
  solid = false,
}: {
  readonly className?: string;
  /** Holds the place of the row's primary button, in its colors. */
  readonly solid?: boolean;
}) {
  return (
    <span
      role="status"
      aria-label="Finding where this goes"
      className={cn(
        "flex",
        solid
          ? "size-6 items-center justify-center rounded-md bg-primary-solid text-primary-solid"
          : "text-token-description-foreground",
        className,
      )}
    >
      <ActivitySpinnerIcon className="icon-xs" />
    </span>
  );
}

/**
 * A labeled action always has an edge: solid when it is the step the row recommends, outlined
 * when it is the alternative beside one.
 */
type DecisionVariant = "primary" | "outline";

/**
 * The recommended step when its glyph says it all, such as asking again: solid like a decision,
 * ending the row, named by its tooltip.
 */
function SolidIconAction({
  label,
  icon: Icon,
  onClick,
}: {
  readonly label: string;
  readonly icon: InboxIcon;
  readonly onClick: () => void;
}) {
  return (
    <NodexTooltip tooltipContent={label} side="top">
      <NodexButton size="icon-xs" variant="primary" aria-label={label} onClick={onClick}>
        <Icon className="icon-xs" />
      </NodexButton>
    </NodexTooltip>
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
  readonly variant?: DecisionVariant;
  /** The other half of a split decision, which changes how it runs rather than running it. */
  readonly menu?: ReactNode;
  readonly onClick: () => void;
}) {
  const button = (
    <NodexButton
      size="xs"
      variant={variant}
      // An outlined split shares one border between its halves.
      className={cn(
        "min-w-0 gap-1.5",
        menu && "rounded-e-none",
        menu && variant === "outline" && "border-e-0",
      )}
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
    <div className={cn("flex min-w-0 items-center", variant !== "outline" && "gap-px")}>
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
      {proposal.origin === "schedule" ? (
        <span className="text-token-description-foreground">From your scheduled task</span>
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
  label = "Choose the model for this chat",
  variant,
  onChange,
}: {
  readonly agents: InboxAgents;
  readonly value: InboxChatAgent;
  readonly changed: boolean;
  readonly label?: string;
  /** Matches the decision it completes. */
  readonly variant: DecisionVariant;
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
          variant={variant}
          aria-label={label}
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
  firingLine,
}: {
  readonly proposal: InboxProposal;
  readonly agents: InboxAgents;
  /** For a scheduled task's run, how it will go; its instructions are the message above. */
  readonly firingLine: string | null;
}) {
  // An outdated suggestion recedes, prompt included: it was written for text the message no
  // longer has.
  // Markdown reads `--foreground` directly, so the prompt is muted through it.
  const tone = proposal.outdated
    ? "text-token-description-foreground [--foreground:var(--color-token-description-foreground)]"
    : "text-token-foreground";
  const action = proposal.action;
  if (action.type === "run_task") {
    return (
      <p
        data-testid="inbox-suggestion"
        className="min-w-0 truncate text-[13px] leading-5 text-token-description-foreground"
      >
        {firingLine ?? proposal.summary}
      </p>
    );
  }
  return (
    <div
      data-testid="inbox-suggestion"
      data-outdated={proposal.outdated || undefined}
      className={cn("flex min-w-0 flex-col gap-2", tone)}
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
  /** Whether the row already opens the message's chat, so the message need not offer it again. */
  readonly opensChat: boolean;
}

// Only a row that opens the chat says so; every other row leaves it to the message.
type InboxRowParts = Omit<InboxTriageParts, "editor" | "messageActions" | "opensChat"> &
  Partial<Pick<InboxTriageParts, "opensChat">>;

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
  policy,
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
  onOpenScheduledTask,
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
  /** Opens a scheduled task, where it changes for every run. */
  readonly onOpenScheduledTask?: (automationId: string) => void;
  readonly projects: readonly Project[];
  /** What a new chat can run on, and the Inbox's own choice. */
  readonly agents: InboxAgents;
  /** The Project whose Inbox holds the message, or null for the Library Inbox. */
  readonly inboxProjectId: string | null;
  /** What suggestions do right now, which decides whether a waiting message is being advised. */
  readonly policy: InboxSuggestionPolicy;
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
  const task = useInboxFiringTask(item);
  const taskAgent = task ? scheduledTaskChatAgent(task) : null;
  const firing: InboxDispatchFiring | null = item.firing
    ? {
        automationId: item.firing.automationId,
        dispatchId: item.firing.dispatchId,
        taskAgent,
        heartbeat: task?.kind === "heartbeat",
      }
    : null;
  const proposedAction = item.proposal?.action;
  const suggested =
    proposedAction?.type === "new_chat" || proposedAction?.type === "run_task"
      ? proposedAction
      : null;
  const choice = chatChoice?.proposalId === item.proposal?.proposalId ? chatChoice : null;
  // The suggestion's new chat or run as the row has it, once a model is chosen here.
  const rowAction = suggested && choice ? { ...suggested, agent: choice.agent } : null;
  // A new chat starts from the Inbox's own model; a scheduled run from its task's.
  const baseAgent = suggested?.type === "run_task" ? taskAgent : agents.settings.chatAgent;
  const chatAgent = (rowAction ?? suggested)?.agent ?? baseAgent ?? agents.settings.chatAgent;
  const chooseAgent = (proposalId: string, agent: InboxChatAgent) =>
    setChatChoice({
      proposalId,
      agent: baseAgent && sameInboxChatAgent(agent, baseAgent) ? null : agent,
    });
  const [editing, setEditing] = useState<{
    readonly baseBody: string;
    readonly draft: InboxDraft;
    readonly basis: InboxPageBasis;
  } | null>(null);

  const model = inboxTriageModel(item, policy);
  const offers = inboxRowOffers(model, {
    suggestionsOffered: inboxSuggestionsOffered(policy),
    grouped: groupedWithKey != null,
  });
  const handled = useInboxOutcome(item);
  const done = () => void actions.setState([item.pageId], "done");
  const keep = () => void actions.keep([item.pageId]);
  const handleManually = () =>
    onManualDraftChange(draftForInboxItem(item, inboxProjectId, rowAction, firing));
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
  // Done with a scheduled task's waiting run means it does not run this time.
  const doneAction = offers.done ? (
    <InboxIconAction
      label={item.firing ? "Skip this run" : "Mark done"}
      icon={CheckmarkIcon}
      onClick={done}
    />
  ) : null;
  const copyAction = <InboxCopyAction item={item} />;
  const handleManuallyAction = offers.handleManually ? (
    <InboxIconAction label="Handle manually" icon={DispatchIcon} onClick={handleManually} />
  ) : null;
  // Deciding by hand as a labeled decision: the row's own step, or the alternative to one.
  const handleManuallyDecision = (variant: DecisionVariant) =>
    offers.handleManually ? (
      <Decision
        label="Handle manually"
        target={null}
        icon={DispatchIcon}
        variant={variant}
        onClick={handleManually}
      />
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

  const outcomeParts = (outcome: InboxOutcome): InboxRowParts => {
    const target = outcome.open;
    const chatId = target?.kind === "session" && onOpenSession ? target.sessionId : null;
    return {
      strip: (
        <Settle id="outcome">
          <InboxOutcomeLine outcome={outcome} />
        </Settle>
      ),
      opensChat: chatId != null,
      actions: chatId ? (
        <Row>
          <InboxIconActions>
            <InboxIconAction
              label="Open chat"
              icon={ThreadIcon}
              onClick={() => onOpenSession?.(chatId)}
            />
          </InboxIconActions>
        </Row>
      ) : null,
    };
  };

  const parts = (): InboxRowParts => {
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
              onEditTask={onOpenScheduledTask}
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
                <AdviceSpinner className="mr-(--inbox-card-radius)" />
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
        const runTask = proposal.action.type === "run_task";
        // A Heartbeat's run continues its chat on that chat's own Agent.
        const choosesModel = newChat || (runTask && taskAgent !== null && !firing?.heartbeat);
        const outdated = proposal.outdated;
        const askAgain = () => void actions.requestSuggestion(proposal.pageIds, proposal.basis);
        // An outdated suggestion can still be confirmed as it reads, but asking again is the
        // obvious next step, so that takes the primary place at the end of the row.
        const asksAgainFirst = outdated && (model.refreshing || offers.suggest);
        const variant = outdated ? "outline" : "primary";
        return {
          strip: (
            <Settle id={proposal.proposalId}>
              {model.refreshError ? (
                <Notice tone="error">Couldn’t suggest again — {model.refreshError}</Notice>
              ) : outdated ? (
                <Notice tone="quiet">
                  {proposal.pageIds.length > 1
                    ? "Suggested before one of these messages changed"
                    : "Suggested before this message changed"}
                </Notice>
              ) : null}
              {groupMembers(proposal)}
              <SuggestionStrip
                proposal={proposal}
                agents={agents}
                firingLine={item.firing ? describeInboxFiring(item.firing, task, new Date()) : null}
              />
            </Settle>
          ),
          actions: (
            <Row>
              <InboxIconActions>
                {menuNode}
                {asksAgainFirst ? null : model.refreshing ? (
                  <AdviceSpinner className="size-6 items-center justify-center" />
                ) : offers.suggest ? (
                  <InboxIconAction
                    label={model.refreshError ? "Retry" : "Suggest again"}
                    icon={RefreshIcon}
                    onClick={askAgain}
                  />
                ) : null}
                {proposal.action.type === "keep" || runTask ? null : keepAction}
                {doneAction}
              </InboxIconActions>
              <Decision
                label={presentation.verb}
                target={presentation.target}
                variant={variant}
                why={
                  <SuggestionWhy
                    proposal={proposal}
                    runsOn={choosesModel ? describeInboxAgent(agents, chatAgent) : null}
                  />
                }
                icon={INBOX_ACTION_ICONS[proposal.action.type]}
                menu={
                  choosesModel ? (
                    <ChatAgentMenu
                      agents={agents}
                      value={chatAgent}
                      changed={
                        !sameInboxChatAgent(chatAgent, baseAgent ?? agents.settings.chatAgent)
                      }
                      label={runTask ? "Choose the model for this run" : undefined}
                      variant={variant}
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
              {asksAgainFirst ? (
                model.refreshing ? (
                  <AdviceSpinner solid />
                ) : (
                  <SolidIconAction
                    label={model.refreshError ? "Retry" : "Suggest again"}
                    icon={RefreshIcon}
                    onClick={askAgain}
                  />
                )
              ) : null}
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
                {keepAction}
                {doneAction}
              </InboxIconActions>
              {/* Asking again is the obvious next step; deciding by hand stays beside it. */}
              {handleManuallyDecision(offers.suggest ? "outline" : "primary")}
              {offers.suggest ? (
                <SolidIconAction
                  label="Retry"
                  icon={RefreshIcon}
                  onClick={() => void actions.requestSuggestion([item.pageId], [item.basis])}
                />
              ) : null}
            </Row>
          ),
        };
      case "dispatch-failed": {
        const failure = model.proposal.failureKind;
        const uncertainChat = failure === "unknown" && onOpenSession ? model.proposal.chat : null;
        // A rejected chat needs a new decision; anything else that failed can be tried again.
        const retries =
          failure !== "unknown" &&
          !(failure === "rejected" && model.proposal.action.type !== "run_task");
        return {
          opensChat: uncertainChat != null,
          strip: (
            <Settle id="dispatch-failed">
              <Notice tone="error">
                {failure === "unknown"
                  ? "Delivery not confirmed"
                  : model.proposal.action.type === "run_task"
                    ? "Couldn’t run"
                    : "Couldn’t deliver"}{" "}
                — {model.message}
              </Notice>
            </Settle>
          ),
          actions: (
            <Row>
              <InboxIconActions>
                {menuNode}
                {item.firing ? null : keepAction}
                {doneAction}
              </InboxIconActions>
              {failure === "unknown" ? (
                <>
                  {/* Whether it arrived is checked in the chat first; sending again may repeat it. */}
                  {offers.handleManually ? (
                    <Decision
                      label="Send again"
                      target={null}
                      icon={DispatchIcon}
                      variant={uncertainChat ? "outline" : "primary"}
                      onClick={handleManually}
                    />
                  ) : null}
                  {uncertainChat ? (
                    <Decision
                      label="Open chat"
                      target={null}
                      icon={ThreadIcon}
                      onClick={() => onOpenSession?.(uncertainChat.sessionId)}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  {handleManuallyDecision(retries ? "outline" : "primary")}
                  {retries ? (
                    <SolidIconAction
                      label="Retry"
                      icon={RetryIcon}
                      onClick={() => void actions.retryDispatch(model.proposal.proposalId)}
                    />
                  ) : null}
                </>
              )}
            </Row>
          ),
        };
      }
      case "firing-withdrawn":
        return {
          strip: (
            <Settle id="firing-withdrawn">
              <Notice tone="quiet">Its scheduled task was deleted, so it can’t run</Notice>
            </Settle>
          ),
          actions: (
            <Row>
              <InboxIconActions>
                {menuNode}
                {doneAction}
              </InboxIconActions>
              {handleManuallyDecision("outline")}
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
                    icon={RefreshIcon}
                    onClick={() => void actions.requestSuggestion([item.pageId], [item.basis])}
                  />
                ) : null}
                {keepAction}
                {doneAction}
              </InboxIconActions>
              {handleManuallyDecision("outline")}
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
      opensChat: false,
    });
  }
  // A delivered or failed delivery's text is settled, and a dispatch editor is already open.
  const editable =
    !manualDraft && !decided && model.kind !== "handled" && model.kind !== "dispatch-failed";
  return children({
    editor: null,
    opensChat: false,
    messageActions: (
      <>
        {copyAction}
        {editable ? editAction : null}
      </>
    ),
    ...parts(),
  });
}
