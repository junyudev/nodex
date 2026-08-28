import {
  ActivitySpinnerIcon,
  CloseIcon,
  OpenInIcon,
  PlayIcon,
  ProjectActionsIcon,
  RefreshIcon,
  StopIcon,
  TerminalIcon,
} from "@/components/shared/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import {
  NodexDialog,
  NodexDialogClose,
  NodexDialogContent,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  buildCodexBackgroundTerminalProcessRows,
  formatBackgroundTerminalCpuPercent,
  formatBackgroundTerminalMemoryKb,
  formatBackgroundTerminalPid,
  readBackgroundTerminalCpuPercent,
  readBackgroundTerminalMemoryKb,
  type CodexBackgroundTerminalProcessRow,
  type CodexBackgroundTerminalProcessThreadRef,
} from "@/lib/codex-background-terminal-processes";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type {
  CodexBackgroundProcessRow,
  CodexBackgroundProcessRunActionInput,
} from "../../../shared/types";
import { createSecureRuntimeId } from "../../../shared/secure-runtime-id";

const PROCESS_MANAGER_MIN_ROWS = 5;

export interface WorkbenchProcessManagerControl {
  listBackgroundProcesses: (threadId: string) => Promise<CodexBackgroundProcessRow[]>;
  runBackgroundProcess: (
    input: CodexBackgroundProcessRunActionInput,
  ) => Promise<CodexBackgroundProcessRow[]>;
  stopBackgroundProcess: (input: {
    threadId: string;
    processId: string | null;
    terminalSessionId: string | null;
  }) => Promise<boolean>;
  terminateBackgroundTerminal: (input: { threadId: string; processId: string }) => Promise<boolean>;
}

export interface WorkbenchProcessManagerDialogProps {
  open: boolean;
  activeThreadId: string | null;
  threads: readonly CodexBackgroundTerminalProcessThreadRef[];
  control: WorkbenchProcessManagerControl;
  onOpenChange: (open: boolean) => void;
  onOpenThread: (threadId: string) => void | Promise<void>;
  onOpenOutput?: (row: CodexBackgroundTerminalProcessRow) => void | Promise<void>;
}

type ProcessActionState = "starting" | "stopping";

function makeBackgroundProcessTerminalSessionId(row: CodexBackgroundTerminalProcessRow): string {
  return createSecureRuntimeId(`process:${row.threadId}:${row.itemId}`);
}

function readProcessManagerControlFromQueryMeta(meta: unknown): WorkbenchProcessManagerControl {
  const candidate = meta as { control?: WorkbenchProcessManagerControl } | null;
  if (!candidate?.control) {
    throw new Error("Process Manager query is missing its control facade");
  }
  return candidate.control;
}

function normalizeProcessManagerThreads(
  threads: readonly CodexBackgroundTerminalProcessThreadRef[],
): CodexBackgroundTerminalProcessThreadRef[] {
  const seen = new Set<string>();
  const normalized: CodexBackgroundTerminalProcessThreadRef[] = [];
  for (const thread of threads) {
    const threadId = thread.threadId.trim();
    if (!threadId || seen.has(threadId)) {
      continue;
    }
    seen.add(threadId);
    normalized.push({
      threadId,
      title: thread.title.trim() || threadId,
    });
  }
  return normalized.sort((left, right) => left.title.localeCompare(right.title));
}

async function fetchProcessRows(
  threads: readonly CodexBackgroundTerminalProcessThreadRef[],
  control: WorkbenchProcessManagerControl,
): Promise<CodexBackgroundTerminalProcessRow[]> {
  const processEntries = await Promise.all(
    threads.map(async (thread) => {
      try {
        return [thread.threadId, await control.listBackgroundProcesses(thread.threadId)] as const;
      } catch {
        return [thread.threadId, [] as CodexBackgroundProcessRow[]] as const;
      }
    }),
  );

  return buildCodexBackgroundTerminalProcessRows(threads, new Map(processEntries));
}

function ProcessStatusDot({
  status,
  state,
}: {
  status: CodexBackgroundTerminalProcessRow["status"];
  state?: ProcessActionState;
}) {
  if (state === "stopping") {
    return <ActivitySpinnerIcon className="size-2.5" />;
  }

  if (state === "starting") {
    return <ActivitySpinnerIcon className="size-2.5" />;
  }

  if (status === "not-found") {
    return (
      <span
        aria-label="Not found"
        className="inline-flex size-2.5 rounded-full bg-token-description-foreground/35"
      />
    );
  }

  return (
    <span
      aria-label="Running"
      className="inline-flex size-2.5 rounded-full bg-[var(--color-accent-green)]"
    />
  );
}

