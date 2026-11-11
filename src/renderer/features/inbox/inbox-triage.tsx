import { useInboxSkillAvailability, InboxSkillToggles } from "./inbox-skill-review";
import { inboxActionSkills } from "../../../shared/inbox";
import { useSpaceHostAvailable } from "@/lib/space-host-runtime";
import { useInboxClock } from "./use-inbox-clock";
import { loadPageDocumentMaterialization } from "@/lib/page-prompt-context";
import { toast } from "@/components/ui/toast";
import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import {
  inboxDispatchRetryable,
  type InboxAgentChoice,
  type InboxItem,
  type InboxProposal,
  type InboxPageBasis,
} from "../../../shared/inbox";
import {
  inboxSuggestionsOffered,
  type InboxSuggestionPolicy,
} from "../../../shared/inbox-suggestion-policy";
import type { Project } from "../../../shared/types";
import {
  ActivitySpinnerIcon,
  NoteIcon,
  TodoIcon,
  CheckmarkIcon,
  CompactChevronDownIcon,
  DispatchIcon,
  EditIcon,
  RefreshIcon,
  RetryIcon,
  StopIcon,
  ChatIcon,
} from "@/components/shared/icons";
import { Reply } from "@/components/shared/icons/generic-icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { NodexCheckbox } from "@/components/ui/settings";
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
import { InboxPlanSteps } from "./inbox-plan-steps";
import { INBOX_EASE_OUT } from "./inbox-stream-item";
import { InboxOutcomeLine } from "./inbox-outcome";
import { InboxLaterMenu } from "./inbox-later-menu";
import {
  describeInboxAction,
  describeInboxAutomationDecision,
  inboxPageRoutingContext,
  inboxRowAction,
  inboxRowOffers,
  inboxDecisionHold,
  inboxLeadHold,
  INBOX_HOLD_LABELS,
  inboxTriageModel,
  isChatAction,
  type InboxOutcome,
  type InboxRowEdit,
  type InboxRowOffers,
} from "./inbox-presentation";
import { automationChatAgent, useInboxAutomationDecisionTask } from "./inbox-automation-decision";
import { useInboxOutcome } from "./use-inbox-outcome";
import {
  InboxDispatchEditor,
  draftForInboxItem,
  type InboxDispatchDraft,
  type InboxDispatchAutomationDecision,
} from "./inbox-dispatch-editor";
import type { InboxActions } from "./use-inbox-actions";
import { InboxAgentLabel, InboxAgentPicker, type InboxAgents } from "./inbox-agent-picker";
import {
  describeInboxAgent,
  sameInboxAgentChoice,
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

/** A spinner that becomes a stop square while the button holding it is hovered or focused. */
function AdviceGlyph({ className }: { readonly className?: string }) {
  return (
    <>
      <ActivitySpinnerIcon
        className={className}
        containerClassName="[button:focus-visible_&]:hidden [button:hover_&]:hidden"
      />
      <StopIcon
        className={cn("hidden [button:focus-visible_&]:block [button:hover_&]:block", className)}
      />
    </>
  );
}

/**
 * Advice on its way, held in the place an icon or the decision takes once it arrives. It can take
 * minutes and spends usage, so it is also how the user stops it.
 */
function AdviceSpinner({
  solid = false,
  onStop,
}: {
  /** Holds the place of the row's primary button, in its colors. */
  readonly solid?: boolean;
  readonly onStop: () => void;
}) {
  const Action = solid ? SolidIconAction : InboxIconAction;
  return (
    <span role="status" aria-label="Finding where this goes" className="flex">
      <Action label="Stop suggesting" icon={AdviceGlyph} onClick={onStop} />
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
  disabledReason,
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
  readonly disabledReason?: string;
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
      disabled={Boolean(disabledReason)}
    >
      <Icon className="icon-xs shrink-0" />
      <span className="truncate">{target ?? label}</span>
    </NodexButton>
  );
  const decision = disabledReason ? (
    <NodexTooltip tooltipContent={disabledReason} side="top">
      <span>{button}</span>
    </NodexTooltip>
  ) : target ? (
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
      {proposal.origin === "automation" ? (
        <span className="text-token-description-foreground">From your automation</span>
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
  readonly value: InboxAgentChoice;
  readonly changed: boolean;
  readonly label?: string;
  /** Matches the decision it completes. */
  readonly variant: DecisionVariant;
  readonly onChange: (next: InboxAgentChoice) => void;
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
 * is on the decision. What the suggestion added on its own follows, each kept unless unchecked.
 * Other suggestions say what they do in one line.
 */
function SuggestionStrip({
  proposal,
  decisionLine,
  dropped,
  onToggleAddition,
  skillReview,
  planSteps,
}: {
  readonly proposal: InboxProposal;
  /** The cards a plan would create, laid out by the caller that knows Projects and Agents. */
  readonly planSteps?: ReactNode;
  /** For an automation's run, how it will go; its instructions are the message above. */
  readonly decisionLine: string | null;
  /** Additions unchecked on this row. */
  readonly dropped: readonly number[];
  readonly onToggleAddition: (index: number) => void;
  readonly skillReview: ReactNode;
}) {
  // An outdated suggestion recedes, prompt included: it was written for text the message no
  // longer has.
  // Markdown reads `--foreground` directly, so the prompt is muted through it.
  const tone = proposal.outdated
    ? "text-token-description-foreground [--foreground:var(--color-token-description-foreground)]"
    : "text-token-foreground";
  const action = proposal.action;
  if (action.type === "execute_decision") {
    return (
      <p
        data-testid="inbox-suggestion"
        className="min-w-0 truncate text-[13px] leading-5 text-token-description-foreground"
      >
        {decisionLine ?? proposal.summary}
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
      {action.type === "plan" ? planSteps : null}
      {skillReview}
      {isChatAction(action) && action.additions.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-1.5">
          {action.additions.map((addition, index) => {
            const kept = !dropped.includes(index);
            return (
              <li key={index} className="flex min-w-0 items-start gap-2">
                <NodexCheckbox
                  ariaLabel={addition}
                  checked={kept}
                  onCheckedChange={() => onToggleAddition(index)}
                  className="mt-[3px]"
                />
                <div
                  className={cn(
                    "min-w-0 flex-1",
                    !kept &&
                      "line-through opacity-50 [--foreground:var(--color-token-description-foreground)]",
                  )}
                >
                  <MessageText text={addition} />
                </div>
              </li>
            );
          })}
        </ul>
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
  onOpenAutomation,
  decided = null,
  onReply,
}: {
  readonly item: InboxItem;
  /** Answers a Nodex post from the composer. */
  readonly onReply?: () => void;
  /**
   * Where this window just sent the message. The card shows it in place of everything else
   * until the message folds away, so a decision never makes a message simply vanish.
   */
  readonly decided?: InboxOutcome | null;
  readonly members?: readonly InboxGroupMember[];
  readonly onOpenPage?: (pageId: string) => void;
  readonly onOpenSession?: (sessionId: string) => void;
  /** Opens an automation, where it changes for every run. */
  readonly onOpenAutomation?: (automationId: string) => void;
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
  // What the row changed on this suggestion before deciding; another suggestion starts afresh.
  const hostAvailable = useSpaceHostAvailable();
  const now = new Date(useInboxClock());
  const [rowEdit, setRowEdit] = useState<InboxRowEdit | null>(null);
  const task = useInboxAutomationDecisionTask(item);
  const taskAgent = task ? automationChatAgent(task) : null;
  const automationDecision: InboxDispatchAutomationDecision | null = item.automationDecision
    ? {
        automationId: item.automationDecision.automationId,
        taskAgent,
        heartbeat: task?.kind === "heartbeat",
      }
    : null;
  const proposedAction = item.proposal?.action;
  const suggested =
    proposedAction?.type === "new_chat" || proposedAction?.type === "execute_decision"
      ? proposedAction
      : null;
  const edit =
    rowEdit &&
    item.proposal &&
    rowEdit.proposalId === item.proposal.proposalId &&
    rowEdit.revision === item.proposal.revision
      ? rowEdit
      : null;
  const proposalRevision = item.proposal?.revision;
  // The suggestion as the row has it, once a model is chosen or an addition dropped here.
  const rowAction = item.proposal ? inboxRowAction(item.proposal.action, edit) : null;
  // A new chat starts from the Inbox's own model; an Automation admission from its Automation's.
  const baseAgent = suggested?.type === "execute_decision" ? taskAgent : agents.settings.chatAgent;
  const chatAgent =
    (edit?.agent !== undefined ? edit.agent : suggested?.agent) ??
    baseAgent ??
    agents.settings.chatAgent;
  const chooseAgent = (proposalId: string, agent: InboxAgentChoice) =>
    setRowEdit((current) => ({
      ...edit,
      proposalId,
      revision: proposalRevision,
      agent: baseAgent && sameInboxAgentChoice(agent, baseAgent) ? null : agent,
      dropped:
        current?.proposalId === proposalId && current.revision === proposalRevision
          ? current.dropped
          : [],
    }));
  const toggleAddition = (proposalId: string, index: number) =>
    setRowEdit((current) => {
      const same =
        current?.proposalId === proposalId && current.revision === proposalRevision
          ? current
          : { proposalId, revision: proposalRevision, dropped: [] };
      return {
        ...same,
        dropped: same.dropped.includes(index)
          ? same.dropped.filter((dropped) => dropped !== index)
          : [...same.dropped, index],
      };
    });
  const skillAvailability = useInboxSkillAvailability(item.proposal, rowAction ?? proposedAction);
  const droppedSkillNames = [
    ...new Set([...(edit?.droppedSkillNames ?? []), ...skillAvailability.unavailable]),
  ];
  const toggleSkill = (proposalId: string, name: string) =>
    setRowEdit((current) => {
      const same =
        current?.proposalId === proposalId && current.revision === proposalRevision
          ? current
          : { proposalId, revision: proposalRevision, dropped: [] };
      const dropped = same.droppedSkillNames ?? [];
      return {
        ...same,
        droppedSkillNames: dropped.includes(name)
          ? dropped.filter((candidate) => candidate !== name)
          : [...dropped, name],
      };
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
  const saveToNotes = () => void actions.saveToNotes([item.pageId], [item.basis]);
  const handleManually = () =>
    onManualDraftChange(
      draftForInboxItem(
        item,
        inboxProjectId,
        rowAction,
        automationDecision,
        edit?.droppedSkillNames,
      ),
    );
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
  // One way to hold the message leads, by its kind; the other waits in its menu. A suggestion
  // that already is that hold offers it as its decision instead.
  const leadHold = inboxLeadHold(item);
  const holdAction =
    offers.hold && !item.automationDecision && leadHold !== inboxDecisionHold(item) ? (
      <InboxIconAction
        label={INBOX_HOLD_LABELS[leadHold]}
        icon={leadHold === "notes" ? NoteIcon : TodoIcon}
        onClick={leadHold === "notes" ? saveToNotes : keep}
      />
    ) : null;
  // An automation's waiting run is run, skipped or handed elsewhere; it is never set aside.
  const laterAction = item.automationDecision ? null : (
    <InboxLaterMenu onChoose={(remindAt) => void actions.later([item.pageId], remindAt)} />
  );
  // Done with an automation's waiting run means it does not run this time.
  const doneAction = offers.done ? (
    <InboxIconAction
      label={item.automationDecision ? "Skip this run" : "Mark done"}
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
              icon={ChatIcon}
              onClick={() => onOpenSession?.(chatId)}
            />
          </InboxIconActions>
        </Row>
      ) : null,
    };
  };

  const stopAdvice = () => void actions.stopSuggestion(item.pageId);

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
              onEditTask={onOpenAutomation}
              onCancel={() => onManualDraftChange(null)}
              onSubmit={(action, chat, droppedSkills) =>
                manualDraft.proposal
                  ? droppedSkills?.length
                    ? actions.confirm(manualDraft.proposal, action, chat, droppedSkills)
                    : actions.confirm(manualDraft.proposal, action, chat)
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
                {laterAction}
                {holdAction}
                {doneAction}
                {handleManuallyAction}
                <AdviceSpinner onStop={stopAdvice} />
              </InboxIconActions>
            </Row>
          ),
        };
      case "suggestion": {
        const proposal = model.proposal;
        const presentation = describeInboxAction(proposal.action, {
          targetProjectName: proposal.targetProjectName,
          chat: proposal.chat,
          now,
        });
        const newChat = proposal.action.type === "new_chat";
        const executesDecision = proposal.action.type === "execute_decision";
        const proposedLater = proposal.action.type === "later" ? proposal.action : null;
        // A time Nodex proposed may have come and gone while the suggestion waited.
        const laterPassed =
          proposedLater?.remindAt != null && Date.parse(proposedLater.remindAt) <= now.getTime();
        // A Heartbeat's run continues its chat on that chat's own Agent.
        const choosesModel =
          newChat || (executesDecision && taskAgent !== null && !automationDecision?.heartbeat);
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
                decisionLine={
                  item.automationDecision
                    ? describeInboxAutomationDecision(item.automationDecision, task, now)
                    : null
                }
                dropped={edit?.dropped ?? []}
                onToggleAddition={(index) => toggleAddition(proposal.proposalId, index)}
                skillReview={
                  <InboxSkillToggles
                    skills={inboxActionSkills(proposal.action)}
                    dropped={droppedSkillNames}
                    unavailable={skillAvailability.unavailable}
                    pending={skillAvailability.pending}
                    onToggle={(name) => toggleSkill(proposal.proposalId, name)}
                  />
                }
                planSteps={
                  proposal.action.type === "plan" ? (
                    <InboxPlanSteps
                      steps={proposal.action.steps}
                      projects={projects}
                      agents={agents}
                    />
                  ) : null
                }
              />
            </Settle>
          ),
          actions: (
            <Row>
              <InboxIconActions>
                {menuNode}
                {asksAgainFirst ? null : model.refreshing ? (
                  <AdviceSpinner onStop={stopAdvice} />
                ) : offers.suggest ? (
                  <InboxIconAction
                    label={model.refreshError ? "Retry" : "Suggest again"}
                    icon={RefreshIcon}
                    onClick={askAgain}
                  />
                ) : null}
                {proposedLater ? null : laterAction}
                {holdAction}
                {doneAction}
              </InboxIconActions>
              <Decision
                label={presentation.verb}
                disabledReason={
                  skillAvailability.pending
                    ? "Checking skill availability"
                    : !hostAvailable && executesDecision
                      ? "Space host unavailable"
                      : laterPassed
                        ? "That time has passed. Choose another."
                        : undefined
                }
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
                        !sameInboxAgentChoice(chatAgent, baseAgent ?? agents.settings.chatAgent)
                      }
                      label={executesDecision ? "Choose the model for this run" : undefined}
                      variant={variant}
                      onChange={(next) => chooseAgent(proposal.proposalId, next)}
                    />
                  ) : proposedLater ? (
                    <InboxLaterMenu
                      label="Choose another time"
                      current={laterPassed ? undefined : proposedLater.remindAt}
                      onChoose={(remindAt) =>
                        void actions.confirm(proposal, { type: "later", remindAt })
                      }
                      trigger={
                        <NodexButton
                          size="xs"
                          variant={variant}
                          aria-label="Choose another time"
                          className="rounded-s-none px-1.5"
                        >
                          <CompactChevronDownIcon className="icon-2xs shrink-0" />
                        </NodexButton>
                      }
                    />
                  ) : null
                }
                onClick={() =>
                  skillAvailability.pending
                    ? undefined
                    : droppedSkillNames.length
                      ? void actions.confirm(
                          proposal,
                          rowAction ?? undefined,
                          undefined,
                          droppedSkillNames,
                        )
                      : void (rowAction
                          ? actions.confirm(proposal, rowAction)
                          : actions.confirm(proposal))
                }
              />
              {asksAgainFirst ? (
                model.refreshing ? (
                  <AdviceSpinner solid onStop={stopAdvice} />
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
                {laterAction}
                {holdAction}
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
        const retries = inboxDispatchRetryable(model.proposal);
        return {
          opensChat: uncertainChat != null,
          strip: (
            <Settle id="dispatch-failed">
              <Notice tone="error">
                {failure === "unknown"
                  ? "Delivery not confirmed"
                  : model.proposal.action.type === "execute_decision"
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
                {laterAction}
                {holdAction}
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
                      icon={ChatIcon}
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
      case "decision-withdrawn":
        return {
          strip: (
            <Settle id="decision-withdrawn">
              <Notice tone="quiet">Its automation was deleted, so it can’t run</Notice>
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
                {laterAction}
                {holdAction}
                {doneAction}
              </InboxIconActions>
              {handleManuallyDecision("outline")}
            </Row>
          ),
        };
      case "answer":
        return {
          strip: null,
          opensChat: false,
          actions: (
            <Row>
              <InboxIconActions>{menuNode}</InboxIconActions>
              {onReply ? (
                <Decision label="Reply" target={null} icon={Reply} onClick={onReply} />
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
      opensChat: false,
    });
  }
  // A delivered or failed delivery's text is settled, and a dispatch editor is already open.
  // Nodex's own words are not the user's to rewrite.
  const editable =
    !manualDraft &&
    !decided &&
    model.kind !== "handled" &&
    model.kind !== "dispatch-failed" &&
    model.kind !== "answer";
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
