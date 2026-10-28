import { useEffect, useState } from "react";
import { BellIcon, StopIcon, TerminalIcon } from "@/components/shared/icons";
import { CircleDotIcon, ListTree } from "@/components/shared/icons/generic-icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatElapsedSince, getNextElapsedTimeUpdateDelay } from "@/lib/elapsed-time";
import type {
  ConversationBackgroundTask,
  ConversationBackgroundTaskOutput,
  ConversationBackgroundTasks,
} from "../../thread-stage-types";
import { CodexShimmerText } from "../shared/codex-shimmer-text";
import { TerminalAnsiText } from "../shared/tools/terminal-ansi-text";
import { ThreadSummaryPanelRow } from "./thread-summary-panel-row";
import {
  ThreadSummaryPanelCountBadge,
  ThreadSummaryPanelSection,
} from "./thread-summary-panel-section";

const OUTPUT_REFRESH_MS = 2_000;

const KIND_LABELS: Record<ConversationBackgroundTask["kind"], string> = {
  command: "Shell command",
  monitor: "Monitor",
  task: "Background task",
};

/** Under a minute a task has just started; after that its age reads like the sidebar's. */
export function formatBackgroundTaskAge(startedAtMs: number, nowMs: number): string {
  return nowMs - startedAtMs < 60_000 ? "<1m" : formatElapsedSince(startedAtMs, nowMs);
}

