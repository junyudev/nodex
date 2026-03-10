import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { CodexCommandAction, CodexItemView } from "../../../../lib/types";
import { getDisplayCommand } from "../../../../lib/command-display";
import {
  DetailLabel,
  CodeBlock,
  InlineToolToggle,
  ToolErrorDetail,
} from "./tool-primitives";
import { extractCommandActions, isExplorationAction } from "./command-actions";

interface CommandToolCallProps {
  item: CodexItemView;
  threadCwd?: string;
}

interface CommandToolArgs {
  command?: string;
  cwd?: string;
}

const AUTO_EXPAND_RUNNING_COMMAND_DELAY_MS = 2_000;
const SETTLE_COLLAPSE_DELAY_MS = 200;

function detectExitCode(text: string | undefined): number | null {
  if (!text) return null;
  const match = text.match(/[Ee]xit\s+code\s+(\d+)/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function statusFromExitCode(status: string | undefined, exitCode: number | null): string | undefined {
  if (status) return status;
  if (exitCode === null) return undefined;
  return exitCode === 0 ? "completed" : "failed";
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function normalizeSummaryPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

function formatExplorationTitle(actions: CodexCommandAction[], status: string | undefined): string {
  const filePaths = new Set<string>();
  let searchCount = 0;
  let listingCount = 0;

  for (const action of actions) {
    if (action.type === "read") {
      const pathKey = action.path || action.name;
      if (pathKey) filePaths.add(normalizeSummaryPath(pathKey));
      continue;
    }
    if (action.type === "search") {
      searchCount += 1;
      continue;
    }
    if (action.type === "listFiles") {
      listingCount += 1;
    }
  }

  const summary: string[] = [];
  if (filePaths.size > 0) {
    summary.push(`${filePaths.size} ${pluralize(filePaths.size, "file")}`);
  }
  if (searchCount > 0) {
    summary.push(`${searchCount} ${pluralize(searchCount, "search")}`);
  }
  if (listingCount > 0) {
    summary.push(`${listingCount} ${pluralize(listingCount, "list")}`);
  }

  const verb = explorationVerb(status);
  if (status === "inProgress" && actions.length === 1) return verb;
  if (summary.length === 0) return verb;
  return `${verb} ${summary.join(", ")}`;
}

function explorationVerb(status: string | undefined): string {
  return status === "inProgress" ? "Exploring" : "Explored";
}

function formatActionLine(action: CodexCommandAction): string {
  if (action.type === "read") {
    return `Read ${action.name || action.path}`;
  }
  if (action.type === "listFiles") {
    return `Listed ${(action.path ?? action.command) || "files"}`;
  }
  if (action.type === "search") {
    if (action.query && action.path) return `Searched for ${action.query} in ${action.path}`;
    if (action.query) return `Searched for ${action.query}`;
    return `Searched ${action.command}`;
  }
  return `Ran ${action.command}`;
}

function normalizePath(path: string | undefined): string | null {
  if (!path) return null;
  const trimmed = path.trim();
  if (trimmed.length === 0) return null;

  const normalizedSeparators = trimmed.replaceAll("\\", "/");
  const normalizedTrailingSlash = normalizedSeparators.replace(/\/+$/, "");
  return normalizedTrailingSlash.length > 0 ? normalizedTrailingSlash : normalizedSeparators;
}

function isWindowsPath(path: string): boolean {
  return /^[a-z]:\//i.test(path);
}

function shouldShowCwdSubtitle(commandCwd: string | undefined, threadCwd: string | undefined): boolean {
  const normalizedCommandCwd = normalizePath(commandCwd);
  if (!normalizedCommandCwd) return false;

  const normalizedThreadCwd = normalizePath(threadCwd);
  if (!normalizedThreadCwd) return false;

  const samePath = isWindowsPath(normalizedCommandCwd) || isWindowsPath(normalizedThreadCwd)
    ? normalizedCommandCwd.toLowerCase() === normalizedThreadCwd.toLowerCase()
    : normalizedCommandCwd === normalizedThreadCwd;

  return !samePath;
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

interface CommandElapsedSnapshot {
  startedAt: number | null;
  settledElapsedMs: number | null;
  lastMeasuredAt: number;
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

function useCommandElapsedLabel(status: string | undefined): string | null {
  const [elapsedSnapshot, setElapsedSnapshot] = useState<CommandElapsedSnapshot>(() => {
    const now = Date.now();
    return {
      startedAt: status === "inProgress" ? now : null,
      settledElapsedMs: status === "inProgress" ? null : 0,
      lastMeasuredAt: now,
    };
  });

  useEffect(() => {
    setElapsedSnapshot((currentSnapshot) =>
      reconcileCommandElapsedSnapshot(currentSnapshot, status, Date.now()));
  }, [status]);

  useEffect(() => {
    if (status !== "inProgress") return;

    const intervalId = window.setInterval(() => {
      setElapsedSnapshot((currentSnapshot) =>
        reconcileCommandElapsedSnapshot(currentSnapshot, status, Date.now()));
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [status]);

  const elapsedMs = elapsedSnapshot.settledElapsedMs ??
    (elapsedSnapshot.startedAt !== null && elapsedSnapshot.lastMeasuredAt >= elapsedSnapshot.startedAt
      ? elapsedSnapshot.lastMeasuredAt - elapsedSnapshot.startedAt
      : 0);

  return formatElapsedDuration(elapsedMs);
}

function formatCommandHeadline(
  command: string,
  hasDisplayCommand: boolean,
  status: string | undefined,
): string {
  if (status === "inProgress") return "Running command";
  return hasDisplayCommand ? `Ran ${command}` : "Ran command";
}

function resolveCommandLeadingLabel(
  hasDisplayCommand: boolean,
  status: string | undefined,
): string {
  if (status === "inProgress") return "Running command";
  return hasDisplayCommand ? "Ran" : "Ran command";
}

export function formatCommandMetaText(
  elapsedLabel: string | null,
  cwdSubtitle: string | undefined,
): string | null {
  const metaParts: string[] = [];

  if (elapsedLabel) {
    metaParts.push(`for ${elapsedLabel}`);
  }

  if (cwdSubtitle) {
    metaParts.push(cwdSubtitle);
  }

  if (metaParts.length === 0) return null;
  return metaParts.join(" · ");
}

function renderCommandMeta(
  elapsedLabel: string | null,
  cwdSubtitle: string | undefined,
): ReactNode {
  const metaText = formatCommandMetaText(elapsedLabel, cwdSubtitle);
  if (!metaText) return null;
  return (
    <span className="text-(--foreground-tertiary)">
      {metaText}
    </span>
  );
}

export function CommandToolCall({ item, threadCwd }: CommandToolCallProps) {
  const toolArgs = (typeof item.toolCall?.args === "object" && item.toolCall.args !== null)
    ? item.toolCall.args as CommandToolArgs
    : {};
  const sourceCommand = typeof toolArgs.command === "string" ? toolArgs.command : "";
  const rawCommand = sourceCommand || "Command";
  const command = getDisplayCommand(rawCommand);
  const hasDisplayCommand = sourceCommand.trim().length > 0;
  const output = typeof item.toolCall?.result === "string" ? item.toolCall.result : undefined;
  const exitCode = detectExitCode(output);
  const effectiveStatus = statusFromExitCode(item.status, exitCode);
  const commandCwd = typeof toolArgs.cwd === "string" ? toolArgs.cwd : undefined;
  const showCwdSubtitle = shouldShowCwdSubtitle(commandCwd, threadCwd);
  const cwdSubtitle = showCwdSubtitle && commandCwd ? `in ${commandCwd}` : undefined;
  const elapsedLabel = useCommandElapsedLabel(effectiveStatus);
  const commandActions = extractCommandActions(item);
  const isExploration = commandActions.length > 0 && commandActions.every(isExplorationAction);
  const shouldShowOutputPreview = Boolean(
    output &&
    output.trim().length > 0 &&
    (effectiveStatus === "failed" || effectiveStatus === "interrupted"),
  );

  if (isExploration) {
    const verb = explorationVerb(effectiveStatus);
    const isExploring = effectiveStatus === "inProgress";
    return (
      <InlineToolToggle
        label={formatExplorationTitle(commandActions, effectiveStatus)}
        leadingLabel={verb}
        status={effectiveStatus}
        defaultExpanded={isExploring && commandActions.length > 1}
        collapseWhenStatusSettles
        settleCollapseDelayMs={SETTLE_COLLAPSE_DELAY_MS}
      >
        <div className="scrollbar-token max-h-65 overflow-x-hidden overflow-y-auto pr-1">
          <div className="mb-2">
            <DetailLabel>Activity</DetailLabel>
            <div className="space-y-1">
              {commandActions.map((action, index) => (
                <div
                  key={`${action.type}-${index}`}
                  className="min-w-0 font-mono text-xs/compact wrap-anywhere whitespace-pre-wrap text-(--foreground-secondary)"
                >
                  {formatActionLine(action)}
                </div>
              ))}
            </div>
          </div>

          {shouldShowOutputPreview && (
            <div className="mb-2">
              <DetailLabel>Output</DetailLabel>
              <CodeBlock>{output}</CodeBlock>
            </div>
          )}

          {item.toolCall?.error && <ToolErrorDetail error={item.toolCall.error} />}
        </div>
      </InlineToolToggle>
    );
  }

  return (
    <InlineToolToggle
      label={formatCommandHeadline(command, hasDisplayCommand, effectiveStatus)}
      leadingLabel={resolveCommandLeadingLabel(hasDisplayCommand, effectiveStatus)}
      subtitle={renderCommandMeta(elapsedLabel, cwdSubtitle)}
      status={effectiveStatus}
      collapseWhenStatusSettles
      autoExpandDelayMs={effectiveStatus === "inProgress" ? AUTO_EXPAND_RUNNING_COMMAND_DELAY_MS : undefined}
      settleCollapseDelayMs={SETTLE_COLLAPSE_DELAY_MS}
    >
      <div className="mb-2">
        <DetailLabel>Command</DetailLabel>
        <CodeBlock>
          <span className="text-(--foreground-tertiary)">$ </span>
          {command}
        </CodeBlock>
      </div>

      <div className="mb-2">
        <DetailLabel>
          Output
          {exitCode !== null && <span className="ml-1 tracking-normal normal-case">(exit {exitCode})</span>}
        </DetailLabel>
        <CodeBlock>{output && output.trim().length > 0 ? output : "No output"}</CodeBlock>
      </div>

      {item.toolCall?.error && <ToolErrorDetail error={item.toolCall.error} />}
    </InlineToolToggle>
  );
}
