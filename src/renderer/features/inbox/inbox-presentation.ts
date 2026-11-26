import { presentSessionTitle } from "@/lib/session-title-presentation";
import { defineMessage, getIntl, type MessageDescriptor, type IntlShape } from "@/lib/i18n";
import { CoreApiError } from "@/lib/core-api-error";
import type {
  ActivityRow,
  InboxChat,
  InboxAgentChoice,
  InboxDispatchAction,
  InboxEntryKind,
  InboxAutomationDecision,
  InboxImportantMessage,
  InboxItem,
  InboxPageStatus,
  InboxProposal,
  InboxScope,
  NodexEntryPurpose,
} from "../../../shared/inbox";
import type {
  InboxSuggestionPause,
  InboxSuggestionPolicy,
} from "../../../shared/inbox-suggestion-policy";
import type { Automation } from "../../../shared/types";
import { DEFAULT_WORKFLOW_STATUS } from "../../../shared/workflow-status";
import type { ContentRoutingContext } from "../../../shared/content-routing-context";
import { USER_TURN_TIMESTAMP_GAP_MS } from "../local-conversation/projection/conversation-turn-timestamps";
import type { SessionLiveIndicator } from "@/lib/session-execution";
import { formatUsageCountdown } from "@/lib/usage-meter";
import { describeInboxSnoozedOutcome, formatInboxSnoozeTime } from "./inbox-snooze";

/** What the strip attached to a message in the Inbox shows: what Nodex made of it. */
export type InboxTriageModel =
  | { readonly kind: "suggesting" }
  | {
      readonly kind: "suggestion";
      readonly proposal: InboxProposal;
      /** New advice is on its way; this suggestion stays until it arrives. */
      readonly refreshing: boolean;
      /** Why asking again failed, while this suggestion stays. */
      readonly refreshError: string | null;
    }
  | { readonly kind: "suggestion-failed"; readonly message: string }
  | { readonly kind: "dispatch-failed"; readonly proposal: InboxProposal; readonly message: string }
  /** An automation's waiting run whose task is gone, so it can no longer run. */
  | { readonly kind: "decision-withdrawn" }
  /** A post Nodex wrote about a chat or Page; it takes no advice. */
  | {
      readonly kind: "answer";
      readonly purpose: NodexEntryPurpose;
      readonly subjectSessionId: string | null;
      readonly subjectPageId: string | null;
    }
  /** No advice has been asked for, or suggestions are off. */
  | { readonly kind: "undecided" }
  /** Handled; the message is on its way to History. */
  | { readonly kind: "handled" };

/** Starts a chat or sends to one, so it carries a prompt. */
export const isChatAction = (
  action: InboxDispatchAction,
): action is Extract<InboxDispatchAction, { type: "new_chat" | "send_to_chat" }> =>
  action.type === "new_chat" || action.type === "send_to_chat";

/**
 * What a row changed on one suggestion before deciding: a model or a place to work chosen on its
 * decision in place of the suggestion's (null follows the Inbox's own), and the additions it
 * unchecked.
 */
export interface InboxRowEdit {
  readonly proposalId: string;
  readonly revision?: number;
  readonly droppedSkillNames?: readonly string[];
  readonly agent?: InboxAgentChoice | null;
  readonly worktree?: boolean | null;
  readonly dropped: readonly number[];
}

/** The suggestion's action as its row has it, or null while the row changed nothing. */
export function inboxRowAction(
  action: InboxDispatchAction,
  edit: InboxRowEdit | null,
): InboxDispatchAction | null {
  if (!edit) return null;
  const choosesAgent =
    edit.agent !== undefined && (action.type === "new_chat" || action.type === "execute_decision");
  const choosesWorktree = edit.worktree !== undefined && action.type === "new_chat";
  const dropsAdditions = edit.dropped.length > 0 && isChatAction(action);
  if (!choosesAgent && !choosesWorktree && !dropsAdditions && !edit.droppedSkillNames?.length)
    return null;
  const withChoices =
    action.type === "new_chat"
      ? {
          ...action,
          ...(choosesAgent ? { agent: edit.agent ?? null } : {}),
          ...(choosesWorktree ? { worktree: edit.worktree ?? null } : {}),
        }
      : choosesAgent && action.type === "execute_decision"
        ? { ...action, agent: edit.agent ?? null }
        : action;
  return isChatAction(withChoices)
    ? {
        ...withChoices,
        additions: withChoices.additions.filter((_, index) => !edit.dropped.includes(index)),
        ...(edit.droppedSkillNames?.length
          ? {
              skills: (withChoices.skills ?? []).filter(
                ({ name }) => !edit.droppedSkillNames?.includes(name),
              ),
            }
          : {}),
      }
    : withChoices;
}

/** Hands the work on: to a chat, or to a run of the automation the message came from. */
export const isWorkAction = (
  action: InboxDispatchAction,
): action is Extract<
  InboxDispatchAction,
  { type: "new_chat" | "send_to_chat" | "execute_decision" }
> => isChatAction(action) || action.type === "execute_decision";

export function isInboxItemHandled(item: InboxItem): boolean {
  return item.rowKind === "intake" && !item.waiting;
}

