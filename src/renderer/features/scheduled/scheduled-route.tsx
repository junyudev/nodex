import { useEffect, useState, type FormEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  AutomationTemplateColorIcon,
  ChevronRightIcon,
  UpArrowIcon,
} from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { AppShellHeaderContentRegistrar } from "@/lib/workbench-ui-scopes";
import type { CodexScheduledAutomation, Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import { THREAD_VISUAL_TOKENS } from "@/features/local-conversation/view/blocks/local-conversation-visual-tokens";
import {
  CopyMessageActionButton,
  MessageTimestamp,
  ThreadMessageActionRow,
} from "@/features/local-conversation/view/shared/thread-message-actions";
import {
  WORKBENCH_AUTOMATION_TEMPLATES,
  type WorkbenchAutomationTemplate,
} from "@/components/workbench/workbench-automation-templates";
import {
  buildAutomationsPath,
  resolveAutomationsRouteState,
} from "@/lib/workbench-automations-routes";
import type { ScheduledTaskChatOption } from "./scheduled-task-fields";
import { ScheduledTaskDialog, type ScheduledTaskDialogRequest } from "./scheduled-task-dialog";
import {
  formatScheduledTaskConfirmation,
  formatScheduledTaskScheduleLabel,
} from "./scheduled-task-model";
import type { ScheduledTasks } from "./use-scheduled-tasks";

export interface ScheduledRouteProps {
  readonly path: string;
  readonly tasks: ScheduledTasks;
  readonly projects: readonly Project[];
  readonly chats: readonly ScheduledTaskChatOption[];
  readonly onNavigate: (path: string, options?: { readonly replace?: boolean }) => void;
  readonly onOpenHeartbeatChat: (task: CodexScheduledAutomation) => void;
  readonly onReplyAboutTask: (task: CodexScheduledAutomation, message: string) => Promise<void>;
  readonly onOpenLocalEnvironmentsSettings?: (input: {
    projectId: string | null;
    configPath: string | null;
  }) => void;
}

const FEATURED_TEMPLATE_COUNT = 6;

function templateSummary(template: WorkbenchAutomationTemplate): string {
  return (
    template.prompt
      .split(/\r?\n/u)
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

function ScheduledLanding({ onUseTemplate }: { onUseTemplate: (templateId: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const templates = showAll
    ? WORKBENCH_AUTOMATION_TEMPLATES
    : WORKBENCH_AUTOMATION_TEMPLATES.slice(0, FEATURED_TEMPLATE_COUNT);
  return (
    <div className="@container h-full min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto flex min-h-full w-full max-w-[46.125rem] flex-col justify-center gap-11 px-6 pt-10 pb-11 select-none">
        <header className="flex flex-col items-center gap-3 text-center">
          <span aria-hidden="true" className="text-[44px] leading-none">
            🕗
          </span>
          <div className="flex flex-col items-center gap-0.5">
            <h1 className="text-[18px] leading-[26px] font-normal tracking-[-0.025em] text-token-foreground">
              Schedule a task
            </h1>
            <p className="text-[14px] leading-5 tracking-[-0.01em] text-token-description-foreground">
              Nodex can take care of ongoing tasks so you don’t have to.
            </p>
          </div>
        </header>
        <div className="flex flex-col items-center gap-4">
          <ul
            aria-label="Suggested tasks"
            className="grid w-full grid-cols-2 gap-3 @max-[560px]:grid-cols-1"
          >
            {templates.map((template) => (
              <li key={template.id} className="flex">
                <button
                  type="button"
                  className="flex w-full cursor-interaction items-start gap-4 rounded-[24px] border border-dashed border-token-foreground/[0.08] p-5 text-left outline-none hover:border-solid hover:bg-token-foreground/[0.025] focus-visible:ring-2 focus-visible:ring-token-focus-border motion-safe:transition-colors"
                  onClick={() => onUseTemplate(template.id)}
                >
                  <AutomationTemplateColorIcon
                    iconName={template.iconName}
                    className="mt-[3px] size-5 shrink-0"
                  />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-[16px] leading-[26px] tracking-[-0.02em] text-token-foreground">
                      {template.name}
                    </span>
                    <span className="line-clamp-2 text-[14px] leading-5 text-token-description-foreground">
                      {templateSummary(template)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {WORKBENCH_AUTOMATION_TEMPLATES.length > FEATURED_TEMPLATE_COUNT ? (
            <NodexButton variant="ghost" size="sm" onClick={() => setShowAll((all) => !all)}>
              {showAll ? "Show fewer" : "Show more"}
            </NodexButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ReplyComposer({ onSend }: { onSend: (message: string) => Promise<void> }) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const trimmed = message.trim();
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setMessage("");
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className="flex items-end gap-2 rounded-[22px] border border-token-border bg-token-main-surface-primary py-2 ps-4 pe-2 shadow-[0_4px_16px_-8px_rgb(0_0_0/0.12)]"
      onSubmit={(event) => void send(event)}
    >
      <textarea
        aria-label="Reply about this task"
        placeholder="Reply about this task…"
        rows={1}
        value={message}
        disabled={sending}
        className="max-h-40 min-h-7 flex-1 resize-none bg-transparent py-1 text-sm leading-5 text-token-foreground outline-none [field-sizing:content] placeholder:text-token-text-tertiary"
        onChange={(event) => setMessage(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void send();
        }}
      />
      <button
        type="submit"
        aria-label="Send reply"
        disabled={!trimmed || sending}
        className="flex size-7 shrink-0 cursor-interaction items-center justify-center rounded-full bg-token-foreground text-token-dropdown-background disabled:cursor-default disabled:opacity-30"
      >
        <UpArrowIcon className="icon-xs" />
      </button>
    </form>
  );
}

/**
 * A selected task reads as the conversation that set it up: its instructions, the confirmation of
 * its next run, and a card that opens its settings.
 */
function ScheduledTaskConversation({
  task,
  isNew,
  onEdit,
  onReply,
}: {
  task: CodexScheduledAutomation;
  isNew: boolean;
  onEdit: () => void;
  onReply: (message: string) => Promise<void>;
}) {
  const reducedMotion = useReducedMotion();
  const animate = isNew && !reducedMotion;
  const confirmation = formatScheduledTaskConfirmation(task);
  const paused = task.status === "PAUSED";
  const enter = (delay: number) =>
    animate
      ? {
          initial: { opacity: 0, y: 8 },
          animate: { opacity: 1, y: 0 },
          transition: { delay, duration: 0.3, ease: "easeOut" as const },
        }
      : {};

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AppShellHeaderContentRegistrar
        content={
          <span className="truncate text-sm font-medium text-token-foreground">{task.name}</span>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto flex w-full max-w-(--thread-content-max-width) flex-col gap-6 px-toolbar pt-8 pb-10">
          <motion.div className="group flex flex-col items-end gap-1" {...enter(0)}>
            <div className={cn(THREAD_VISUAL_TOKENS.userBubble, "whitespace-pre-wrap")}>
              {task.prompt}
            </div>
            <ThreadMessageActionRow align="end">
              <MessageTimestamp sentAtMs={task.updatedAt} variant="user" />
            </ThreadMessageActionRow>
          </motion.div>
          <motion.div className="group flex flex-col gap-3" {...enter(0.35)}>
            <p className={THREAD_VISUAL_TOKENS.assistantBody}>{confirmation}</p>
            <motion.div {...enter(0.6)}>
              <button
                type="button"
                aria-label={`${task.name} settings`}
                className="flex w-full max-w-md cursor-interaction items-center gap-3 rounded-2xl border border-token-border px-4 py-3 text-left outline-none hover:bg-token-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-token-focus-border"
                onClick={onEdit}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm text-token-foreground">{task.name}</span>
                  <span className="truncate text-xs text-token-description-foreground">
                    {[
                      paused ? "Paused" : formatScheduledTaskScheduleLabel(task),
                      task.launch === "ask" ? "Asks in Inbox" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <ChevronRightIcon className="icon-xs shrink-0 text-token-text-tertiary" />
              </button>
              <ThreadMessageActionRow align="start">
                <span className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                  <CopyMessageActionButton
                    text={confirmation}
                    label="Copy response"
                    tooltipLabel="Copy response"
                  />
                </span>
              </ThreadMessageActionRow>
            </motion.div>
          </motion.div>
        </div>
      </div>
      <div className="mx-auto w-full max-w-(--thread-content-max-width) shrink-0 px-toolbar pb-4">
        <ReplyComposer onSend={onReply} />
      </div>
    </div>
  );
}

function findTemplate(templateId: string | null): WorkbenchAutomationTemplate | null {
  return WORKBENCH_AUTOMATION_TEMPLATES.find((template) => template.id === templateId) ?? null;
}

/**
 * The Scheduled main pane: suggested tasks, or the selected task's conversation, with the create
 * and edit dialog over either. Runs and Heartbeat chats are presented by the session route.
 */
export function ScheduledRoute({
  path,
  tasks,
  projects,
  chats,
  onNavigate,
  onOpenHeartbeatChat,
  onReplyAboutTask,
  onOpenLocalEnvironmentsSettings,
}: ScheduledRouteProps) {
  const route = resolveAutomationsRouteState(path);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const selected =
    route.automationId === null
      ? null
      : (tasks.tasks.find((task) => task.id === route.automationId && task.status !== "DELETED") ??
        null);
  const missingSelection = route.automationId !== null && selected === null && !tasks.isLoading;
  const heartbeatSelected = selected?.kind === "heartbeat" && route.automationMode === null;

  useEffect(() => {
    if (missingSelection) onNavigate(buildAutomationsPath(), { replace: true });
  }, [missingSelection, onNavigate]);

  useEffect(() => {
    if (heartbeatSelected && selected) onOpenHeartbeatChat(selected);
  }, [heartbeatSelected, onOpenHeartbeatChat, selected]);

  let request: ScheduledTaskDialogRequest | null = null;
  if (route.automationMode === "create") {
    request = {
      kind: "create",
      template: findTemplate(route.templateId),
    };
  } else if (route.automationMode === "edit" && selected) {
    request = { kind: "edit", task: selected };
  }

  return (
    <div data-testid="scheduled-route" className="flex h-full min-h-0 w-full flex-col">
      {selected && selected.kind === "cron" ? (
        <ScheduledTaskConversation
          key={selected.id}
          task={selected}
          isNew={selected.id === createdTaskId}
          onEdit={() =>
            onNavigate(buildAutomationsPath({ automationId: selected.id, automationMode: "edit" }))
          }
          onReply={(message) => onReplyAboutTask(selected, message)}
        />
      ) : (
        <ScheduledLanding
          onUseTemplate={(templateId) =>
            onNavigate(buildAutomationsPath({ automationMode: "create", templateId }))
          }
        />
      )}
      <ScheduledTaskDialog
        request={request}
        tasks={tasks}
        projects={projects}
        chats={chats}
        onClose={() =>
          onNavigate(buildAutomationsPath({ automationId: route.automationId }), { replace: true })
        }
        onCreated={(task) => {
          setCreatedTaskId(task.id);
          onNavigate(buildAutomationsPath({ automationId: task.id }), { replace: true });
        }}
        onOpenLocalEnvironmentsSettings={onOpenLocalEnvironmentsSettings}
      />
    </div>
  );
}
