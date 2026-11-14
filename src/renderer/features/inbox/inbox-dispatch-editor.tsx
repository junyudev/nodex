import { useInboxSkillAvailability, InboxSkillToggles } from "./inbox-skill-review";
import { useMemo, useState, type ReactNode, type ComponentProps } from "react";
import type {
  InboxDispatchAction,
  InboxChat,
  InboxAgentChoice,
  InboxItem,
  InboxProposal,
  InboxPageBasis,
  InboxSuggestedSkill,
} from "../../../shared/inbox";
import type { Project } from "../../../shared/types";
import { messageTextOf } from "../../../shared/message-content";
import { NodexButton } from "@/components/ui/button";
import { NodexOptionPicker } from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { CompactChevronDownIcon, WorktreeStatusIcon } from "@/components/shared/icons";
import {
  LIBRARY_INBOX,
  inboxActionSkills,
  inboxNewChatAction,
  inboxPromptWithAdditions,
  projectInbox,
} from "../../../shared/inbox";
import { useInboxChatTargets } from "./use-inbox";
import { cn } from "@/lib/utils";
import { INBOX_ACTION_ICONS } from "./inbox-icon-action";
import { InboxAgentPicker, type InboxAgents } from "./inbox-agent-picker";
import { sameInboxAgentChoice } from "./inbox-agent-model";

type ActionType = InboxDispatchAction["type"];

const ACTION_LABELS: Readonly<Record<ActionType, string>> = {
  plan: "Plan",
  execute_decision: "Run",
  keep: "Add to Todo",
  save_to_notes: "Save to Notes",
  later: "Later",
  new_chat: "New chat",
  send_to_chat: "Send to chat",
  move_to_project: "Move to Project",
};

const CONFIRM_LABELS: Readonly<Record<ActionType, string>> = {
  plan: "Start plan",
  execute_decision: "Run",
  keep: "Add to Todo",
  save_to_notes: "Save to Notes",
  later: "Later",
  new_chat: "Start chat",
  send_to_chat: "Send",
  move_to_project: "Move",
};

/** The Automation action a held decision can still be admitted to. */
export interface InboxDispatchAutomationDecision {
  readonly automationId: string;
  /** The Automation's Agent; an admission may choose another Agent for this decision only. */
  readonly taskAgent: InboxAgentChoice | null;
  /** A Heartbeat continues its own chat on its own Agent. */
  readonly heartbeat: boolean;
}

/**
 * A held decision admits its Automation action or is handed on like any message. Skipping it is
 * `Mark done`, so it offers no Keep. Other messages cannot admit an Automation action.
 */
const actionTypesFor = (decisionId: string | null | undefined): readonly ActionType[] =>
  (Object.keys(ACTION_LABELS) as ActionType[]).filter(
    (type) =>
      type !== "plan" &&
      type !== "later" &&
      (decisionId ? type !== "keep" && type !== "save_to_notes" : type !== "execute_decision"),
  );

export interface InboxDispatchDraft {
  readonly remindAt?: string;
  readonly parentPageId?: string | null;
  readonly plan?: Extract<InboxDispatchAction, { type: "plan" }>;
  readonly proposal?: InboxProposal;
  readonly chat?: InboxChat | null;
  readonly basis?: readonly InboxPageBasis[];
  readonly type: ActionType;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly prompt: string;
  readonly skills?: readonly InboxSuggestedSkill[];
  readonly droppedSkillNames?: readonly string[];
  /** What a new chat runs on when chosen for this decision; the Inbox's own when unset. */
  readonly agent?: InboxAgentChoice | null;
  /** Whether a new chat runs in its Page's worktree; the Inbox's setting when unset. */
  readonly worktree?: boolean | null;
  /** The immutable decision being reviewed, independent of its originating Automation. */
  readonly decisionId?: string | null;
  /** Present for an automation's waiting run, which can run its task. */
  readonly automationDecision?: InboxDispatchAutomationDecision | null;
}

