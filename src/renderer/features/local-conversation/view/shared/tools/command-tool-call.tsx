import { getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import { motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { CheckmarkIcon } from "@/components/shared/icons";
import {
  getDisplayCommand,
  resolveCommandExecutionRenderStatus,
  splitShellWords,
} from "../../../../../../shared/codex-command-execution";
import type { CodexCommandAction, CodexTranscriptEntry } from "../../../../../lib/types";
import { resolveCodexThreadDetailLevel } from "../../../../../lib/codex-thread-settings";
import { useCodexThreadSettings } from "../../../../../lib/use-codex-thread-settings";
import { cn } from "../../../../../lib/utils";
import { FileLinkAnchor } from "../../../../../components/shared/file-link-anchor";
import { CODEX_THREAD_ACCORDION_TRANSITION } from "../thread-motion";
import { useMeasuredElementHeight } from "../use-measured-element-height";
import { CodexShimmerText } from "../codex-shimmer-text";
import {
  AutomaticApprovalReviewRows,
  AutomaticApprovalReviewShield,
} from "../automatic-approval-review-surface";
import {
  extractCommandActions,
  isExplorationAction,
  resolveExplorationPath,
  resolveExplorationSkillPathInfo,
} from "./command-actions";
import {
  ToolActivityIcon,
  resolveExplorationActionIcon,
  semanticToolIcon,
  type ToolActivityIconDescriptor,
} from "./tool-call-icons";
import { semanticActivityStatusFromLifecycle } from "../../../../../lib/semantic-activity-status";
import {
  ThreadActivityDisclosure,
  ThreadActivityShell,
  ThreadRichActivityHeader,
  ToolErrorDetail,
} from "./tool-primitives";
import { ThreadExecShellContainer } from "./thread-command-shell-block";
import { useConversationRuntimeOverride } from "../../../conversation-runtime";
import { wasToolExecutionDeclinedByAutomaticReview } from "../../../projection/tool-metadata/automatic-approval-review";

interface CommandToolCallProps {
  item: CodexTranscriptEntry;
  threadCwd?: string;
  isStreamingTurn?: boolean;
  automaticApprovalReviews?: readonly CodexTranscriptEntry[];
}

const EMPTY_AUTOMATIC_APPROVAL_REVIEWS: readonly CodexTranscriptEntry[] = [];

type CommandViewState = "collapsed" | "expanded";

const SKILL_SCRIPT_INTERPRETERS = new Set(["python", "python3", "bash", "sh"]);

interface SkillScriptSummary {
  fileName: string;
  skillName: string;
}

interface CommandSummaryLabelInput {
  command: string;
  elapsedLabel?: string | null;
  effectiveStatus: string | undefined;
  isExpanded: boolean;
  isTurnInProgress: boolean;
  processId: number | string | null | undefined;
  showRawCommand?: boolean;
  wasDeclinedByAutoReview?: boolean;
}

export interface CommandElapsedSnapshot {
  startedAt: number | null;
  settledElapsedMs: number | null;
  lastMeasuredAt: number;
}

function normalizePath(path: string | undefined): string | null {
  if (!path) return null;
  const trimmed = path.trim();
  if (trimmed.length === 0) return null;
  const normalized = trimmed.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : null;
}

export function formatCommandElapsedDuration(elapsedMs: number, intl = getIntl()): string | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 1_000) return null;

  const totalSeconds = Math.floor(elapsedMs / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);

  if (days > 0)
    return intl.formatMessage(
      {
        id: "conversation.commandToolCall.days",
        defaultMessage: "{days}d {hours}h {minutes}m {seconds}s",
      },
      {
        days: intl.formatNumber(days),
        hours: intl.formatNumber(hours),
        minutes: intl.formatNumber(minutes),
        seconds: intl.formatNumber(seconds),
      },
    );
  if (hours > 0)
    return intl.formatMessage(
      {
        id: "conversation.commandToolCall.hours",
        defaultMessage: "{hours}h {minutes}m {seconds}s",
      },
      {
        hours: intl.formatNumber(hours),
        minutes: intl.formatNumber(minutes),
        seconds: intl.formatNumber(seconds),
      },
    );
  if (minutes > 0)
    return intl.formatMessage(
      { id: "conversation.commandToolCall.minutes", defaultMessage: "{minutes}m {seconds}s" },
      { minutes: intl.formatNumber(minutes), seconds: intl.formatNumber(seconds) },
    );

  return intl.formatMessage(
    { id: "conversation.commandToolCall.seconds", defaultMessage: "{seconds}s" },
    { seconds: intl.formatNumber(seconds) },
  );
}