export function inboxTriageModel(
  item: InboxItem,
  policy: InboxSuggestionPolicy,
  intl: IntlShape = getIntl(),
): InboxTriageModel {
  const proposal = item.proposal;
  if (
    proposal &&
    isWorkAction(proposal.action) &&
    (proposal.state === "failed" ||
      (proposal.action.type === "execute_decision" &&
        item.automationDecision?.status === "failed") ||
      (proposal.state === "dispatching" && proposal.failureKind === "unknown"))
  ) {
    return {
      kind: "dispatch-failed",
      proposal,
      message:
        proposal.failureMessage ??
        item.automationDecision?.failureMessage ??
        (proposal.action.type === "execute_decision"
          ? intl.formatMessage({
              id: "inbox.inboxPresentation.theRunCouldNotBe",
              defaultMessage: "The run could not be started",
            })
          : intl.formatMessage({
              id: "inbox.inboxPresentation.theChatCouldNotBe",
              defaultMessage: "The chat could not be started",
            })),
    };
  }
  if (isInboxItemHandled(item)) return { kind: "handled" };
  if (item.automationDecision?.status === "withdrawn") return { kind: "decision-withdrawn" };
  if (item.source.kind === "nodex")
    return {
      kind: "answer",
      purpose: item.source.purpose,
      subjectSessionId: null,
      subjectPageId: null,
    };
  // A message waiting for automatic advice gets it only while suggestions run on their own;
  // otherwise Main releases it and it simply has none.
  const advising =
    policy.kind !== "off" &&
    (item.suggestionState === "pending" ||
      (item.suggestionState === "waiting" && policy.kind === "automatic"));
  const failure =
    item.suggestionState === "failed"
      ? (item.suggestionError ??
        intl.formatMessage({
          id: "inbox.inboxPresentation.noSuggestion",
          defaultMessage: "No suggestion was produced",
        }))
      : null;
  if (proposal?.state === "open")
    return { kind: "suggestion", proposal, refreshing: advising, refreshError: failure };
  if (advising) return { kind: "suggesting" };
  if (failure !== null) return { kind: "suggestion-failed", message: failure };
  return { kind: "undecided" };
}

/** Which of the message menu's actions a message's action row already shows. */
export interface InboxRowOffers {
  readonly done: boolean;
  readonly handleManually: boolean;
  readonly suggest: boolean;
  /** The row shows the way to hold the message that its kind leads with. */
  readonly hold: boolean;
}

export const NO_ROW_OFFERS: InboxRowOffers = {
  done: false,
  handleManually: false,
  suggest: false,
  hold: false,
};

/**
 * The two ways to hold a message without handing it to an Agent: as work in the Todo stage, or as
 * a note under the Inbox's Notes page, off the Board altogether.
 */
export type InboxHold = "todo" | "notes";

export const INBOX_HOLD_LABELS: Readonly<Record<InboxHold, MessageDescriptor>> = {
  todo: defineMessage({ id: "inbox.inboxPresentation.addToTodo", defaultMessage: "Add to Todo" }),
  notes: defineMessage({
    id: "inbox.inboxPresentation.saveToNotes",
    defaultMessage: "Save to Notes",
  }),
};

/** A note asks for no work, so it leads with Notes; anything else leads with Todo. */
export const inboxLeadHold = (item: InboxItem): InboxHold =>
  inboxEntryKind(item) === "note" ? "notes" : "todo";

/** The hold a suggestion's own decision already is, so the row never offers it twice. */
export const inboxDecisionHold = (item: InboxItem): InboxHold | null => {
  const action = item.proposal?.state === "open" ? item.proposal.action : null;
  return action?.type === "keep" ? "todo" : action?.type === "save_to_notes" ? "notes" : null;
};

/**
 * The holds a message's menu offers: whichever its row does not already show, and never one an
 * Automation's waiting run could take.
 */
export function inboxMenuHolds(item: InboxItem, offers: InboxRowOffers): readonly InboxHold[] {
  if (!item.waiting || item.automationDecision || item.source.kind === "nodex") return [];
  const decision = inboxDecisionHold(item);
  const lead = inboxLeadHold(item);
  return (["todo", "notes"] as const).filter(
    (hold) => hold !== decision && !(offers.hold && hold === lead),
  );
}

/**
 * What a message's action row offers beside its menu, so the menu holds only the rest and no
 * action appears twice. A group member whose suggestion shows on another message offers nothing
 * but its menu.
 */
export function inboxRowOffers(
  model: InboxTriageModel,
  input: { readonly suggestionsOffered: boolean; readonly grouped: boolean },
): InboxRowOffers {
  if (input.grouped && model.kind === "suggestion") return NO_ROW_OFFERS;
  switch (model.kind) {
    case "suggesting":
    case "dispatch-failed":
      return { done: true, handleManually: true, suggest: false, hold: true };
    case "decision-withdrawn":
      return { done: true, handleManually: true, suggest: false, hold: false };
    case "answer":
      return NO_ROW_OFFERS;
    case "suggestion":
      // Changing a suggestion happens in `Handle manually`, which stays in the menu. An outdated
      // or failed one asks again from the row, where new advice then shows its spinner.
      return {
        done: true,
        handleManually: false,
        hold: true,
        suggest:
          model.refreshing ||
          (input.suggestionsOffered && (model.proposal.outdated || model.refreshError !== null)),
      };
    case "suggestion-failed":
    case "undecided":
      return { done: true, handleManually: true, suggest: input.suggestionsOffered, hold: true };
    case "handled":
      return NO_ROW_OFFERS;
  }
}

/**
 * Which usage ran short, in a few words: how much is left, or that it is used up, and when it
 * comes back.
 */
