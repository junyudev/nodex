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
import { ThreadCommandShellBlock } from "./thread-command-shell-block";

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
  effectiveStatus: string | undefined;
  isExpanded: boolean;
  isTurnInProgress: boolean;
  processId: number | string | null | undefined;
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

function shouldShowCwdSubtitle(
  commandCwd: string | undefined,
  threadCwd: string | undefined,
): boolean {
  const normalizedCommandCwd = normalizePath(commandCwd);
  const normalizedThreadCwd = normalizePath(threadCwd);
  if (!normalizedCommandCwd || !normalizedThreadCwd) return false;
  return normalizedCommandCwd !== normalizedThreadCwd;
}

function formatElapsedDuration(elapsedMs: number): string | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 1_000) return null;

  const totalSeconds = Math.floor(elapsedMs / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return seconds > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
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

export function formatCommandMetaText(
  elapsedLabel: string | null,
  cwdSubtitle: string | undefined,
): string | null {
  const metaParts: string[] = [];
  if (elapsedLabel) metaParts.push(`for ${elapsedLabel}`);
  if (cwdSubtitle) metaParts.push(cwdSubtitle);
  if (metaParts.length === 0) return null;
  return metaParts.join(" · ");
}

function useElapsedLabel(input: {
  durationMs: number | null;
  isBackgroundTerminalRunning: boolean;
  isInProgress: boolean;
  startedAtMs: number | null;
}): string | null {
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
  return formatElapsedDuration(elapsedMs);
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

function formatSkillScriptSummary(summary: SkillScriptSummary): string {
  return `script ${summary.fileName} from ${summary.skillName} skill`;
}

export function resolveCommandSummaryLabel({
  command,
  effectiveStatus,
  isExpanded,
  isTurnInProgress,
  processId,
}: CommandSummaryLabelInput): string {
  const commandText = command.trim();
  const isInProgress = effectiveStatus === "inProgress";
  const wasInterrupted = effectiveStatus === "interrupted";

  if (isDateCommand(commandText)) {
    if (wasInterrupted) return "Stopped checking the current date and time";
    if (isInProgress) return "Checking the current date and time";
    return "Checked the current date and time";
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
    ? formatSkillScriptSummary(skillScriptSummary)
    : commandText;

  if (isInProgress) {
    if (isBackgroundTerminalRunning) {
      if (skillScriptSummary) {
        return `Started background terminal running ${skillScriptSummary.fileName} from ${skillScriptSummary.skillName} skill`;
      }
      if (commandText.length > 0) return `Started background terminal with ${commandText}`;
      return "Started background terminal";
    }
    return "Running command";
  }

  if (isFinishedBackgroundTerminal) {
    if ((skillScriptSummary || commandText.length > 0) && wasInterrupted) {
      return `Background terminal stopped with ${commandSummary}`;
    }
    if (skillScriptSummary) {
      return `Background terminal finished running ${skillScriptSummary.fileName} from ${skillScriptSummary.skillName} skill`;
    }
    if (commandText.length > 0) return `Ran ${commandText}`;
    return wasInterrupted ? "Background terminal stopped" : "Background terminal finished";
  }

  if (!isExpanded && (skillScriptSummary || commandText.length > 0)) {
    return wasInterrupted ? `Stopped ${commandSummary}` : `Ran ${commandSummary}`;
  }

  return wasInterrupted ? "Stopped command" : "Ran command";
}

function formatExplorationSummary(
  actions: CodexCommandAction[],
  effectiveStatus: string | undefined,
): string {
  const verb = effectiveStatus === "inProgress" ? "Exploring" : "Explored";
  if (actions.length === 0) return verb;
  return `${verb} ${actions.length} ${actions.length === 1 ? "step" : "steps"}`;
}

function renderExplorationLine(action: CodexCommandAction): string {
  if (action.type === "read") return `Read ${action.name || action.path}`;
  if (action.type === "listFiles") return `Listed ${action.path || "files"}`;
  if (action.type === "search") {
    if (action.query && action.path) return `Searched for ${action.query} in ${action.path}`;
    if (action.query) return `Searched for ${action.query}`;
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
  action: Extract<CodexCommandAction, { type: "read" }>,
  effectiveStatus: string | undefined,
  threadDetailLevel: string,
): string | null {
  const skillPathInfo = resolveExplorationSkillPathInfo(action.path);
  if (skillPathInfo?.isSkillDefinitionFile === true) {
    if (effectiveStatus === "inProgress") {
      return threadDetailLevel === "STEPS_PROSE"
        ? `Reading ${skillPathInfo.skillName} skill`
        : null;
    }
    return `Read ${skillPathInfo.skillName} skill`;
  }

  if (effectiveStatus === "inProgress") return null;
  return `Read ${action.name || action.path}`;
}

function formatSearchActionLabel(
  action: Extract<CodexCommandAction, { type: "search" }>,
  effectiveStatus: string | undefined,
): string {
  const verb = effectiveStatus === "inProgress" ? "Searching" : "Searched";
  if (action.query && action.path) return `${verb} for ${action.query} in ${action.path}`;
  if (action.query) return `${verb} for ${action.query}`;
  return `${verb} for files`;
}

function formatListFilesActionLabel(
  action: Extract<CodexCommandAction, { type: "listFiles" }>,
  effectiveStatus: string | undefined,
): string {
  const verb = effectiveStatus === "inProgress" ? "Listing" : "Listed";
  return action.path ? `${verb} files in ${action.path}` : `${verb} files`;
}

function formatSingleExplorationActionLabel(
  action: CodexCommandAction,
  effectiveStatus: string | undefined,
  threadDetailLevel: string,
): string | null {
  if (action.type === "read")
    return formatReadActionLabel(action, effectiveStatus, threadDetailLevel);
  if (action.type === "search") return formatSearchActionLabel(action, effectiveStatus);
  if (action.type === "listFiles") return formatListFilesActionLabel(action, effectiveStatus);
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

function SummaryText({
  command,
  summaryLabel,
  elapsedLabel,
  commandCwd,
  threadCwd,
  isExpanded,
  isInProgress,
}: {
  command: string;
  summaryLabel: string;
  elapsedLabel: string | null;
  commandCwd?: string;
  threadCwd?: string;
  isExpanded: boolean;
  isInProgress: boolean;
}) {
  const metaParts: string[] = [];
  if (elapsedLabel) metaParts.push(`for ${elapsedLabel}`);
  if (shouldShowCwdSubtitle(commandCwd, threadCwd) && commandCwd)
    metaParts.push(`in ${commandCwd}`);
  const activeLeadingLabel = resolveActiveCommandSummaryLeadingLabel(summaryLabel, isInProgress);

  return (
    <span className="min-w-0 flex-1 text-size-chat truncate text-token-foreground/40 group-hover:text-token-foreground">
      {activeLeadingLabel ? (
        <span className="font-sans text-token-description-foreground group-hover:text-token-foreground">
          <CodexShimmerText>{activeLeadingLabel.leading}</CodexShimmerText>
          {activeLeadingLabel.trailing ? <span>{activeLeadingLabel.trailing}</span> : null}
        </span>
      ) : (
        <span className="font-sans text-token-description-foreground group-hover:text-token-foreground">
          {summaryLabel}
        </span>
      )}
      {metaParts.length > 0 ? (
        <span className="ml-1 text-token-foreground/30">{metaParts.join(" · ")}</span>
      ) : null}
      {!isExpanded ? null : <span className="sr-only">{command}</span>}
    </span>
  );
}

function resolveActiveCommandSummaryLeadingLabel(
  summaryLabel: string,
  isInProgress: boolean,
): { leading: string; trailing: string | null } | null {
  if (!isInProgress) return null;
  const activePrefixes = [
    "Checking the current date and time",
    "Running command",
    "Running",
    "Exploring",
  ];
  for (const prefix of activePrefixes) {
    if (summaryLabel === prefix) return { leading: prefix, trailing: null };
    if (summaryLabel.startsWith(`${prefix} `)) {
      return { leading: prefix, trailing: summaryLabel.slice(prefix.length) };
    }
  }
  return null;
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
  const plainLabel = formatSingleExplorationActionLabel(action, effectiveStatus, threadDetailLevel);
  const readPath =
    action.type === "read" && effectiveStatus !== "inProgress"
      ? resolveExplorationPath(action.path || action.name, cwd)
      : null;
  const label =
    readPath && action.type === "read" && !isSkillDefinitionReadAction(action) ? (
      <>
        <span>Read </span>
        <FileLinkAnchor
          href={readPath}
          projectWorkspacePath={cwd}
          showLocalFileTooltip
          className="pointer-events-auto max-w-full truncate align-bottom text-inherit underline decoration-dotted decoration-[0.5px] underline-offset-2 group-hover/activity-header:!text-token-foreground hover:!text-token-foreground"
        >
          {(action.name || action.path).replace(/^\.\//, "")}
        </FileLinkAnchor>
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
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 truncate text-token-conversation-summary-trailing group-hover/activity-header:text-token-foreground [&_*]:text-token-foreground/30 group-hover/activity-header:[&_*]:text-token-foreground">
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
  if (isInProgress) {
    return <div className="text-size-chat px-2.5 pt-0.5 pb-1" />;
  }

  const label = (() => {
    if (effectiveStatus === "interrupted") return "Stopped";
    if (exitCode === 0) return "Success";
    if (exitCode !== null) return `Exit code ${exitCode}`;
    return "Exit code unknown";
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
  const isInProgress = effectiveStatus === "inProgress";
  const isBackgroundTerminalRunning = isInProgress && !isStreamingTurn;
  const hasApprovalReviews = automaticApprovalReviews.length > 0;
  const elapsedLabel = useElapsedLabel({
    durationMs: item.durationMs ?? null,
    isBackgroundTerminalRunning,
    isInProgress,
    startedAtMs: item.startedAtMs ?? null,
  });
  const commandActions = extractCommandActions(item);
  const parsedExplorationAction = resolveParsedExplorationAction(item);
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
  const shouldHideForProse = threadDetailLevel === "STEPS_PROSE" && !isSingleSkillDefinitionRead;
  const shouldHideUnfinishedParsedAction =
    singleExplorationAction !== null &&
    explorationStatus === "inProgress" &&
    !isSingleSkillDefinitionRead &&
    automaticApprovalReviews.length === 0;
  const [viewState, setViewState] = useState<CommandViewState>("collapsed");
  const { elementHeightPx: bodyHeightPx, elementRef: bodyRef } = useMeasuredElementHeight();

  const isExpanded = viewState === "expanded";
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
    ? formatExplorationSummary(commandActions, effectiveStatus)
    : resolveCommandSummaryLabel({
        command: displayCommand,
        effectiveStatus,
        isExpanded,
        isTurnInProgress: isStreamingTurn,
        processId: item.processId,
      });

  const handleToggle = () => {
    setViewState((currentState) => (currentState === "expanded" ? "collapsed" : "expanded"));
  };

  const header = (
    <ThreadRichActivityHeader
      status={semanticActivityStatusFromLifecycle(effectiveStatus, "completed")}
      accessory={hasApprovalReviews ? <AutomaticApprovalReviewShield /> : null}
      disclosure={{ expanded: isExpanded, onToggle: handleToggle }}
      icon={
        <ToolActivityIcon descriptor={resolveCommandHeaderIcon(commandActions, isExploration)} />
      }
      summary={
        <SummaryText
          command={command}
          summaryLabel={summaryLabel}
          elapsedLabel={elapsedLabel}
          commandCwd={item.cwd ?? undefined}
          threadCwd={threadCwd}
          isExpanded={isExpanded}
          isInProgress={isInProgress}
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
            className="flex min-w-0 items-start font-vscode-editor whitespace-pre-wrap break-words"
          >
            <span className="min-w-0 flex-1">{renderExplorationLine(action)}</span>
          </div>
        ))}
        {item.toolCall?.error ? (
          <ToolErrorDetail error={item.toolCall.error} className="pt-1" />
        ) : null}
      </div>
    </div>
  ) : (
    <div className={cn("flex flex-col gap-2", automaticApprovalReviews.length === 0 && "pt-2")}>
      <AutomaticApprovalReviewRows items={automaticApprovalReviews} />
      <ThreadCommandShellBlock
        variant="embedded"
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
  const isMeasuredOpen = viewState !== "collapsed";

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