function backgroundTaskTitle(task: ConversationBackgroundTask): string {
  return [
    task.label,
    task.owner ? `In ${task.owner}` : null,
    task.command && task.command !== task.label ? `$ ${task.command}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function BackgroundTaskLabel({ task }: { task: ConversationBackgroundTask }) {
  if (!task.owner) return task.label;
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 truncate">{task.label}</span>
      <span className="min-w-0 shrink-[2] truncate text-token-text-tertiary">{task.owner}</span>
    </span>
  );
}

function BackgroundTaskIcon({ kind }: { kind: ConversationBackgroundTask["kind"] }) {
  if (kind === "command") return <TerminalIcon className="icon-sm shrink-0" />;
  // A monitor waits for something and tells the Agent when it happens.
  if (kind === "monitor") return <BellIcon className="icon-sm" />;
  return <CircleDotIcon className="icon-sm shrink-0" />;
}

function BackgroundTaskAge({ startedAtMs }: { startedAtMs: number }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timeout = window.setTimeout(
      () => setNowMs(Date.now()),
      getNextElapsedTimeUpdateDelay(startedAtMs, nowMs),
    );
    return () => window.clearTimeout(timeout);
  }, [nowMs, startedAtMs]);
  return (
    <span className="text-sm text-token-text-tertiary tabular-nums">
      {formatBackgroundTaskAge(startedAtMs, nowMs)}
    </span>
  );
}

type OutputState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly output: ConversationBackgroundTaskOutput | null }
  | { readonly status: "failed"; readonly message: string };

/** Follows the end of a task's output while it is shown. */
function BackgroundTaskOutputView({
  task,
  readOutput,
}: {
  task: ConversationBackgroundTask;
  readOutput: NonNullable<ConversationBackgroundTasks["readOutput"]>;
}) {
  const [state, setState] = useState<OutputState>({ status: "loading" });
  useEffect(() => {
    let active = true;
    let timeout: number | undefined;
    const read = () => {
      void readOutput(task.id)
        .then((output) => {
          if (!active) return;
          setState({ status: "ready", output });
          // Output that cannot be read now will not become readable by asking again.
          if (output !== null) timeout = window.setTimeout(read, OUTPUT_REFRESH_MS);
        })
        .catch((cause: unknown) => {
          if (!active) return;
          setState({
            status: "failed",
            message: cause instanceof Error ? cause.message : "Could not read the output",
          });
        });
    };
    read();
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [readOutput, task.id]);

  const text = state.status === "ready" ? (state.output?.text.trimEnd() ?? null) : null;
  const notice =
    state.status === "loading"
      ? "Reading output…"
      : state.status === "failed"
        ? state.message
        : state.output === null
          ? "Output isn't available for this task"
          : text === ""
            ? "No output yet"
            : null;
  return (
    <div className="mb-1 min-w-0 overflow-hidden rounded-md bg-token-foreground/[0.035]">
      {task.command ? (
        <div className="truncate px-2 pt-1.5 font-code text-size-code-sm text-token-text-tertiary">
          {`$ ${task.command}`}
        </div>
      ) : null}
      {notice !== null ? (
        <div
          className={cn(
            "px-2 py-1.5 text-sm",
            state.status === "failed" ? "text-(--destructive)" : "text-token-text-tertiary",
          )}
        >
          {notice}
        </div>
      ) : (
        <div className="vertical-scroll-fade-mask flex max-h-40 flex-col-reverse overflow-auto font-code text-size-code-sm whitespace-pre text-token-description-foreground [--edge-fade-distance:1.5rem] [animation-direction:reverse]">
          <div className="w-max min-w-full px-2 py-1.5">
            {state.status === "ready" && state.output?.truncated ? (
              <div className="text-token-text-tertiary">…</div>
            ) : null}
            <TerminalAnsiText value={text ?? ""} />
          </div>
        </div>
      )}
    </div>
  );
}

function BackgroundTaskRow({
  task,
  background,
  stopping,
  expanded,
  onSelect,
  onStop,
}: {
  task: ConversationBackgroundTask;
  background: ConversationBackgroundTasks;
  stopping: boolean;
  expanded: boolean;
  onSelect: (() => void) | undefined;
  onStop: () => void;
}) {
  return (
    <>
      <ThreadSummaryPanelRow
        label={<BackgroundTaskLabel task={task} />}
        labelClassName={task.owner ? "min-w-0 flex-1" : undefined}
        title={backgroundTaskTitle(task)}
        icon={<BackgroundTaskIcon kind={task.kind} />}
        aria-label={[task.label, KIND_LABELS[task.kind], task.owner && `in ${task.owner}`]
          .filter(Boolean)
          .join(", ")}
        aria-expanded={background.readOutput ? expanded : undefined}
        interactive={Boolean(onSelect)}
        onClick={onSelect}
        trailing={
          stopping ? (
            <CodexShimmerText
              variant="classic"
              className="text-sm whitespace-nowrap text-token-text-tertiary"
            >
              Stopping…
            </CodexShimmerText>
          ) : task.startedAtMs !== null ? (
            <BackgroundTaskAge startedAtMs={task.startedAtMs} />
          ) : null
        }
        trailingVisible
        actions={
          stopping || !task.stoppable ? undefined : (
            <NodexTooltip tooltipContent="Stop" side="top">
              <button
                type="button"
                aria-label={`Stop ${task.label}`}
                className={HEADER_ICON_BUTTON_CLASS_NAME}
                onClick={onStop}
              >
                <StopIcon className="size-3" />
              </button>
            </NodexTooltip>
          )
        }
      />
      {expanded && background.readOutput ? (
        <BackgroundTaskOutputView task={task} readOutput={background.readOutput} />
      ) : null}
    </>
  );
}

const HEADER_ICON_BUTTON_CLASS_NAME =
  "flex size-6 shrink-0 cursor-interaction items-center justify-center rounded-sm text-token-text-tertiary hover:bg-token-list-hover-background hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px]";

/**
 * Background work the conversation's Agents left running, with each task's name, age and
 * recent output, and Stop for one task or all of them. Subagents have their own section.
 */
export function ThreadSummaryBackgroundSection({
  background,
  autoCollapse,
  onErrorMessage,
}: {
  background: ConversationBackgroundTasks;
  autoCollapse: boolean;
  onErrorMessage: (message: string | null) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Stop shows at once, before the Agent confirms; the list drops the task when it ends.
  const [requested, setRequested] = useState<ReadonlySet<string>>(() => new Set());
  const { tasks } = background;
  const isStopping = (task: ConversationBackgroundTask) => task.stopping || requested.has(task.id);
  const live = tasks.filter((task) => !isStopping(task));
  const stop = (taskId?: string) => {
    const ids = taskId === undefined ? live.map((task) => task.id) : [taskId];
    onErrorMessage(null);
    setRequested((current) => new Set([...current, ...ids]));
    void background
      .stop(taskId)
      .catch((cause: unknown) => {
        onErrorMessage(
          cause instanceof Error
            ? cause.message
            : taskId
              ? "Could not stop the background task"
              : "Could not stop background tasks",
        );
      })
      .finally(() =>
        setRequested((current) => new Set([...current].filter((id) => !ids.includes(id)))),
      );
  };
  const { openAll, openOutput, readOutput } = background;
  return (
    <ThreadSummaryPanelSection
      sectionKey="background-tasks"
      title="Background"
      titleSuffix={<ThreadSummaryPanelCountBadge count={tasks.length} />}
      autoCollapse={autoCollapse}
      after={
        live.length > 1 || openAll ? (
          <span className="ms-auto flex shrink-0 items-center gap-0.5">
            {live.length > 1 ? (
              <button
                type="button"
                className="inline-flex h-6 shrink-0 cursor-interaction items-center gap-1 rounded-sm px-1.5 text-sm text-token-text-tertiary hover:bg-token-list-hover-background hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
                onClick={() => stop()}
              >
                <StopIcon className="size-3" />
                Stop all
              </button>
            ) : null}
            {openAll ? (
              <NodexTooltip tooltipContent="View all processes" side="top">
                <button
                  type="button"
                  aria-label="View all processes"
                  className={HEADER_ICON_BUTTON_CLASS_NAME}
                  onClick={openAll}
                >
                  <ListTree className="icon-xs" aria-hidden="true" />
                </button>
              </NodexTooltip>
            ) : null}
          </span>
        ) : null
      }
    >
      {tasks.map((task) => (
        <BackgroundTaskRow
          key={task.id}
          task={task}
          background={background}
          stopping={isStopping(task)}
          expanded={expandedId === task.id}
          onSelect={
            readOutput
              ? () => setExpandedId((current) => (current === task.id ? null : task.id))
              : openOutput
                ? () => openOutput(task.id)
                : undefined
          }
          onStop={() => stop(task.id)}
        />
      ))}
    </ThreadSummaryPanelSection>
  );
}