export function describeInboxSuggestionPause(
  pause: InboxSuggestionPause,
  nowMs: number,
  intl: IntlShape = getIntl(),
): string {
  const left =
    pause.pace === "spent"
      ? intl.formatMessage({ id: "inbox.inboxPresentation.usedUp", defaultMessage: "used up" })
      : intl.formatMessage(
          { id: "inbox.inboxPresentation.valueLeft", defaultMessage: "{value1}% left" },
          { value1: pause.leftPercent },
        );
  const resetsAt = pause.resetsAt ? Date.parse(pause.resetsAt) : Number.NaN;
  const state = intl.formatMessage(
    {
      id: "inbox.inboxPresentation.valueValueValue",
      defaultMessage: "{value1} {value2}: {value3}",
    },
    { value1: pause.agent, value2: pause.window, value3: left },
  );
  return Number.isFinite(resetsAt)
    ? intl.formatMessage(
        {
          id: "inbox.inboxPresentation.valueResetsValue",
          defaultMessage: "{value1}, resets {value2}",
        },
        { value1: state, value2: formatUsageCountdown(resetsAt, nowMs) },
      )
    : state;
}

/** Where a message's Page is read from now: its filed Database's Project, else its Inbox's. */
export function inboxPageRoutingContext(item: InboxItem): ContentRoutingContext {
  if (item.location.kind === "database") {
    return item.location.projectId
      ? { kind: "project", projectId: item.location.projectId }
      : { kind: "library" };
  }
  return item.scope.kind === "project" ? item.scope : { kind: "library" };
}

/**
 * The Project a row is named by. Only the all-Projects Inbox names one, where rows from every
 * Project share a stream: a Project's own Inbox holds nothing else, and a row without a Project
 * says so by naming none.
 */
export function inboxRowProject<P extends { readonly id: string }>(
  item: Pick<InboxItem, "scope">,
  inbox: InboxScope,
  projects: readonly P[],
): P | null {
  if (inbox.kind === "project" || item.scope.kind !== "project") return null;
  const { projectId } = item.scope;
  return projects.find((project) => project.id === projectId) ?? null;
}

/** The kind the user set, else the one the current suggestion proposes. */
export const inboxEntryKind = (item: InboxItem): InboxEntryKind | null =>
  item.kind ?? item.proposal?.kind ?? null;

/**
 * The Board status a message shows beside it. Every message waits in Triage, so only a Page that
 * has moved on says anything: its work has already started somewhere else.
 */
export const inboxPageStatusMark = (item: InboxItem): InboxPageStatus | null =>
  item.pageStatus && item.pageStatus.id !== DEFAULT_WORKFLOW_STATUS ? item.pageStatus : null;

export type InboxOutcomeIcon =
  | "chat"
  | "pending"
  | "move"
  | "todo"
  | "notes"
  | "snooze"
  | "done"
  | "inbox";

export type InboxOutcomeTarget =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "database"; readonly databaseId: string };

/** How a handled message was handled and where its work stands now. */
export interface InboxOutcome {
  readonly icon: InboxOutcomeIcon;
  readonly label: string;
  /** Live state of the chat that received it. */
  readonly status: InboxChatStatusPresentation | null;
  readonly open: InboxOutcomeTarget | null;
  /** Kept and done messages can go back to the Inbox; dispatched work cannot be recalled. */
  readonly canReturn: boolean;
  /**
   * Whether the user has closed the chat's work, which a finished chat never does for them;
   * null for messages not handed to a chat.
   */
  readonly done: boolean | null;
  /**
   * Work still under way: being delivered, or its chat working, waiting, or with a new reply.
   * Activity marks the line about it with the chat's live state.
   */
  readonly inProgress: boolean;
  /**
   * Where a new chat in a Project was just started to work, as its decision fixed it: its Page's
   * worktree or the Project's checkout. Absent where the place was not a choice or is not known.
   */
  readonly worktree?: boolean | null;
}

/** Held without an Agent: both can go back to the Inbox. */
const HELD = { status: null, open: null, canReturn: true, done: null, inProgress: false } as const;
const inTodo = (intl: IntlShape) =>
  ({
    ...HELD,
    icon: "todo",
    label: intl.formatMessage(
      defineMessage({ id: "inbox.inboxPresentation.addedToTodo", defaultMessage: "Added to Todo" }),
    ),
  }) as const;
const inNotes = (intl: IntlShape) =>
  ({
    ...HELD,
    icon: "notes",
    label: intl.formatMessage(
      defineMessage({
        id: "inbox.inboxPresentation.savedToNotes",
        defaultMessage: "Saved to Notes",
      }),
    ),
  }) as const;
const doneOutcome = (intl: IntlShape) =>
  ({
    icon: "done",
    label: intl.formatMessage({ id: "inbox.inboxPresentation.done", defaultMessage: "Done" }),
    status: null,
    open: null,
    canReturn: true,
  }) as const;
const skippedOutcome = (intl: IntlShape) =>
  ({
    ...doneOutcome(intl),
    label: intl.formatMessage({
      id: "inbox.inboxPresentation.skipped",
      defaultMessage: "Skipped",
    }),
  }) as const;

const doneLabel = (item: InboxItem, intl: IntlShape): string => {
  if (item.automationDecision?.status === "skipped") return skippedOutcome(intl).label;
  return doneOutcome(intl).label;
};

/** The Automation a decision came from, as the message names it. */
const decisionAutomationName = (item: InboxItem, intl: IntlShape): string =>
  item.source.kind === "automation"
    ? item.source.label
    : intl.formatMessage({
        id: "inbox.inboxPresentation.automation",
        defaultMessage: "automation",
      });