export function reconcileCommandElapsedSnapshot(
  snapshot: CommandElapsedSnapshot,
  status: string | undefined,
  now: number,
): CommandElapsedSnapshot {
  if (status === "inProgress") {
    return {
      startedAt: snapshot.startedAt ?? now,
      settledElapsedMs: null,
      lastMeasuredAt: now,
    };
  }

  if (snapshot.startedAt === null || snapshot.settledElapsedMs !== null) {
    return snapshot;
  }

  return {
    startedAt: null,
    settledElapsedMs: Math.max(now - snapshot.startedAt, 0),
    lastMeasuredAt: now,
  };
}

function useElapsedLabel(
  intl: IntlShape,
  input: {
    durationMs: number | null;
    isBackgroundTerminalRunning: boolean;
    isInProgress: boolean;
    startedAtMs: number | null;
  },
): string | null {
  const [fallbackStartedAtMs] = useState(
    () => input.startedAtMs ?? (input.isInProgress ? Date.now() : null),
  );
  const [nowMs, setNowMs] = useState(Date.now);
  const startedAtMs = input.startedAtMs ?? fallbackStartedAtMs;

  useEffect(() => {
    if (!input.isInProgress || input.isBackgroundTerminalRunning || startedAtMs === null) return;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [input.isBackgroundTerminalRunning, input.isInProgress, startedAtMs]);

  const elapsedMs =
    input.isInProgress && startedAtMs !== null
      ? Math.max(nowMs - startedAtMs, 0)
      : Math.max(input.durationMs ?? 0, 0);
  return formatCommandElapsedDuration(elapsedMs, intl);
}

function resolveCommandBasename(value: string | undefined): string | null {
  const basename = value?.replaceAll("\\", "/").split("/").at(-1)?.trim();
  return basename && basename.length > 0 ? basename : null;
}

function isAllowedDateArgument(value: string): boolean {
  return (
    value.startsWith("+") ||
    value === "-u" ||
    value === "--utc" ||
    value === "--universal" ||
    value === "-R" ||
    value === "--rfc-email" ||
    value === "-I" ||
    value.startsWith("-I=") ||
    value.startsWith("--iso-8601") ||
    value.startsWith("--rfc-3339")
  );
}

export function isDateCommand(command: string): boolean {
  const words = splitShellWords(command.trim());
  if (!words || words.length === 0) return false;

  const executable = resolveCommandBasename(words[0]);
  if (executable !== "date") return false;
  return words.slice(1).every(isAllowedDateArgument);
}

function resolveSkillScriptSummary(command: string): SkillScriptSummary | null {
  const words = splitShellWords(command.trim());
  if (!words || words.length === 0) return null;

  const executable = resolveCommandBasename(words[0])?.toLowerCase();
  if (!executable || !SKILL_SCRIPT_INTERPRETERS.has(executable)) return null;

  const scriptPath = words.slice(1).find((word) => word.length > 0 && !word.startsWith("-"));
  if (!scriptPath) return null;

  const normalizedScriptPath = normalizePath(scriptPath);
  if (!normalizedScriptPath) return null;

  const segments = normalizedScriptPath
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  let remainingSegmentsAfterSkill: string[] | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    const current = segments[index]?.toLowerCase();
    const next = segments[index + 1]?.toLowerCase();
    if ((current !== ".codex" && current !== ".agents") || next !== "skills") continue;

    const candidate = segments[index + 2] ?? null;
    const candidateLower = candidate?.toLowerCase();
    const skillNameIndex =
      candidateLower === "_import" || candidateLower === ".system" ? index + 3 : index + 2;
    if (!segments[skillNameIndex]) continue;

    remainingSegmentsAfterSkill = segments.slice(skillNameIndex + 1);
    break;
  }

  if (!remainingSegmentsAfterSkill || remainingSegmentsAfterSkill[0]?.toLowerCase() !== "scripts")
    return null;

  const fileName = segments.at(-1) ?? null;
  if (!fileName || fileName.toLowerCase() === "scripts") return null;

  const skillPathInfo = resolveExplorationSkillPathInfo(scriptPath);
  if (!skillPathInfo) return null;

  return {
    fileName,
    skillName: skillPathInfo.skillName,
  };
}

