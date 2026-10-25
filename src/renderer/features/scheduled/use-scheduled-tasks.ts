import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import {
  archiveCodexAutomationRun,
  createCodexScheduledAutomation,
  deleteCodexScheduledAutomation,
  runCodexScheduledAutomationNow,
  setCodexAutomationRunReadState,
  updateCodexScheduledAutomation,
} from "@/lib/codex-automation-runtime";
import { readableIpcError } from "@/lib/ipc-error-message";
import { queryKeys } from "@/lib/query-keys";
import { useCodexAutomationRunsInbox } from "@/lib/use-codex-automation-runs-inbox";
import { useCodexScheduledAutomations } from "@/lib/use-codex-scheduled-automations";
import type {
  CodexScheduledAutomation,
  CodexScheduledAutomationCreateInput,
  CodexScheduledAutomationUpdateInput,
} from "@/lib/types";
import {
  applyOptimisticScheduledTaskUpdate,
  buildScheduledTaskStatusUpdate,
  removeScheduledTask,
  upsertScheduledTask,
} from "./scheduled-task-cache";

const EMPTY_TASKS: readonly CodexScheduledAutomation[] = [];

function showMutationError(title: string, error: unknown): void {
  toast.danger(title, { description: readableIpcError(error) || undefined });
}

/**
 * Scheduled tasks and their runs, with every task action the Scheduled destination offers.
 * Saves are optimistic: the list reflects an edit or status change before Core confirms it.
 */
export function useScheduledTasks() {
  const queryClient = useQueryClient();
  const tasksQuery = useCodexScheduledAutomations();
  const runsQuery = useCodexAutomationRunsInbox();
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const tasks = tasksQuery.data ?? EMPTY_TASKS;
  const runItems = runsQuery.data?.items ?? [];
  const unreadTaskIds = useMemo(
    () => new Set(runsQuery.data?.unreadRunCounts.automationIds ?? []),
    [runsQuery.data?.unreadRunCounts.automationIds],
  );
  const listKey = queryKeys.codexScheduledAutomations.list();

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: listKey }),
      queryClient.invalidateQueries({ queryKey: queryKeys.codexAutomationRuns.all() }),
    ]);
  };

  const saveUpdate = async (
    update: CodexScheduledAutomationUpdateInput,
    errorTitle = "Could not update scheduled task",
  ): Promise<CodexScheduledAutomation | null> => {
    const previous = queryClient.getQueryData<CodexScheduledAutomation[]>(listKey);
    setPendingTaskId(update.id);
    queryClient.setQueryData<CodexScheduledAutomation[]>(listKey, (current) =>
      applyOptimisticScheduledTaskUpdate(current, update),
    );
    try {
      const { item } = await updateCodexScheduledAutomation(update);
      queryClient.setQueryData<CodexScheduledAutomation[]>(listKey, (current) =>
        upsertScheduledTask(current, item),
      );
      await refresh();
      return item;
    } catch (error) {
      if (previous) queryClient.setQueryData(listKey, previous);
      showMutationError(errorTitle, error);
      return null;
    } finally {
      setPendingTaskId(null);
    }
  };

  const createTask = async (
    input: CodexScheduledAutomationCreateInput,
  ): Promise<CodexScheduledAutomation | null> => {
    setPendingTaskId("new");
    try {
      const { item } = await createCodexScheduledAutomation(input);
      queryClient.setQueryData<CodexScheduledAutomation[]>(listKey, (current) =>
        upsertScheduledTask(current, item),
      );
      await refresh();
      return item;
    } catch (error) {
      showMutationError("Could not create scheduled task", error);
      return null;
    } finally {
      setPendingTaskId(null);
    }
  };

  const setTaskStatus = (task: CodexScheduledAutomation, status: "ACTIVE" | "PAUSED") =>
    saveUpdate(buildScheduledTaskStatusUpdate(task, status));

  const runTaskNow = async (task: CodexScheduledAutomation): Promise<void> => {
    setPendingTaskId(task.id);
    try {
      await runCodexScheduledAutomationNow({ id: task.id });
      await refresh();
      toast.info("Scheduled task started");
    } catch (error) {
      showMutationError("Could not start scheduled task", error);
    } finally {
      setPendingTaskId(null);
    }
  };

  const deleteTask = async (task: CodexScheduledAutomation): Promise<boolean> => {
    setPendingTaskId(task.id);
    try {
      const response = await deleteCodexScheduledAutomation({ id: task.id });
      if (!response.success) {
        toast.danger("Could not delete scheduled task", { description: "Try again." });
        await refresh();
        return false;
      }
      queryClient.setQueryData<CodexScheduledAutomation[]>(listKey, (current) =>
        removeScheduledTask(current, task.id),
      );
      await refresh();
      return true;
    } catch (error) {
      showMutationError("Could not delete scheduled task", error);
      return false;
    } finally {
      setPendingTaskId(null);
    }
  };

  const markRunRead = async (runId: string): Promise<void> => {
    try {
      await setCodexAutomationRunReadState({ runId, readAt: Date.now() });
      await queryClient.invalidateQueries({ queryKey: queryKeys.codexAutomationRuns.all() });
    } catch {
      // Read state is advisory; the next refresh shows the run as it is.
    }
  };

  const archiveRun = async (runId: string): Promise<void> => {
    try {
      await archiveCodexAutomationRun({ runId });
      await queryClient.invalidateQueries({ queryKey: queryKeys.codexAutomationRuns.all() });
    } catch (error) {
      showMutationError("Could not archive run", error);
    }
  };

  return {
    tasks,
    runItems,
    unreadTaskIds,
    isLoading: tasksQuery.isPending,
    isError: tasksQuery.isError,
    retry: () => void tasksQuery.refetch(),
    pendingTaskId,
    createTask,
    updateTask: saveUpdate,
    setTaskStatus,
    runTaskNow,
    deleteTask,
    markRunRead,
    archiveRun,
  };
}

export type ScheduledTasks = ReturnType<typeof useScheduledTasks>;