export function draftFromAction(
  action: InboxDispatchAction,
  fallbackPrompt: string,
): InboxDispatchDraft {
  switch (action.type) {
    case "plan":
      return {
        type: "plan",
        plan: action,
        projectId: null,
        sessionId: null,
        prompt: fallbackPrompt,
      };
    case "later":
      return {
        type: "later",
        remindAt: action.remindAt,
        projectId: null,
        sessionId: null,
        prompt: fallbackPrompt,
      };
    case "save_to_notes":
      return {
        type: "save_to_notes",
        parentPageId: action.parentPageId,
        projectId: null,
        sessionId: null,
        prompt: fallbackPrompt,
      };
    case "keep":
      return { type: "keep", projectId: null, sessionId: null, prompt: fallbackPrompt };
    // The editor writes plain text: the additions kept on the row become paragraphs of it.
    case "new_chat":
      return {
        type: "new_chat",
        projectId: action.projectId,
        sessionId: null,
        prompt: inboxPromptWithAdditions(action.prompt, action.additions),
        ...(action.skills?.length ? { skills: action.skills } : {}),
        agent: action.agent,
        worktree: action.worktree ?? null,
      };
    case "send_to_chat":
      return {
        type: "send_to_chat",
        projectId: null,
        sessionId: action.sessionId,
        prompt: inboxPromptWithAdditions(action.prompt, action.additions),
        ...(action.skills?.length ? { skills: action.skills } : {}),
      };
    case "move_to_project":
      return {
        type: "move_to_project",
        projectId: action.projectId,
        sessionId: null,
        prompt: fallbackPrompt,
      };
    case "execute_decision":
      return {
        type: "execute_decision",
        decisionId: action.decisionId,
        projectId: null,
        sessionId: null,
        prompt: fallbackPrompt,
        agent: action.agent,
      };
  }
}

/**
 * A new decision still reviews the complete source group of the previous handoff. It starts
 * from the action as the row has it, including a model chosen there and the additions kept.
 */
export function draftForInboxItem(
  item: InboxItem,
  projectId: string | null,
  edited: InboxDispatchAction | null = null,
  automationDecision: InboxDispatchAutomationDecision | null = null,
  droppedSkillNames?: readonly string[],
): InboxDispatchDraft {
  const proposal = item.proposal;
  const action = edited ?? proposal?.action;
  const draft = draftFromAction(
    action ?? inboxNewChatAction(projectId, messageTextOf(item.body)),
    messageTextOf(item.body),
  );
  return {
    ...draft,
    ...(proposal?.state !== "open" && draft.skills ? { skills: [] } : {}),
    basis: proposal?.basis ?? [item.basis],
    chat: proposal?.chat ?? null,
    decisionId:
      action?.type === "execute_decision"
        ? action.decisionId
        : (item.automationDecision?.dispatchId ?? null),
    automationDecision,
    ...(droppedSkillNames?.length ? { droppedSkillNames } : {}),
    ...(proposal?.state === "open" ? { proposal } : {}),
  };
}

/** Returns the exact action a draft authorizes, or null while it is incomplete. */
export function actionFromDraft(draft: InboxDispatchDraft): InboxDispatchAction | null {
  const prompt = draft.prompt.trim();
  switch (draft.type) {
    case "plan":
      return draft.plan ?? null;
    case "later":
      return draft.remindAt ? { type: "later", remindAt: draft.remindAt } : null;
    case "save_to_notes":
      return { type: "save_to_notes", parentPageId: draft.parentPageId ?? null };
    case "keep":
      return { type: "keep" };
    case "new_chat":
      return prompt
        ? {
            type: "new_chat",
            projectId: draft.projectId,
            prompt,
            agent: draft.agent ?? null,
            worktree: draft.worktree ?? null,
            additions: [],
            ...(draft.skills?.length ? { skills: draft.skills } : {}),
          }
        : null;
    case "send_to_chat":
      return prompt && draft.sessionId
        ? {
            type: "send_to_chat",
            sessionId: draft.sessionId,
            prompt,
            additions: [],
            ...(draft.skills?.length ? { skills: draft.skills } : {}),
          }
        : null;
    case "move_to_project":
      return draft.projectId ? { type: "move_to_project", projectId: draft.projectId } : null;
    case "execute_decision":
      return draft.decisionId
        ? {
            type: "execute_decision",
            decisionId: draft.decisionId,
            agent: draft.agent ?? null,
          }
        : null;
  }
}