function formatSkillScriptSummary(intl: IntlShape, summary: SkillScriptSummary): string {
  return intl.formatMessage(
    {
      id: "conversation.commandToolCall.skillScript",
      defaultMessage: "script {file} from {skill} skill",
    },
    { file: summary.fileName, skill: summary.skillName },
  );
}

export function resolveCommandSummaryLabel(
  {
    command,
    elapsedLabel,
    effectiveStatus,
    isExpanded,
    isTurnInProgress,
    processId,
    showRawCommand = true,
    wasDeclinedByAutoReview = false,
  }: CommandSummaryLabelInput,
  intl = getIntl(),
): string {
  const commandText = command.trim();
  const isInProgress = effectiveStatus === "inProgress";
  const wasInterrupted = effectiveStatus === "interrupted";
  if (wasDeclinedByAutoReview) {
    return !isExpanded && showRawCommand && commandText.length > 0
      ? intl.formatMessage(
          {
            id: "conversation.commandToolCall.declinedCommand",
            defaultMessage: "Command declined by auto-review: {command}",
          },
          { command: commandText },
        )
      : intl.formatMessage({
          id: "conversation.commandToolCall.declined",
          defaultMessage: "Command declined by auto-review",
        });
  }

  const elapsed = elapsedLabel
    ? intl.formatMessage(
        {
          id: "conversation.commandToolCall.elapsed",
          defaultMessage: " {status, select, stopped {after} running {for} other {in}} {elapsed}",
        },
        {
          status: wasInterrupted ? "stopped" : isInProgress ? "running" : "completed",
          elapsed: elapsedLabel,
        },
      )
    : "";

  if (isDateCommand(commandText)) {
    if (wasInterrupted)
      return intl.formatMessage(
        {
          id: "conversation.commandToolCall.stoppedCheckingDate",
          defaultMessage: "Stopped checking the current date and time{elapsed}",
        },
        { elapsed },
      );
    if (isInProgress)
      return intl.formatMessage(
        {
          id: "conversation.commandToolCall.checkingDate",
          defaultMessage: "Checking the current date and time{elapsed}",
        },
        { elapsed },
      );
    return intl.formatMessage(
      {
        id: "conversation.commandToolCall.checkedDate",
        defaultMessage: "Checked the current date and time{elapsed}",
      },
      { elapsed },
    );
  }

  const isBackgroundTerminalRunning = isInProgress && !isTurnInProgress;
  const isFinishedBackgroundTerminal =
    !isInProgress && !isTurnInProgress && processId !== null && processId !== undefined;
  const shouldUseSkillScriptSummary =
    isBackgroundTerminalRunning || isFinishedBackgroundTerminal || !isExpanded;
  const skillScriptSummary = shouldUseSkillScriptSummary
    ? resolveSkillScriptSummary(commandText)
    : null;
  const commandSummary = skillScriptSummary
    ? formatSkillScriptSummary(intl, skillScriptSummary)
    : commandText;

  if (isInProgress) {
    if (isBackgroundTerminalRunning) {
      if (skillScriptSummary) {
        return intl.formatMessage(
          {
            id: "conversation.commandToolCall.backgroundSkill",
            defaultMessage: "Started background terminal running {file} from {skill} skill",
          },
          { file: skillScriptSummary.fileName, skill: skillScriptSummary.skillName },
        );
      }
      if (commandText.length > 0)
        return intl.formatMessage(
          {
            id: "conversation.commandToolCall.backgroundCommand",
            defaultMessage: "Started background terminal with {command}",
          },
          { command: commandText },
        );
      return intl.formatMessage({
        id: "conversation.commandToolCall.startedTerminal",
        defaultMessage: "Started background terminal",
      });
    }
    return intl.formatMessage(
      {
        id: "conversation.commandToolCall.runningCommand",
        defaultMessage: "Running command{elapsed}",
      },
      { elapsed },
    );
  }

  if (isFinishedBackgroundTerminal) {
    if ((skillScriptSummary || commandText.length > 0) && wasInterrupted) {
      return intl.formatMessage(
        {
          id: "conversation.commandToolCall.stoppedTerminalCommand",
          defaultMessage: "Background terminal stopped with {command}",
        },
        { command: commandSummary },
      );
    }
    if (skillScriptSummary) {
      return intl.formatMessage(
        {
          id: "conversation.commandToolCall.finishedTerminalSkill",
          defaultMessage: "Background terminal finished running {file} from {skill} skill",
        },
        { file: skillScriptSummary.fileName, skill: skillScriptSummary.skillName },
      );
    }
    if (commandText.length > 0)
      return intl.formatMessage(
        { id: "conversation.commandToolCall.ran", defaultMessage: "Ran {command}" },
        { command: commandText },
      );
    return wasInterrupted
      ? intl.formatMessage({
          id: "conversation.commandToolCall.stoppedTerminal",
          defaultMessage: "Background terminal stopped",
        })
      : intl.formatMessage({
          id: "conversation.commandToolCall.finishedTerminal",
          defaultMessage: "Background terminal finished",
        });
  }

  if (!isExpanded && (skillScriptSummary || commandText.length > 0)) {
    return intl.formatMessage(
      {
        id: "conversation.commandToolCall.commandStatus",
        defaultMessage: "{status, select, stopped {Stopped} other {Ran}} {command}{elapsed}",
      },
      { status: wasInterrupted ? "stopped" : "ran", command: commandSummary, elapsed },
    );
  }

  return intl.formatMessage(
    {
      id: "conversation.commandToolCall.commandStatusHidden",
      defaultMessage: "{status, select, stopped {Stopped} other {Ran}} command{elapsed}",
    },
    { status: wasInterrupted ? "stopped" : "ran", elapsed },
  );
}