/** Work Nodex started on the person's standing consent says so; the person's own does not. */
const chatLabel = (
  type: "new_chat" | "send_to_chat",
  delivered: boolean,
  title: string,
  projectName: string | null,
  byNodex: boolean,
  intl: IntlShape,
) => {
  if (byNodex) {
    if (type === "send_to_chat")
      return delivered
        ? intl.formatMessage(
            {
              id: "inbox.inboxPresentation.nodexSentItToValue",
              defaultMessage: "Nodex sent it to “{value1}”",
            },
            { value1: title },
          )
        : intl.formatMessage(
            {
              id: "inbox.inboxPresentation.nodexIsSendingItTo",
              defaultMessage: "Nodex is sending it to “{value1}”",
            },
            { value1: title },
          );
    return delivered
      ? intl.formatMessage(
          {
            id: "inbox.inboxPresentation.nodexStartedValue",
            defaultMessage: "Nodex started “{value1}”",
          },
          { value1: title },
        )
      : intl.formatMessage(
          {
            id: "inbox.inboxPresentation.nodexIsStartingAChat",
            defaultMessage: "Nodex is starting a chat in {value1}",
          },
          {
            value1:
              projectName ??
              intl.formatMessage({
                id: "inbox.inboxPresentation.noProject",
                defaultMessage: "no Project",
              }),
          },
        );
  }
  if (type === "send_to_chat")
    return delivered
      ? intl.formatMessage(
          { id: "inbox.inboxPresentation.sentToValue", defaultMessage: "Sent to “{value1}”" },
          { value1: title },
        )
      : intl.formatMessage(
          { id: "inbox.inboxPresentation.sendingToValue", defaultMessage: "Sending to “{value1}”" },
          { value1: title },
        );
  return delivered
    ? intl.formatMessage(
        { id: "inbox.inboxPresentation.startedValue", defaultMessage: "Started “{value1}”" },
        { value1: title },
      )
    : intl.formatMessage(
        {
          id: "inbox.inboxPresentation.startingAChatInValue",
          defaultMessage: "Starting a chat in {value1}",
        },
        {
          value1:
            projectName ??
            intl.formatMessage({
              id: "inbox.inboxPresentation.noProject",
              defaultMessage: "no Project",
            }),
        },
      );
};

const doneStatus = (intl: IntlShape): InboxChatStatusPresentation => ({
  label: intl.formatMessage({ id: "inbox.inboxPresentation.done", defaultMessage: "Done" }),
  tone: "quiet",
  inProgress: false,
});

/** `live` is the receiving chat's Runtime activity, when the chat is Runtime-bound. */
export function describeInboxOutcome(
  item: InboxItem,
  live: SessionLiveIndicator | null = null,
  intl = getIntl(),
): InboxOutcome {
  if (item.rowKind === "answer")
    return {
      icon: "done",
      label: intl.formatMessage({
        id: "inbox.inboxPresentation.answered",
        defaultMessage: "Answered",
      }),
      status: null,
      open: null,
      canReturn: false,
      done: null,
      inProgress: false,
    };

  if (item.proposal?.action.type === "plan" && item.proposal.state === "completed") {
    return {
      ...doneOutcome(intl),
      label: intl.formatMessage(
        {
          id: "inbox.inboxPresentation.plannedValueCards",
          defaultMessage: "Planned {value1} cards",
        },
        { value1: item.proposal.createdPageIds?.length ?? item.proposal.action.steps.length },
      ),
      canReturn: false,
      done: null,
      inProgress: false,
    };
  }
  const proposal = item.proposal;
  if (proposal?.action.type === "execute_decision" && proposal.state === "completed") {
    const chat = proposal.chat;
    const done = item.pageStatus?.id === "done";
    const title = `“${decisionAutomationName(item, intl)}”`;
    // A Cron run reaches a chat once its workspace is ready; a Heartbeat already has its chat.
    if (!chat) {
      return {
        icon: done ? "done" : "pending",
        label: intl.formatMessage(
          { id: "inbox.inboxPresentation.startingValue", defaultMessage: "Starting {value1}" },
          { value1: title },
        ),
        status: done ? doneStatus(intl) : null,
        open: null,
        canReturn: false,
        done: null,
        inProgress: !done,
      };
    }
    const status = done ? doneStatus(intl) : describeInboxChatStatus(chat, live, intl);
    return {
      icon: "chat",
      label: intl.formatMessage(
        { id: "inbox.inboxPresentation.ranValue", defaultMessage: "Ran {value1}" },
        { value1: title },
      ),
      status,
      open: { kind: "session", sessionId: chat.sessionId },
      canReturn: false,
      done: null,
      inProgress: status.inProgress,
    };
  }
  if (
    proposal &&
    isChatAction(proposal.action) &&
    (proposal.state === "completed" ||
      (proposal.state === "dispatching" && proposal.failureKind !== "unknown"))
  ) {
    const chat = proposal.chat;
    const open: InboxOutcomeTarget | null = chat
      ? { kind: "session", sessionId: chat.sessionId }
      : null;
    const done = item.pageStatus?.id === "done";
    const label = proposal.answeredQuestion
      ? intl.formatMessage(
          {
            id: "inbox.inboxPresentation.answeringQuestion",
            defaultMessage:
              "{completed, select, true {Answered} other {Answering}} “{chat}”’s question",
          },
          {
            completed: String(proposal.state === "completed"),
            chat: chat
              ? presentSessionTitle(chat, intl)
              : intl.formatMessage({
                  id: "inbox.inboxPresentation.chatFallback",
                  defaultMessage: "chat",
                }),
          },
        )
      : chatLabel(
          proposal.action.type,
          proposal.state === "completed",
          chat
            ? presentSessionTitle(chat, intl)
            : intl.formatMessage({
                id: "inbox.inboxPresentation.chatFallback",
                defaultMessage: "chat",
              }),
          proposal.targetProjectName,
          proposal.confirmedBy === "nodex",
          intl,
        );
    if (proposal.state === "dispatching") {
      return {
        icon: "pending",
        label,
        status: done ? doneStatus(intl) : null,
        open,
        canReturn: false,
        done: null,
        inProgress: !done,
      };
    }
    if (proposal.state === "completed") {
      const status = done ? doneStatus(intl) : describeInboxChatStatus(chat, live, intl);
      return {
        icon: "chat",
        label,
        status,
        open,
        canReturn: false,
        done: null,
        inProgress: status.inProgress,
      };
    }
  }
  if (proposal?.action.type === "move_to_project" && proposal.state === "completed") {
    return {
      icon: "move",
      label: intl.formatMessage(
        { id: "inbox.inboxPresentation.movedToValue", defaultMessage: "Moved to {value1}" },
        {
          value1:
            proposal?.targetProjectName ??
            (item.location.kind === "database" ? item.location.projectName : null) ??
            intl.formatMessage({
              id: "inbox.inboxPresentation.projectFallback",
              defaultMessage: "Project",
            }),
        },
      ),
      status: null,
      open:
        item.location.kind === "database"
          ? { kind: "database", databaseId: item.location.databaseId }
          : null,
      canReturn: false,
      done: null,
      inProgress: false,
    };
  }
  if (proposal?.action.type === "save_to_notes" && proposal.state === "completed")
    return inNotes(intl);
  if (!item.waiting && item.pageStatus?.id === "done")
    return { ...doneOutcome(intl), label: doneLabel(item, intl), done: null, inProgress: false };
  if (!item.waiting && item.pageStatus?.id === "plan") return inTodo(intl);
  return {
    icon: "inbox",
    label: intl.formatMessage({
      id: "inbox.inboxPresentation.inTheInbox",
      defaultMessage: "In the Inbox",
    }),
    status: null,
    open: null,
    canReturn: false,
    done: null,
    inProgress: false,
  };
}