function PickerTrigger({
  label,
  children,
  ...buttonProps
}: ComponentProps<"button"> & {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <button
      {...buttonProps}
      type="button"
      aria-label={label}
      className="cursor-interaction inline-flex h-7 max-w-[240px] min-w-0 items-center gap-1 rounded-lg px-2 text-sm text-token-foreground hover:bg-token-list-hover-background"
    >
      <span className="min-w-0 truncate">{children}</span>
      <CompactChevronDownIcon className="icon-2xs shrink-0 text-token-description-foreground" />
    </button>
  );
}

/**
 * Two places a chat can run need no menu: the chip is lit when the chat gets its Page's
 * worktree and quiet when it runs in the Project's checkout.
 */
function WorktreeToggle({
  on,
  onChange,
}: {
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <NodexTooltip
      tooltipContent={
        on
          ? "Runs in its Page’s worktree, apart from your checkout"
          : "Runs in the Project’s checkout"
      }
      side="top"
    >
      <button
        type="button"
        aria-label="Worktree"
        aria-pressed={on}
        onClick={() => onChange(!on)}
        className={cn(
          "inline-flex h-6 shrink-0 cursor-interaction items-center gap-1 rounded-md ps-1.5 pe-2 text-xs outline-hidden transition-[background-color,color,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-token-focus-border active:scale-[0.97] motion-reduce:transition-none",
          on
            ? "bg-token-foreground/8 text-token-foreground hover:bg-token-foreground/12"
            : "text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground",
        )}
      >
        <WorktreeStatusIcon className={cn("icon-2xs shrink-0", !on && "opacity-60")} />
        Worktree
      </button>
    </NodexTooltip>
  );
}

/**
 * Edits the exact action a user authorizes. The same form serves suggested and hand-written
 * dispatches, so there is one way to say where a message goes. In a Project's Inbox, chats
 * start or continue in that Project, and moving files the message into another Project.
 */