function formatExplorationSummary(
  intl: IntlShape,
  actions: CodexCommandAction[],
  effectiveStatus: string | undefined,
): string {
  const status = effectiveStatus === "inProgress" ? "running" : "completed";
  return intl.formatMessage(
    {
      id: "conversation.commandToolCall.exploration",
      defaultMessage:
        "{status, select, running {Exploring} other {Explored}}{count, plural, =0 {} one { # step} other { # steps}}",
    },
    { status, count: actions.length },
  );
}

function renderExplorationLine(intl: IntlShape, action: CodexCommandAction): string {
  if (action.type === "read")
    return intl.formatMessage(
      { id: "conversation.commandToolCall.readFile", defaultMessage: "Read {path}" },
      { path: action.name || action.path },
    );
  if (action.type === "listFiles")
    return intl.formatMessage(
      { id: "conversation.commandToolCall.listedPath", defaultMessage: "Listed {path}" },
      {
        path:
          action.path ||
          intl.formatMessage({ id: "conversation.commandToolCall.files", defaultMessage: "files" }),
      },
    );
  if (action.type === "search") {
    if (action.query && action.path)
      return intl.formatMessage(
        {
          id: "conversation.commandToolCall.searchedInPath",
          defaultMessage: "Searched for {query} in {path}",
        },
        { query: action.query, path: action.path },
      );
    if (action.query)
      return intl.formatMessage(
        {
          id: "conversation.commandToolCall.searchedQuery",
          defaultMessage: "Searched for {query}",
        },
        { query: action.query },
      );
  }
  return action.command;
}

function resolveSingleExplorationAction(actions: CodexCommandAction[]): CodexCommandAction | null {
  if (actions.length !== 1) return null;
  const [action] = actions;
  if (!action || !isExplorationAction(action)) return null;
  return action;
}