/** A decision this window just made, described before Core's handled message arrives. */
export type InboxDecision =
  | { readonly kind: "plan"; readonly count: number }
  | { readonly kind: "keep" }
  | { readonly kind: "save_to_notes" }
  /** Set aside until a time; the message stays undecided and comes back then. */
  | { readonly kind: "snooze"; readonly snoozedUntil: string }
  | { readonly kind: "done" }
  /** An automation's waiting run, confirmed to run now. */
  | { readonly kind: "run"; readonly taskName: string }
  | { readonly kind: "move"; readonly projectName: string | null }
  | {
      readonly kind: "chat";
      readonly type: "new_chat" | "send_to_chat";
      readonly sessionId: string;
      /** The receiving chat's title, when it already has one. */
      readonly chatTitle: string | null;
      readonly projectName: string | null;
      /** Where a new chat in a Project works, as its confirmation fixed it. */
      readonly worktree?: boolean | null;
    };

/** What a message shows in its place in the Inbox between the decision and folding away. */
export function describeInboxDecision(
  item: InboxItem,
  decision: InboxDecision,
  now: Date = new Date(),
  intl = getIntl(),
): InboxOutcome {
  switch (decision.kind) {
    case "plan":
      return {
        ...doneOutcome(intl),
        label: intl.formatMessage(
          {
            id: "inbox.inboxPresentation.plannedValueCards",
            defaultMessage: "Planned {value1} cards",
          },
          { value1: decision.count },
        ),
        canReturn: false,
        done: null,
        inProgress: false,
      };
    case "snooze":
      return {
        ...HELD,
        icon: "snooze",
        label: describeInboxSnoozedOutcome(decision.snoozedUntil, now),
        inProgress: false,
      };
    case "save_to_notes":
      return inNotes(intl);
    case "keep":
      return inTodo(intl);
    case "done":
      return {
        ...(item.automationDecision ? skippedOutcome(intl) : doneOutcome(intl)),
        done: null,
        inProgress: false,
      };
    case "run":
      return {
        icon: "pending",
        label: intl.formatMessage(
          { id: "inbox.inboxPresentation.startingValue2", defaultMessage: "Starting “{value1}”" },
          { value1: decision.taskName },
        ),
        status: null,
        open: null,
        canReturn: false,
        done: false,
        inProgress: true,
      };
    case "move":
      return {
        icon: "move",
        label: intl.formatMessage(
          { id: "inbox.inboxPresentation.movedToValue", defaultMessage: "Moved to {value1}" },
          {
            value1:
              decision.projectName ??
              intl.formatMessage({
                id: "inbox.inboxPresentation.projectFallback",
                defaultMessage: "Project",
              }),
          },
        ),
        status: null,
        open: null,
        canReturn: false,
        done: null,
        inProgress: false,
      };
    case "chat":
      return {
        icon: "pending",
        // A decision made in this window is the person's own.
        label: chatLabel(
          decision.type,
          false,
          decision.chatTitle !== null
            ? presentSessionTitle(decision.chatTitle, intl)
            : intl.formatMessage({
                id: "inbox.inboxPresentation.chatFallback",
                defaultMessage: "chat",
              }),
          decision.projectName,
          false,
          intl,
        ),
        status: null,
        open: { kind: "session", sessionId: decision.sessionId },
        canReturn: false,
        done: false,
        inProgress: true,
        worktree: decision.worktree ?? null,
      };
  }
}