export function InboxDispatchEditor({
  initial,
  projects,
  agents,
  inboxProjectId = null,
  embedded = false,
  onSubmit,
  onCancel,
  onEditTask,
}: {
  readonly initial: InboxDispatchDraft;
  /** What a new chat can run on, and the Inbox's own choice it starts from. */
  readonly agents: InboxAgents;
  /** Inside a message's strip the form takes the strip's frame instead of its own. */
  readonly embedded?: boolean;
  readonly projects: readonly Project[];
  /** The Project whose Inbox holds the messages, or null for the Library Inbox. */
  readonly inboxProjectId?: string | null;
  /** `chat` is the chosen chat when the action sends to one. */
  readonly onSubmit: (
    action: InboxDispatchAction,
    chat: InboxChat | null,
    droppedSkillNames?: readonly string[],
  ) => Promise<boolean>;
  readonly onCancel: () => void;
  /** Opens an automationDecision's task, where its folders, workspace and schedule change for every run. */
  readonly onEditTask?: (automationId: string) => void;
}) {
  const [draft, setDraft] = useState(() =>
    inboxProjectId !== null && initial.type === "new_chat"
      ? { ...initial, projectId: inboxProjectId }
      : initial,
  );
  const [submitting, setSubmitting] = useState(false);
  const activeProjects = useMemo(
    () => projects.filter((project) => project.lifecycle === "active"),
    [projects],
  );
  const [chatQuery, setChatQuery] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [selectedChat, setSelectedChat] = useState(initial.chat ?? initial.proposal?.chat ?? null);
  const chatTargets = useInboxChatTargets(
    inboxProjectId === null ? LIBRARY_INBOX : projectInbox(inboxProjectId),
    chatQuery,
    chatOpen,
  );
  const chats = (chatTargets.data?.pages ?? []).flatMap((page) => page.items);
  const choosableProjects =
    draft.type === "move_to_project" && inboxProjectId !== null
      ? activeProjects.filter((project) => project.id !== inboxProjectId)
      : activeProjects;
  const selectType = (type: ActionType) =>
    setDraft((current) => ({
      ...current,
      type,
      projectId:
        inboxProjectId === null
          ? current.projectId
          : type === "new_chat"
            ? inboxProjectId
            : type === "move_to_project" && current.projectId === inboxProjectId
              ? null
              : current.projectId,
    }));
  const action = actionFromDraft(draft);
  const worktreeOn = draft.worktree ?? agents.settings.newChatsUseWorktrees;
  const skillAvailability = useInboxSkillAvailability(draft.proposal, action);
  const droppedSkillNames = [
    ...new Set([...(draft.droppedSkillNames ?? []), ...skillAvailability.unavailable]),
  ];
  const projectName = (projectId: string | null) =>
    projectId === null
      ? "No Project"
      : (activeProjects.find((project) => project.id === projectId)?.name ?? "Choose a Project");
  const chosenChat =
    chats.find((chat) => chat.sessionId === draft.sessionId) ??
    (selectedChat?.sessionId === draft.sessionId ? selectedChat : null);
  const chatTitle =
    chosenChat?.displayTitle ?? (draft.sessionId ? "Selected chat" : "Choose a chat");

  const submit = async () => {
    if (!action || skillAvailability.pending) return;
    setSubmitting(true);
    const chat = action.type === "send_to_chat" ? chosenChat : null;
    const done = droppedSkillNames.length
      ? await onSubmit(action, chat, droppedSkillNames)
      : await onSubmit(action, chat);
    setSubmitting(false);
    if (done) onCancel();
  };

  return (
    <div
      data-testid="inbox-dispatch-editor"
      className={cn(
        "flex w-full flex-col gap-2",
        embedded ? "min-w-[min(26rem,100%)] pb-0.5" : "rounded-2xl bg-token-foreground/4 p-2",
      )}
    >
      <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Action">
        {actionTypesFor(draft.decisionId).map((type) => {
          const Icon = INBOX_ACTION_ICONS[type];
          return (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={draft.type === type}
              onClick={() => selectType(type)}
              className={cn(
                "cursor-interaction inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-sm",
                draft.type === type
                  ? "bg-token-main-surface-primary text-token-foreground shadow-[0_0_0_0.5px_var(--color-token-border)]"
                  : "text-token-description-foreground hover:text-token-foreground",
              )}
            >
              <Icon className="icon-xs" />
              {ACTION_LABELS[type]}
            </button>
          );
        })}
      </div>

      {draft.type === "new_chat" && inboxProjectId !== null ? null : draft.type === "new_chat" ||
        draft.type === "move_to_project" ? (
        <div className="flex items-center gap-2 px-1 text-sm text-token-description-foreground">
          <span>Project</span>
          <NodexOptionPicker
            search="filter"
            searchAriaLabel="Search Projects"
            searchPlaceholder="Search Projects…"
            triggerButton={
              <PickerTrigger label="Project">{projectName(draft.projectId)}</PickerTrigger>
            }
            value={draft.projectId ?? "projectless"}
            options={[
              ...(draft.type === "new_chat" ? [{ value: "projectless", label: "No Project" }] : []),
              ...choosableProjects.map((project) => ({ value: project.id, label: project.name })),
            ]}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                projectId: value === "projectless" ? null : value,
              }))
            }
          />
        </div>
      ) : null}

      {draft.type === "send_to_chat" ? (
        <div className="flex items-center gap-2 px-1 text-sm text-token-description-foreground">
          <span>Chat</span>
          <NodexOptionPicker
            search="filter"
            filterOptions={false}
            onSearchChange={setChatQuery}
            open={chatOpen}
            onOpenChange={setChatOpen}
            searchAriaLabel="Search chats"
            searchPlaceholder="Search chats…"
            triggerButton={<PickerTrigger label="Chat">{chatTitle}</PickerTrigger>}
            value={draft.sessionId ?? ""}
            options={chats.flatMap((chat) =>
              chat.sessionId
                ? [
                    {
                      value: chat.sessionId,
                      label: chat.displayTitle,
                      subText: chat.projectName ?? "No Project",
                      searchText: `${chat.displayTitle} ${chat.projectName ?? ""}`,
                    },
                  ]
                : [],
            )}
            emptyMessage={
              chatTargets.isPending
                ? "Loading chats…"
                : chatTargets.error
                  ? "Couldn’t load chats"
                  : "No matching chats"
            }
            footer={
              chatTargets.error ? (
                <NodexButton size="xs" variant="ghost" onClick={() => void chatTargets.refetch()}>
                  Retry
                </NodexButton>
              ) : chatTargets.hasNextPage ? (
                <NodexButton
                  size="xs"
                  variant="ghost"
                  disabled={chatTargets.isFetchingNextPage}
                  onClick={() => void chatTargets.fetchNextPage()}
                >
                  More chats
                </NodexButton>
              ) : null
            }
            onValueChange={(sessionId) => {
              setSelectedChat(chats.find((chat) => chat.sessionId === sessionId) ?? null);
              setDraft((current) => ({ ...current, sessionId }));
            }}
            contentMaxHeight="tall"
          />
        </div>
      ) : null}

      {draft.type === "new_chat" || draft.type === "send_to_chat" ? (
        <textarea
          aria-label="Prompt"
          value={draft.prompt}
          rows={4}
          onChange={(event) => {
            const prompt = event.currentTarget.value;
            setDraft((current) => ({ ...current, prompt }));
          }}
          className="w-full resize-y rounded-xl bg-token-main-surface-primary px-3 py-2 text-sm leading-relaxed text-token-foreground outline-none shadow-[0_0_0_0.5px_var(--color-token-border)] focus-visible:shadow-[0_0_0_1px_var(--color-token-focus-border)]"
        />
      ) : null}

      {action &&
      draft.proposal &&
      (action.type === "new_chat" || action.type === "send_to_chat") ? (
        <InboxSkillToggles
          skills={inboxActionSkills(draft.proposal.action)}
          dropped={droppedSkillNames}
          unavailable={skillAvailability.unavailable}
          pending={skillAvailability.pending}
          onToggle={(name) =>
            setDraft((current) => {
              const dropped = current.droppedSkillNames ?? [];
              return {
                ...current,
                droppedSkillNames: dropped.includes(name)
                  ? dropped.filter((candidate) => candidate !== name)
                  : [...dropped, name],
              };
            })
          }
        />
      ) : null}
      {draft.type === "execute_decision" && draft.automationDecision ? (
        // The message is this run's instructions; everything else is the task's own.
        <div className="flex min-w-0 items-center gap-1 px-1 text-sm text-token-description-foreground">
          <span className="min-w-0 truncate">Runs with this message as its instructions</span>
          {onEditTask ? (
            <NodexButton
              size="xs"
              variant="ghost"
              className="shrink-0"
              onClick={() => onEditTask(draft.automationDecision!.automationId)}
            >
              Edit automation
            </NodexButton>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-w-0 items-center gap-1">
        {draft.type === "execute_decision" &&
        draft.automationDecision?.taskAgent &&
        !draft.automationDecision.heartbeat ? (
          // One run may use another model; the task keeps its own.
          <InboxAgentPicker
            agents={agents}
            purpose="chat"
            scope="message"
            value={draft.agent ?? draft.automationDecision.taskAgent}
            trigger="inline"
            onChange={(next) =>
              setDraft((current) => ({
                ...current,
                agent:
                  current.automationDecision?.taskAgent &&
                  sameInboxAgentChoice(next, current.automationDecision.taskAgent)
                    ? null
                    : next,
              }))
            }
          />
        ) : null}
        {draft.type === "new_chat" && (draft.worktree != null || agents.settingsReady) ? (
          // Whether the chat joins its Page's worktree sits beside the Agent it runs on.
          <WorktreeToggle
            on={worktreeOn}
            onChange={(worktree) =>
              setDraft((current) => ({
                ...current,
                worktree: worktree === agents.settings.newChatsUseWorktrees ? null : worktree,
              }))
            }
          />
        ) : null}
        {draft.type === "new_chat" && (draft.agent || agents.settingsReady) ? (
          // What the chat starts on sits beside the button that starts it, as in the composer.
          // Until the Inbox's settings arrive its default is unknown, so it is left out rather
          // than guessed; the chat still starts on that default.
          <InboxAgentPicker
            agents={agents}
            purpose="chat"
            scope="message"
            value={draft.agent ?? agents.settings.chatAgent}
            trigger="inline"
            onChange={(next) =>
              setDraft((current) => ({
                ...current,
                agent: sameInboxAgentChoice(next, agents.settings.chatAgent) ? null : next,
              }))
            }
          />
        ) : null}
        <NodexButton size="xs" variant="ghost" className="ms-auto" onClick={onCancel}>
          Cancel
        </NodexButton>
        <NodexButton
          size="xs"
          variant="primary"
          disabled={!action || submitting || skillAvailability.pending}
          onClick={() => void submit()}
        >
          {CONFIRM_LABELS[draft.type]}
        </NodexButton>
      </div>
    </div>
  );
}