function resolveParsedExplorationAction(item: CodexTranscriptEntry): CodexCommandAction | null {
  const parsed = item.parsedCmd;
  if (!parsed) return null;
  if (parsed.type === "read") {
    return { type: "read", command: parsed.cmd, name: parsed.name, path: parsed.path };
  }
  if (parsed.type === "search") {
    return {
      type: "search",
      command: parsed.cmd,
      query: parsed.query,
      path: parsed.path,
    };
  }
  if (parsed.type === "list_files") {
    return { type: "listFiles", command: parsed.cmd, path: parsed.path };
  }
  return null;
}

function formatReadActionLabel(
  intl: IntlShape,
  action: Extract<CodexCommandAction, { type: "read" }>,
  effectiveStatus: string | undefined,
  threadDetailLevel: string,
): string | null {
  const skillPathInfo = resolveExplorationSkillPathInfo(action.path);
  if (skillPathInfo?.isSkillDefinitionFile === true) {
    if (effectiveStatus === "inProgress") {
      return threadDetailLevel === "STEPS_PROSE"
        ? intl.formatMessage(
            {
              id: "conversation.commandToolCall.readingSkill",
              defaultMessage: "Reading {skill} skill",
            },
            { skill: skillPathInfo.skillName },
          )
        : null;
    }
    return intl.formatMessage(
      { id: "conversation.commandToolCall.readSkill", defaultMessage: "Read {skill} skill" },
      { skill: skillPathInfo.skillName },
    );
  }

  if (effectiveStatus === "inProgress") return null;
  return intl.formatMessage(
    { id: "conversation.commandToolCall.readFile", defaultMessage: "Read {path}" },
    { path: action.name || action.path },
  );
}

function formatSearchActionLabel(
  intl: IntlShape,
  action: Extract<CodexCommandAction, { type: "search" }>,
  effectiveStatus: string | undefined,
): string {
  const status = effectiveStatus === "inProgress" ? "running" : "completed";
  if (action.query && action.path) {
    return intl.formatMessage(
      {
        id: "conversation.commandToolCall.searchInPath",
        defaultMessage:
          "{status, select, running {Searching} other {Searched}} for {query} in {path}",
      },
      { status, query: action.query, path: action.path },
    );
  }
  if (action.query)
    return intl.formatMessage(
      {
        id: "conversation.commandToolCall.searchQuery",
        defaultMessage: "{status, select, running {Searching} other {Searched}} for {query}",
      },
      { status, query: action.query },
    );
  return intl.formatMessage(
    {
      id: "conversation.commandToolCall.searchFiles",
      defaultMessage: "{status, select, running {Searching} other {Searched}} for files",
    },
    { status },
  );
}

function formatListFilesActionLabel(
  intl: IntlShape,
  action: Extract<CodexCommandAction, { type: "listFiles" }>,
  effectiveStatus: string | undefined,
): string {
  const status = effectiveStatus === "inProgress" ? "running" : "completed";
  return action.path
    ? intl.formatMessage(
        {
          id: "conversation.commandToolCall.listInPath",
          defaultMessage: "{status, select, running {Listing} other {Listed}} files in {path}",
        },
        { status, path: action.path },
      )
    : intl.formatMessage(
        {
          id: "conversation.commandToolCall.listFiles",
          defaultMessage: "{status, select, running {Listing} other {Listed}} files",
        },
        { status },
      );
}

function formatSingleExplorationActionLabel(
  intl: IntlShape,
  action: CodexCommandAction,
  effectiveStatus: string | undefined,
  threadDetailLevel: string,
): string | null {
  if (action.type === "read")
    return formatReadActionLabel(intl, action, effectiveStatus, threadDetailLevel);
  if (action.type === "search") return formatSearchActionLabel(intl, action, effectiveStatus);
  if (action.type === "listFiles") return formatListFilesActionLabel(intl, action, effectiveStatus);
  return null;
}

function isSkillDefinitionReadAction(action: CodexCommandAction | null): boolean {
  if (action?.type !== "read") return false;
  return resolveExplorationSkillPathInfo(action.path)?.isSkillDefinitionFile === true;
}