export interface InboxActionPresentation {
  /** The confirming button's verb. */
  readonly verb: string;
  /** Where the work goes, in one short phrase. */
  readonly target: string;
}

export function describeInboxAction(
  action: InboxDispatchAction,
  context: {
    readonly targetProjectName: string | null;
    readonly chat: InboxChat | null;
    /** When a Snooze suggestion's time is read against; the present unless given. */
    readonly now?: Date;
  },
  intl: IntlShape = getIntl(),
): InboxActionPresentation {
  switch (action.type) {
    case "plan":
      // Confirming creates the cards and starts those that wait for nothing.
      return {
        verb: intl.formatMessage({
          id: "inbox.inboxPresentation.startPlan",
          defaultMessage: "Start plan",
        }),
        target: intl.formatMessage(
          { id: "inbox.inboxPresentation.startValueCards", defaultMessage: "Start {value1} cards" },
          { value1: action.steps.length },
        ),
      };
    case "snooze":
      return {
        verb: intl.formatMessage({
          id: "inbox.inboxPresentation.snooze",
          defaultMessage: "Snooze",
        }),
        target: getIntl().formatMessage(
          { id: "inbox.inboxPresentation.snoozeAt", defaultMessage: "Snooze · {time}" },
          { time: formatInboxSnoozeTime(action.snoozedUntil, context.now ?? new Date()) },
        ),
      };
    case "keep":
      return {
        verb: intl.formatMessage({
          id: "inbox.inboxPresentation.addToTodo",
          defaultMessage: "Add to Todo",
        }),
        target: intl.formatMessage({
          id: "inbox.inboxPresentation.addToTodo",
          defaultMessage: "Add to Todo",
        }),
      };
    case "save_to_notes":
      return {
        verb: intl.formatMessage({
          id: "inbox.inboxPresentation.saveToNotes",
          defaultMessage: "Save to Notes",
        }),
        target: intl.formatMessage({
          id: "inbox.inboxPresentation.saveToNotes",
          defaultMessage: "Save to Notes",
        }),
      };
    case "new_chat":
      return {
        verb: intl.formatMessage({
          id: "inbox.inboxPresentation.startChat",
          defaultMessage: "Start chat",
        }),
        target: action.projectId
          ? intl.formatMessage(
              {
                id: "inbox.inboxPresentation.newChatInValue",
                defaultMessage: "New chat in {value1}",
              },
              {
                value1:
                  context.targetProjectName ??
                  intl.formatMessage({
                    id: "inbox.inboxPresentation.projectFallback",
                    defaultMessage: "Project",
                  }),
              },
            )
          : intl.formatMessage({
              id: "inbox.inboxPresentation.newProjectlessChat",
              defaultMessage: "New projectless chat",
            }),
      };
    case "send_to_chat": {
      const title = context.chat
        ? presentSessionTitle(context.chat, intl)
        : intl.formatMessage({
            id: "inbox.inboxPresentation.chatFallback",
            defaultMessage: "chat",
          });
      return {
        verb:
          context.chat?.status?.statusType === "active"
            ? intl.formatMessage({
                id: "inbox.inboxPresentation.queue",
                defaultMessage: "Queue",
              })
            : intl.formatMessage({
                id: "inbox.inboxPresentation.send",
                defaultMessage: "Send",
              }),
        target:
          context.chat?.status?.statusType === "active"
            ? intl.formatMessage(
                {
                  id: "inbox.inboxPresentation.sendToValueAfterIt",
                  defaultMessage: "Send to “{value1}” after it finishes",
                },
                { value1: title },
              )
            : intl.formatMessage(
                { id: "inbox.inboxPresentation.sendToValue", defaultMessage: "Send to “{value1}”" },
                { value1: title },
              ),
      };
    }
    case "move_to_project":
      return {
        verb: intl.formatMessage({
          id: "inbox.inboxPresentation.move",
          defaultMessage: "Move",
        }),
        target: intl.formatMessage(
          { id: "inbox.inboxPresentation.moveToValue", defaultMessage: "Move to {value1}" },
          {
            value1:
              context.targetProjectName ??
              intl.formatMessage({
                id: "inbox.inboxPresentation.projectFallback",
                defaultMessage: "Project",
              }),
          },
        ),
      };
    case "execute_decision":
      return {
        verb: intl.formatMessage({ id: "inbox.inboxPresentation.run", defaultMessage: "Run" }),
        // A Heartbeat continues its chat; a Cron run starts in its Project or on its own.
        target: context.chat
          ? intl.formatMessage(
              { id: "inbox.inboxPresentation.runInValue", defaultMessage: "Run in “{value1}”" },
              { value1: presentSessionTitle(context.chat, intl) },
            )
          : context.targetProjectName
            ? intl.formatMessage(
                { id: "inbox.inboxPresentation.runInValue2", defaultMessage: "Run in {value1}" },
                { value1: context.targetProjectName },
              )
            : intl.formatMessage({
                id: "inbox.inboxPresentation.runWithoutAProject",
                defaultMessage: "Run without a Project",
              }),
      };
  }
}

const formatDecisionTime = (at: number, now: Date): string => {
  const date = new Date(at);
  const time = getIntl().formatTime(date, { hour: "numeric", minute: "2-digit" });
  const day = startOfDay(date).getTime();
  if (day === startOfDay(now).getTime()) return time;
  return getIntl().formatMessage(
    { id: "inbox.inboxPresentation.valueValue", defaultMessage: "{value1}, {value2}" },
    { value1: inboxDayLabel(date, now), value2: time },
  );
};