function ProcessManagerActionMenu({
  row,
  busy,
  onOpenOutput,
  onRun,
  onStop,
  onOpenChange,
}: {
  row: CodexBackgroundTerminalProcessRow;
  busy: boolean;
  onOpenOutput: (row: CodexBackgroundTerminalProcessRow) => void;
  onRun: (row: CodexBackgroundTerminalProcessRow) => void;
  onStop: (row: CodexBackgroundTerminalProcessRow) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const canStop =
    !busy && row.status === "running" && (row.processId !== null || row.terminalSessionId !== null);
  const canRun = !busy && row.command.trim().length > 0 && Boolean(row.cwd?.trim());
  const resumeLabel = row.status === "not-found" ? "Start" : "Restart";
  const resumeIcon = busy ? (
    <ActivitySpinnerIcon className="size-3.5" />
  ) : row.status === "not-found" ? (
    <PlayIcon className="size-3.5" />
  ) : (
    <RefreshIcon className="size-3.5" />
  );
  const resumeTooltip =
    row.command.trim().length === 0
      ? "This process does not have a command to run."
      : !row.cwd?.trim()
        ? "This process does not have a working directory."
        : undefined;
  const stopTooltip =
    row.status === "not-found"
      ? "This registered process is not currently running."
      : row.processId === null && row.terminalSessionId === null
        ? "This process does not expose a stoppable process or terminal session."
        : undefined;

  return (
    <NodexDropdownMenu
      onOpenChange={onOpenChange}
      align="end"
      side="bottom"
      contentWidth="sm"
      triggerButton={
        <NodexIconButton
          icon={ProjectActionsIcon}
          ariaLabel="Process actions"
          size="xs"
          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"
          onClick={(event) => event.stopPropagation()}
        />
      }
    >
      <NodexDropdownItem
        leftSlot={<OpenInIcon className="size-3.5" />}
        onSelect={() => onOpenOutput(row)}
      >
        Open output
      </NodexDropdownItem>
      <NodexDropdownSeparator />
      <NodexDropdownItem
        leftSlot={
          busy ? <ActivitySpinnerIcon className="size-3.5" /> : <StopIcon className="size-3.5" />
        }
        disabled={!canStop}
        tooltipText={stopTooltip}
        onSelect={() => onStop(row)}
      >
        Stop
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={resumeIcon}
        disabled={!canRun}
        tooltipText={resumeTooltip}
        onSelect={() => onRun(row)}
      >
        {resumeLabel}
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );
}

function ProcessManagerRow({
  row,
  active,
  actionState,
  onOpenOutput,
  onRun,
  onStop,
  onMenuOpenChange,
}: {
  row: CodexBackgroundTerminalProcessRow;
  active: boolean;
  actionState?: ProcessActionState;
  onOpenOutput: (row: CodexBackgroundTerminalProcessRow) => void;
  onRun: (row: CodexBackgroundTerminalProcessRow) => void;
  onStop: (row: CodexBackgroundTerminalProcessRow) => void;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const busy = actionState === "stopping";
  const threadTitle = row.threadTitle ?? row.threadId;
  return (
    <tr
      data-process-manager-row=""
      tabIndex={0}
      className={cn(
        "group h-10 cursor-default border-b border-token-border/60 odd:bg-token-foreground/[0.025] outline-hidden transition-colors",
        "hover:bg-token-list-hover-background focus-visible:bg-token-list-hover-background focus-visible:ring-token-focus focus-visible:ring-2",
        active && "bg-token-list-hover-background",
      )}
      onClick={() => onOpenOutput(row)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        onOpenOutput(row);
      }}
    >
      <td className="w-11 px-2">
        <ProcessStatusDot status={row.status} state={actionState} />
      </td>
      <td className="max-w-0 px-2 text-token-foreground">
        <NodexTooltip tooltipContent={row.command || "Unknown command"} side="top">
          <div className="truncate font-mono text-xs">{row.command || "Unknown command"}</div>
        </NodexTooltip>
      </td>
      <td className="max-w-0 px-2 text-xs text-token-description-foreground">
        <NodexTooltip tooltipContent={threadTitle} side="top">
          <div className="truncate">{threadTitle}</div>
        </NodexTooltip>
      </td>
      <td className="px-2 text-right font-mono text-xs text-token-description-foreground">
        {formatBackgroundTerminalPid(row)}
      </td>
      <td className="px-2 text-right font-mono text-xs text-token-description-foreground">
        {formatBackgroundTerminalCpuPercent(readBackgroundTerminalCpuPercent(row))}
      </td>
      <td className="px-2 text-right font-mono text-xs text-token-description-foreground">
        {formatBackgroundTerminalMemoryKb(readBackgroundTerminalMemoryKb(row))}
      </td>
      <td className="px-2 text-right font-mono text-xs text-token-description-foreground">n/a</td>
      <td className="w-11 px-2 text-right" onClick={(event) => event.stopPropagation()}>
        <ProcessManagerActionMenu
          row={row}
          busy={busy}
          onOpenOutput={onOpenOutput}
          onRun={onRun}
          onStop={onStop}
          onOpenChange={onMenuOpenChange}
        />
      </td>
    </tr>
  );
}

function ProcessManagerEmptyRows({ visibleCount }: { visibleCount: number }) {
  const placeholderCount = Math.max(PROCESS_MANAGER_MIN_ROWS - visibleCount, 0);
  return Array.from({ length: placeholderCount }, (_, index) => (
    <tr
      key={`placeholder-${index}`}
      aria-hidden="true"
      className="h-10 border-b border-token-border/45 odd:bg-token-foreground/[0.025]"
    >
      <td colSpan={8} />
    </tr>
  ));
}

export function WorkbenchProcessManagerDialog({
  open,
  activeThreadId,
  threads,
  control,
  onOpenChange,
  onOpenThread,
  onOpenOutput,
}: WorkbenchProcessManagerDialogProps) {
  const queryClient = useQueryClient();
  const [actionStates, setActionStates] = useState<Record<string, ProcessActionState>>({});
  const [frozenRows, setFrozenRows] = useState<CodexBackgroundTerminalProcessRow[] | null>(null);
  const normalizedThreads = useMemo(() => normalizeProcessManagerThreads(threads), [threads]);
  const queryKey = useMemo(
    () => queryKeys.codexBackgroundTerminals.processManager(normalizedThreads),
    [normalizedThreads],
  );

  const query = useQuery({
    queryKey,
    queryFn: ({ meta }) =>
      fetchProcessRows(normalizedThreads, readProcessManagerControlFromQueryMeta(meta)),
    enabled: open && normalizedThreads.length > 0,
    refetchInterval: frozenRows ? false : 1000,
    staleTime: 0,
    structuralSharing: false,
    meta: { control },
  });
  const rows = useMemo(() => query.data ?? [], [query.data]);
  const visibleRows = frozenRows ?? rows;

  useEffect(() => {
    if (!open) {
      setFrozenRows(null);
      setActionStates({});
    }
  }, [open]);

  const handleMenuOpenChange = useCallback(
    (nextOpen: boolean) => {
      setFrozenRows(nextOpen ? rows : null);
    },
    [rows],
  );

  const handleOpenOutput = useCallback(
    (row: CodexBackgroundTerminalProcessRow) => {
      onOpenChange(false);
      void (onOpenOutput ? onOpenOutput(row) : onOpenThread(row.threadId));
    },
    [onOpenChange, onOpenOutput, onOpenThread],
  );

  const handleRun = useCallback(
    async (row: CodexBackgroundTerminalProcessRow) => {
      const command = row.command.trim();
      const cwd = row.cwd?.trim() ?? "";
      if (!command || !cwd) {
        return;
      }

      setActionStates((current) => ({ ...current, [row.id]: "starting" }));
      try {
        if (row.status === "running" && row.processId !== null) {
          await control.stopBackgroundProcess({
            threadId: row.threadId,
            processId: row.processId,
            terminalSessionId: null,
          });
        }

        await control.runBackgroundProcess({
          threadId: row.threadId,
          threadTitle: row.threadTitle,
          itemId: row.itemId,
          turnId: row.turnId,
          command,
          cwd,
          terminalSessionId: row.terminalSessionId ?? makeBackgroundProcessTerminalSessionId(row),
        });
        toast.success(row.status === "not-found" ? "Process started" : "Process restarted");
        await queryClient.invalidateQueries({ queryKey });
      } catch (error) {
        toast.danger(error instanceof Error ? error.message : "Failed to start process");
      } finally {
        setActionStates((current) => {
          const next = { ...current };
          delete next[row.id];
          return next;
        });
      }
    },
    [control, queryClient, queryKey],
  );

  const handleStop = useCallback(
    async (row: CodexBackgroundTerminalProcessRow) => {
      if (row.status !== "running" || (row.processId === null && row.terminalSessionId === null)) {
        return;
      }

      setActionStates((current) => ({ ...current, [row.id]: "stopping" }));
      try {
        const stopped = await control.stopBackgroundProcess({
          threadId: row.threadId,
          processId: row.processId,
          terminalSessionId: row.terminalSessionId,
        });
        if (stopped) {
          toast.success("Process stopped");
        } else {
          toast.warning("Process was already stopped");
        }
        await queryClient.invalidateQueries({ queryKey });
      } catch (error) {
        toast.danger(error instanceof Error ? error.message : "Failed to stop process");
      } finally {
        setActionStates((current) => {
          const next = { ...current };
          delete next[row.id];
          return next;
        });
      }
    },
    [control, queryClient, queryKey],
  );

  return (
    <NodexDialog open={open} onOpenChange={onOpenChange}>
      <NodexDialogContent
        unstyledContent
        aria-describedby={undefined}
        showCloseButton={false}
        overlayClassName="bg-transparent"
        className={cn(
          "process-manager-dialog top-[12vh] grid w-[min(760px,calc(100vw-2rem))] translate-y-0 gap-0 overflow-hidden rounded-xl p-0 sm:max-w-none",
          "bg-token-main-surface-primary/95 shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-xl",
        )}
      >
        <div className="grid h-toolbar-sm grid-cols-[2rem_minmax(0,1fr)_2rem] items-center border-b border-token-border px-2">
          <div />
          <NodexDialogTitle className="truncate text-center text-sm font-medium">
            Process Manager
          </NodexDialogTitle>
          <NodexDialogClose>
            <NodexButton
              variant="ghost"
              size="icon-xs"
              aria-label="Close process manager"
              className="justify-self-end text-token-description-foreground hover:text-token-foreground"
            >
              <CloseIcon />
            </NodexButton>
          </NodexDialogClose>
        </div>

        <div className="max-h-[240px] min-h-[240px] overflow-auto" data-process-manager-scroll="">
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <colgroup>
              <col className="w-11" />
              <col className="w-[200px]" />
              <col className="w-[120px]" />
              <col className="w-[58px]" />
              <col className="w-[64px]" />
              <col className="w-[80px]" />
              <col className="w-[74px]" />
              <col className="w-11" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-token-main-surface-primary/95 text-[11px] font-medium text-token-description-foreground backdrop-blur-xl">
              <tr className="h-8 border-b border-token-border">
                <th className="px-2" aria-label="Status" />
                <th className="px-2">Command</th>
                <th className="px-2">Chat</th>
                <th className="px-2 text-right">PID</th>
                <th className="px-2 text-right">CPU</th>
                <th className="px-2 text-right">Memory</th>
                <th className="px-2 text-right">Runtime</th>
                <th className="px-2" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <ProcessManagerRow
                  key={row.id}
                  row={row}
                  active={activeThreadId === row.threadId}
                  actionState={actionStates[row.id]}
                  onOpenOutput={handleOpenOutput}
                  onRun={(targetRow) => void handleRun(targetRow)}
                  onStop={(targetRow) => void handleStop(targetRow)}
                  onMenuOpenChange={handleMenuOpenChange}
                />
              ))}
              {visibleRows.length === 0 ? (
                <tr className="h-10 border-b border-token-border/45">
                  <td colSpan={8} className="px-3 text-sm text-token-description-foreground">
                    {query.isPending && normalizedThreads.length > 0
                      ? "Loading processes..."
                      : "No running chat-started processes"}
                  </td>
                </tr>
              ) : null}
              <ProcessManagerEmptyRows
                visibleCount={Math.max(visibleRows.length, visibleRows.length === 0 ? 1 : 0)}
              />
            </tbody>
          </table>
        </div>

        <div className="flex h-9 items-center gap-2 border-t border-token-border px-3 text-xs text-token-description-foreground">
          <TerminalIcon className="size-3.5" />
          <span className="truncate">
            {visibleRows.length === 1 ? "1 process" : `${visibleRows.length} processes`}
          </span>
        </div>
      </NodexDialogContent>
    </NodexDialog>
  );
}
