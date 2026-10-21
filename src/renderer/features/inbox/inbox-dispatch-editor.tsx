import { useMemo, useState, type ReactNode, type ComponentProps } from "react";
import type {
  InboxDispatchAction,
  InboxChat,
  InboxItem,
  InboxProposal,
  InboxPageBasis,
} from "../../../shared/inbox";
import type { Project } from "../../../shared/types";
import { messageTextOf } from "../../../shared/message-content";
import { NodexButton } from "@/components/ui/button";
import { NodexOptionPicker } from "@/components/ui/dropdown";
import { CompactChevronDownIcon } from "@/components/shared/icons";
import { LIBRARY_INBOX, projectInbox } from "../../../shared/inbox";
import { useInboxChatTargets } from "./use-inbox";
import { cn } from "@/lib/utils";
import { INBOX_ACTION_ICONS } from "./inbox-icon-action";

type ActionType = InboxDispatchAction["type"];

const ACTION_LABELS: Readonly<Record<ActionType, string>> = {
  keep: "Keep",
  new_chat: "New chat",
  send_to_chat: "Send to chat",
  move_to_project: "Move to Project",
};

const CONFIRM_LABELS: Readonly<Record<ActionType, string>> = {
  keep: "Keep",
  new_chat: "Start chat",
  send_to_chat: "Send",
  move_to_project: "Move",
};

export interface InboxDispatchDraft {
  readonly proposal?: InboxProposal;
  readonly chat?: InboxChat | null;
  readonly basis?: readonly InboxPageBasis[];
  readonly type: ActionType;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly prompt: string;
}

export function draftFromAction(
  action: InboxDispatchAction,
  fallbackPrompt: string,
): InboxDispatchDraft {
  switch (action.type) {
    case "keep":
      return { type: "keep", projectId: null, sessionId: null, prompt: fallbackPrompt };
    case "new_chat":
      return {
        type: "new_chat",
        projectId: action.projectId,
        sessionId: null,
        prompt: action.prompt,
      };
    case "send_to_chat":
      return {
        type: "send_to_chat",
        projectId: null,
        sessionId: action.sessionId,
        prompt: action.prompt,
      };
    case "move_to_project":
      return {
        type: "move_to_project",
        projectId: action.projectId,
        sessionId: null,
        prompt: fallbackPrompt,
      };
  }
}

/** A new decision still reviews the complete source group of the previous handoff. */
export function draftForInboxItem(item: InboxItem, projectId: string | null): InboxDispatchDraft {
  const proposal = item.proposal;
  const action = proposal?.action;
  return {
    ...draftFromAction(
      action ?? { type: "new_chat", projectId, prompt: messageTextOf(item.body) },
      messageTextOf(item.body),
    ),
    basis: proposal?.basis ?? [item.basis],
    chat: proposal?.chat ?? null,
    ...(proposal?.state === "open" ? { proposal } : {}),
  };
}

/** Returns the exact action a draft authorizes, or null while it is incomplete. */
export function actionFromDraft(draft: InboxDispatchDraft): InboxDispatchAction | null {
  const prompt = draft.prompt.trim();
  switch (draft.type) {
    case "keep":
      return { type: "keep" };
    case "new_chat":
      return prompt ? { type: "new_chat", projectId: draft.projectId, prompt } : null;
    case "send_to_chat":
      return prompt && draft.sessionId
        ? { type: "send_to_chat", sessionId: draft.sessionId, prompt }
        : null;
    case "move_to_project":
      return draft.projectId ? { type: "move_to_project", projectId: draft.projectId } : null;
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
 * Edits the exact action a user authorizes. The same form serves suggested and hand-written
 * dispatches, so there is one way to say where a message goes. In a Project's Inbox, chats
 * start or continue in that Project, and moving files the message into another Project.
 */
export function InboxDispatchEditor({
  initial,
  projects,
  inboxProjectId = null,
  embedded = false,
  onSubmit,
  onCancel,
}: {
  readonly initial: InboxDispatchDraft;
  /** Inside a message's strip the form takes the strip's frame instead of its own. */
  readonly embedded?: boolean;
  readonly projects: readonly Project[];
  /** The Project whose Inbox holds the messages, or null for the Library Inbox. */
  readonly inboxProjectId?: string | null;
  /** `chat` is the chosen chat when the action sends to one. */
  readonly onSubmit: (action: InboxDispatchAction, chat: InboxChat | null) => Promise<boolean>;
  readonly onCancel: () => void;
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
    if (!action) return;
    setSubmitting(true);
    const done = await onSubmit(action, action.type === "send_to_chat" ? chosenChat : null);
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
        {(Object.keys(ACTION_LABELS) as ActionType[]).map((type) => {
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

      <div className="flex items-center justify-end gap-1">
        <NodexButton size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </NodexButton>
        <NodexButton
          size="xs"
          variant="primary"
          disabled={!action || submitting}
          onClick={() => void submit()}
        >
          {CONFIRM_LABELS[draft.type]}
        </NodexButton>
      </div>
    </div>
  );
}