/**
 * How an automation's waiting run will go, in one quiet line beneath its instructions: when it
 * fell due, how often it has since, and where it runs. Its instructions are the message itself.
 */
export function describeInboxAutomationDecision(
  automationDecision: InboxAutomationDecision,
  task: Pick<Automation, "kind" | "projectId" | "executionEnvironment" | "cwds"> | null,
  now: Date,
  intl: IntlShape = getIntl(),
): string {
  const dueCount = automationDecision.missedCount + 1;
  const due =
    dueCount > 1
      ? intl.formatMessage(
          {
            id: "inbox.inboxPresentation.dueValueTimesSinceValue",
            defaultMessage: "Due {value1} times since {value2}",
          },
          {
            value1: dueCount,
            value2: formatDecisionTime(automationDecision.firstScheduledFor, now),
          },
        )
      : intl.formatMessage(
          { id: "inbox.inboxPresentation.dueValue", defaultMessage: "Due {value1}" },
          { value1: formatDecisionTime(automationDecision.firstScheduledFor, now) },
        );
  if (!task) return due;
  const where =
    task.kind === "heartbeat"
      ? intl.formatMessage({
          id: "inbox.inboxPresentation.continuesItsChat",
          defaultMessage: "Continues its chat",
        })
      : task.projectId === null
        ? intl.formatMessage({
            id: "inbox.inboxPresentation.newWorkspace",
            defaultMessage: "New workspace",
          })
        : [
            task.executionEnvironment === "worktree"
              ? intl.formatMessage({
                  id: "inbox.inboxPresentation.worktree",
                  defaultMessage: "Worktree",
                })
              : intl.formatMessage({
                  id: "inbox.inboxPresentation.local",
                  defaultMessage: "Local",
                }),
            task.cwds.length > 1
              ? intl.formatMessage(
                  {
                    id: "inbox.inboxPresentation.valueFolders",
                    defaultMessage: "{value1} folders",
                  },
                  { value1: task.cwds.length },
                )
              : null,
          ]
            .filter(Boolean)
            .join(" · ");
  return `${due} · ${where}`;
}

export type InboxChatTone = "working" | "attention" | "error" | "quiet";

export interface InboxChatStatusPresentation {
  readonly label: string;
  readonly tone: InboxChatTone;
  /** The chat is still working, waiting on the user, or holds a reply they have not read. */
  readonly inProgress: boolean;
}

/**
 * A Runtime-bound chat reports its live Session activity (`live`); a native chat reports its
 * Core Thread status. A reply the user has not read keeps either in progress.
 */
export function describeInboxChatStatus(
  chat: InboxChat | null,
  live: SessionLiveIndicator | null = null,
  intl = getIntl(),
): InboxChatStatusPresentation {
  if (!chat)
    return {
      label: intl.formatMessage({
        id: "inbox.inboxPresentation.chatUnavailable",
        defaultMessage: "Chat unavailable",
      }),
      tone: "error",
      inProgress: false,
    };
  if (chat.archived)
    return {
      label: intl.formatMessage({
        id: "inbox.inboxPresentation.archived",
        defaultMessage: "Archived",
      }),
      tone: "quiet",
      inProgress: false,
    };
  if (chat.executionRef) {
    if (live === "approval")
      return {
        label: intl.formatMessage({
          id: "inbox.inboxPresentation.needsApproval",
          defaultMessage: "Needs approval",
        }),
        tone: "attention",
        inProgress: true,
      };
    if (live === "waiting")
      return {
        label: intl.formatMessage({
          id: "inbox.inboxPresentation.needsInput",
          defaultMessage: "Needs input",
        }),
        tone: "attention",
        inProgress: true,
      };
    if (live)
      return {
        label: intl.formatMessage({
          id: "inbox.inboxPresentation.working",
          defaultMessage: "Working",
        }),
        tone: "working",
        inProgress: true,
      };
  } else {
    const status = chat.status;
    if (!status)
      return {
        label: intl.formatMessage({
          id: "inbox.inboxPresentation.starting",
          defaultMessage: "Starting",
        }),
        tone: "working",
        inProgress: true,
      };
    if (status.activeFlags.includes("waitingOnApproval")) {
      return {
        label: intl.formatMessage({
          id: "inbox.inboxPresentation.needsApproval",
          defaultMessage: "Needs approval",
        }),
        tone: "attention",
        inProgress: true,
      };
    }
    if (status.activeFlags.includes("waitingOnUserInput")) {
      return {
        label: intl.formatMessage({
          id: "inbox.inboxPresentation.needsInput",
          defaultMessage: "Needs input",
        }),
        tone: "attention",
        inProgress: true,
      };
    }
    if (status.statusType === "active") {
      return {
        label: intl.formatMessage({
          id: "inbox.inboxPresentation.working",
          defaultMessage: "Working",
        }),
        tone: "working",
        inProgress: true,
      };
    }
    if (status.statusType === "systemError") {
      return {
        label: intl.formatMessage({
          id: "inbox.inboxPresentation.error",
          defaultMessage: "Error",
        }),
        tone: "error",
        inProgress: true,
      };
    }
  }
  return chat.unread
    ? {
        label: intl.formatMessage({
          id: "inbox.inboxPresentation.newReply",
          defaultMessage: "New reply",
        }),
        tone: "attention",
        inProgress: true,
      }
    : {
        label: intl.formatMessage({
          id: "inbox.inboxPresentation.idle",
          defaultMessage: "Idle",
        }),
        tone: "quiet",
        inProgress: false,
      };
}