function resolveCommandHeaderIcon(
  actions: CodexCommandAction[],
  isExploration: boolean,
): ToolActivityIconDescriptor {
  if (!isExploration) return semanticToolIcon("run-command");
  if (actions.some((action) => resolveExplorationActionIcon(action) === "skill"))
    return semanticToolIcon("skill");
  if (actions.some((action) => action.type === "search")) return semanticToolIcon("code-searching");
  if (actions.some((action) => action.type === "listFiles")) return semanticToolIcon("list-files");
  return semanticToolIcon("read-files");
}

function SummaryText({ summaryLabel, animate }: { summaryLabel: string; animate: boolean }) {
  return (
    <span className="min-w-0 flex-1 text-size-chat truncate text-token-foreground/40 group-hover:text-token-foreground">
      {animate ? (
        <span className="font-sans text-token-description-foreground group-hover:text-token-foreground">
          <CodexShimmerText>{summaryLabel}</CodexShimmerText>
        </span>
      ) : (
        <span className="font-sans text-token-description-foreground group-hover:text-token-foreground">
          {summaryLabel}
        </span>
      )}
    </span>
  );
}

function SingleExplorationActionRow({
  action,
  automaticApprovalReviews,
  cwd,
  effectiveStatus,
  summaryIcon,
  threadDetailLevel,
}: {
  action: CodexCommandAction;
  automaticApprovalReviews: readonly CodexTranscriptEntry[];
  cwd?: string;
  effectiveStatus: string | undefined;
  summaryIcon: ReactNode;
  threadDetailLevel: string;
}) {
  const intl = useIntl();
  const plainLabel = formatSingleExplorationActionLabel(
    intl,
    action,
    effectiveStatus,
    threadDetailLevel,
  );
  const readPath =
    action.type === "read" && effectiveStatus !== "inProgress"
      ? resolveExplorationPath(action.path || action.name, cwd)
      : null;
  const label =
    readPath && action.type === "read" && !isSkillDefinitionReadAction(action) ? (
      <>
        {intl.formatMessage(
          {
            id: "conversation.commandToolCall.readLink",
            defaultMessage: "<lead>Read </lead><file>{name}</file>",
          },
          {
            name: (action.name || action.path).replace(/^\.\//, ""),
            lead: (chunks) => <span>{chunks}</span>,
            file: (chunks) => (
              <FileLinkAnchor
                href={readPath}
                projectWorkspacePath={cwd}
                showLocalFileTooltip
                className="pointer-events-auto max-w-full truncate align-bottom text-inherit underline decoration-dotted decoration-[0.5px] underline-offset-2 group-hover/activity-header:!text-token-foreground hover:!text-token-foreground"
              >
                {chunks}
              </FileLinkAnchor>
            ),
          },
        )}
      </>
    ) : (
      plainLabel
    );
  if (!label) return null;

  return (
    <ThreadActivityDisclosure
      canExpand={automaticApprovalReviews.length > 0}
      status={semanticActivityStatusFromLifecycle(effectiveStatus, "completed")}
      icon={summaryIcon}
      summary={
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 truncate">
          <CodexShimmerText active={effectiveStatus === "inProgress"} className="min-w-0 truncate">
            {label}
          </CodexShimmerText>
          {automaticApprovalReviews.length > 0 ? <AutomaticApprovalReviewShield /> : null}
        </span>
      }
    >
      {automaticApprovalReviews.length > 0 ? (
        <AutomaticApprovalReviewRows items={automaticApprovalReviews} />
      ) : null}
    </ThreadActivityDisclosure>
  );
}

function CommandFooter({
  isInProgress,
  exitCode,
  effectiveStatus,
}: {
  isInProgress: boolean;
  exitCode: number | null;
  effectiveStatus: string | undefined;
}) {
  const intl = useIntl();
  if (isInProgress) {
    return <div className="text-size-chat px-2.5 pt-0.5 pb-1" />;
  }

  const label = (() => {
    if (effectiveStatus === "interrupted")
      return intl.formatMessage({
        id: "conversation.commandToolCall.stopped",
        defaultMessage: "Stopped",
      });
    if (exitCode === 0)
      return intl.formatMessage({
        id: "conversation.commandToolCall.success",
        defaultMessage: "Success",
      });
    if (exitCode !== null)
      return intl.formatMessage(
        { id: "conversation.commandToolCall.exitCode", defaultMessage: "Exit code {code}" },
        { code: exitCode },
      );
    return intl.formatMessage({
      id: "conversation.commandToolCall.unknownExitCode",
      defaultMessage: "Exit code unknown",
    });
  })();

  return (
    <div className="text-size-chat flex items-center gap-2 px-2.5 pt-0.5 pb-1 text-token-input-placeholder-foreground">
      <span className="ml-auto flex items-center gap-1">
        <CheckmarkIcon className="icon-xxs" />
        {label}
      </span>
    </div>
  );
}

export function CommandToolCall({
  item,
  threadCwd,
  isStreamingTurn = true,
  automaticApprovalReviews = EMPTY_AUTOMATIC_APPROVAL_REVIEWS,
}: CommandToolCallProps) {
  const intl = useIntl();
  const { settings } = useCodexThreadSettings();
  const threadDetailLevel = resolveCodexThreadDetailLevel(settings.detailLevel);

  const rawCommand =
    typeof item.command === "string" && item.command.trim().length > 0 ? item.command : "";
  const displayCommand = getDisplayCommand(rawCommand);
  const command = displayCommand || "command";
  const output = item.aggregatedOutput ?? "";
  const exitCode = item.exitCode ?? null;
  const effectiveStatus = resolveCommandExecutionRenderStatus({
    itemStatus: item.status,
  });
  const wasDeclinedByAutoReview = wasToolExecutionDeclinedByAutomaticReview({
    type: "exec",
    entry: item,
    automaticApprovalReviews,
  });
  const isInProgress = effectiveStatus === "inProgress";
  const isBackgroundTerminalRunning = isInProgress && !isStreamingTurn;
  const hasApprovalReviews = automaticApprovalReviews.length > 0;
  const elapsedLabel = useElapsedLabel(intl, {
    durationMs: item.durationMs ?? null,
    isBackgroundTerminalRunning,
    isInProgress,
    startedAtMs: item.startedAtMs ?? null,
  });
  const commandActions = wasDeclinedByAutoReview ? [] : extractCommandActions(item);
  const parsedExplorationAction = wasDeclinedByAutoReview
    ? null
    : resolveParsedExplorationAction(item);
  const isExploration =
    parsedExplorationAction !== null ||
    (commandActions.length > 0 && commandActions.every(isExplorationAction));
  const singleExplorationAction =
    parsedExplorationAction ?? resolveSingleExplorationAction(commandActions);
  const explorationStatus = item.parsedCmd
    ? item.parsedCmd.isFinished
      ? "completed"
      : "inProgress"
    : effectiveStatus;
  const isSingleSkillDefinitionRead = isSkillDefinitionReadAction(singleExplorationAction);
  const hideRawCommand = threadDetailLevel === "STEPS_PROSE" && wasDeclinedByAutoReview;
  const shouldHideForProse =
    threadDetailLevel === "STEPS_PROSE" && !isSingleSkillDefinitionRead && !wasDeclinedByAutoReview;
  const shouldHideUnfinishedParsedAction =
    singleExplorationAction !== null &&
    explorationStatus === "inProgress" &&
    !isSingleSkillDefinitionRead &&
    automaticApprovalReviews.length === 0;
  const [viewState, setViewState] = useState<CommandViewState>("collapsed");
  const { elementHeightPx: bodyHeightPx, elementRef: bodyRef } = useMeasuredElementHeight();

  const isExpanded = !hideRawCommand && viewState === "expanded";
  // Opening a finished command reads output its live projection withheld, once per open.
  const runtime = useConversationRuntimeOverride();
  const outputItemId = item.commandExecutionItemId ?? item.rawItemId ?? item.itemId;
  const needsOutputDetail =
    isExpanded && !isInProgress && output.length === 0 && Boolean(runtime?.readItemDetail);
  useEffect(() => {
    if (!needsOutputDetail) return;
    void runtime?.readItemDetail?.(item.threadId, outputItemId).catch(() => undefined);
  }, [needsOutputDetail, runtime, item.threadId, outputItemId]);
  if (shouldHideForProse || shouldHideUnfinishedParsedAction) return null;
  if (singleExplorationAction) {
    return (
      <SingleExplorationActionRow
        action={singleExplorationAction}
        automaticApprovalReviews={automaticApprovalReviews}
        cwd={item.cwd ?? threadCwd ?? undefined}
        effectiveStatus={explorationStatus}
        summaryIcon={
          <ToolActivityIcon
            descriptor={resolveCommandHeaderIcon([singleExplorationAction], true)}
          />
        }
        threadDetailLevel={threadDetailLevel}
      />
    );
  }

  const summaryLabel = isExploration
    ? formatExplorationSummary(intl, commandActions, effectiveStatus)
    : resolveCommandSummaryLabel(
        {
          command: displayCommand,
          elapsedLabel,
          effectiveStatus,
          isExpanded,
          isTurnInProgress: isStreamingTurn,
          processId: item.processId,
          showRawCommand: !hideRawCommand,
          wasDeclinedByAutoReview,
        },
        intl,
      );

  const handleToggle = () => {
    setViewState((currentState) => (currentState === "expanded" ? "collapsed" : "expanded"));
  };

  const header = (
    <ThreadRichActivityHeader
      accessory={
        hasApprovalReviews && !wasDeclinedByAutoReview ? <AutomaticApprovalReviewShield /> : null
      }
      disclosure={hideRawCommand ? undefined : { expanded: isExpanded, onToggle: handleToggle }}
      icon={
        wasDeclinedByAutoReview ? (
          <AutomaticApprovalReviewShield tone="warning" />
        ) : (
          <ToolActivityIcon descriptor={resolveCommandHeaderIcon(commandActions, isExploration)} />
        )
      }
      summary={
        <SummaryText
          summaryLabel={summaryLabel}
          animate={
            isInProgress &&
            (isExploration ||
              (!isBackgroundTerminalRunning && !wasDeclinedByAutoReview) ||
              (isDateCommand(displayCommand) && !wasDeclinedByAutoReview))
          }
        />
      }
      testId="command-tool-summary-toggle"
    />
  );

  const body = isExploration ? (
    <div className="pt-2">
      <div className="flex flex-col gap-1.5 text-size-chat-sm text-token-description-foreground">
        {commandActions.map((action, index) => (
          <div
            key={`${action.type}:${index}`}
            className="flex min-w-0 items-start font-code whitespace-pre-wrap break-words"
          >
            <span className="min-w-0 flex-1">{renderExplorationLine(intl, action)}</span>
          </div>
        ))}
        {item.toolCall?.error ? (
          <ToolErrorDetail error={item.toolCall.error} className="pt-1" />
        ) : null}
      </div>
    </div>
  ) : (
    <div className={cn("flex flex-col gap-2", automaticApprovalReviews.length === 0 && "pt-2")}>
      <AutomaticApprovalReviewRows
        items={automaticApprovalReviews}
        isDeclined={wasDeclinedByAutoReview}
      />
      <ThreadExecShellContainer
        command={command}
        output={output}
        cwd={item.cwd ?? undefined}
        isInProgress={isInProgress}
        footer={
          <CommandFooter
            isInProgress={isInProgress}
            exitCode={exitCode}
            effectiveStatus={effectiveStatus}
          />
        }
      />
    </div>
  );
  const measuredHeight = isExpanded ? bodyHeightPx : 0;
  const isMeasuredOpen = isExpanded;

  return (
    <ThreadActivityShell
      body={
        <motion.div
          className={cn(isMeasuredOpen ? "overflow-visible" : "overflow-hidden")}
          data-testid="exec-shell-body"
          data-thread-find-skip={isMeasuredOpen ? undefined : true}
          initial={false}
          animate={{
            height: Math.max(measuredHeight, 0),
            opacity: isMeasuredOpen ? 1 : 0,
          }}
          transition={CODEX_THREAD_ACCORDION_TRANSITION}
          style={{
            overflow: isExpanded ? "visible" : "hidden",
            pointerEvents: isMeasuredOpen ? "auto" : "none",
          }}
        >
          {isMeasuredOpen ? <div ref={bodyRef}>{body}</div> : null}
        </motion.div>
      }
      className="relative overflow-clip"
      header={header}
    />
  );
}