export const INBOX_KIND_LABELS: Readonly<Record<InboxEntryKind, MessageDescriptor>> = {
  note: defineMessage({ id: "inbox.inboxPresentation.note", defaultMessage: "Note" }),
  todo: defineMessage({ id: "inbox.inboxPresentation.todo", defaultMessage: "Todo" }),
  question: defineMessage({ id: "inbox.inboxPresentation.question", defaultMessage: "Question" }),
};

export interface DaySection<Item> {
  readonly key: string;
  readonly label: string;
  readonly items: readonly Item[];
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

export function inboxDayLabel(date: Date, now: Date): string {
  const days = Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000);
  if (days === 0)
    return getIntl().formatMessage({
      id: "inbox.inboxPresentation.today",
      defaultMessage: "Today",
    });
  if (days === 1)
    return getIntl().formatMessage({
      id: "inbox.inboxPresentation.yesterday",
      defaultMessage: "Yesterday",
    });
  if (days > 1 && days < 7) {
    return getIntl().formatDate(date, { weekday: "long" });
  }
  return getIntl().formatDate(date, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Groups ordered items into local-day sections by when each happened, keeping their order. */
export function groupByDay<Item>(
  items: readonly Item[],
  at: (item: Item) => string,
  now: Date,
): readonly DaySection<Item>[] {
  const sections: { key: string; label: string; items: Item[] }[] = [];
  for (const item of items) {
    const date = new Date(at(item));
    const key = startOfDay(date).toISOString();
    const current = sections.at(-1);
    if (current?.key === key) {
      current.items.push(item);
    } else {
      sections.push({ key, label: inboxDayLabel(date, now), items: [item] });
    }
  }
  return sections;
}

/** Expired proof cannot tell us whether the earlier command was committed. */
export const inboxReceiptNeedsReview = (error: unknown): boolean =>
  error instanceof CoreApiError &&
  (error.code === "idempotency_window_expired" || error.code === "legacy_idempotency_unavailable");

/**
 * When a message entered the stream where it now sits: when it was sent, or when it last came
 * back, from Snooze or from a chat that returned it.
 */
export const inboxStreamTime = (item: InboxItem): string => {
  const until = item.snooze?.until;
  const returned = [
    until && Date.parse(until) <= Date.now() ? until : null,
    item.handback?.returned_at,
  ].filter((at): at is string => typeof at === "string");
  return returned.length > 0
    ? returned.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b))
    : item.submittedAt;
};

/**
 * Where the oldest-first Inbox stream shows a centered time, as a conversation does: above
 * the first message once it is over an hour old, and above any message sent over an hour
 * after the one before it. Each message's own time waits for a hover.
 */
export function inboxTimestampSeparators(
  items: readonly InboxItem[],
  nowMs: number,
): Array<number | null> {
  return items.map((item, index) => {
    const sentAtMs = Date.parse(inboxStreamTime(item));
    if (!Number.isFinite(sentAtMs)) return null;
    const previous = items[index - 1];
    const sinceMs = previous ? sentAtMs - Date.parse(inboxStreamTime(previous)) : nowMs - sentAtMs;
    return sinceMs > USER_TURN_TIMESTAMP_GAP_MS ? sentAtMs : null;
  });
}

/** The decision run that made a Nodex decision in Activity, when Core recorded it. */
export const activityDecisionSessionId = (row: Pick<ActivityRow, "evidence">): string | null => {
  const evidence = row.evidence;
  if (typeof evidence !== "object" || evidence === null) return null;
  const id = (evidence as { readonly decision_session_id?: unknown }).decision_session_id;
  return typeof id === "string" && id.length > 0 ? id : null;
};

export const formatInboxTime = (at: string, intl: IntlShape = getIntl()): string =>
  intl.formatTime(at, { hour: "numeric", minute: "2-digit" });

/** The important message the stream points back to, with where it stands among them. */
export interface InboxBuriedImportant {
  readonly message: InboxImportantMessage;
  /** Its place among the Inbox's important messages, oldest first, counting from 1. */
  readonly position: number;
  readonly total: number;
}

/**
 * The longest-waiting important message out of view, or null when every one is in view. What
 * waits longest is what is easiest to let slip, so it is the one worth pointing back to.
 */
export function inboxBuriedImportant(
  important: readonly InboxImportantMessage[],
  total: number,
  inView: (pageId: string) => boolean,
): InboxBuriedImportant | null {
  const index = important.findIndex((message) => !inView(message.pageId));
  const message = important[index];
  return message ? { message, position: index + 1, total } : null;
}

/** An example of what routing preferences say, wherever they are written. */
export const INBOX_ROUTING_PREFERENCES_PLACEHOLDER = defineMessage({
  id: "inbox.inboxPresentation.researchAndComparisonsGoTo",
  defaultMessage:
    "Research and comparisons go to new read-only chats. UI fixes for Nodex go to the Nodex Project.",
});

/** Problems own failure evidence rather than a Page; Page projections admit the other row kinds. */
export const inboxChatPageIds = (items: readonly InboxItem[]): readonly string[] =>
  items
    .filter((item) => item.rowKind !== "problem")
    .flatMap((item) =>
      item.source.kind === "nodex" && item.source.subjectPageId
        ? [item.pageId, item.source.subjectPageId]
        : [item.pageId],
    );
