import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import {
  archiveAutomationRun,
  createAutomation,
  deleteAutomation,
  runAutomationNow,
  setAutomationRunReadState,
  updateAutomation,
} from "@/lib/automations-runtime";
import { readableIpcError } from "@/lib/ipc-error-message";
import { queryKeys } from "@/lib/query-keys";
import { useAutomationRunsInbox } from "@/lib/use-automation-runs";
import { useAutomationsQuery } from "@/lib/use-automations-query";
import type { Automation, AutomationCreateInput, AutomationUpdateInput } from "@/lib/types";
import {
  applyOptimisticAutomationUpdate,
  buildAutomationStatusUpdate,
  removeAutomation,
  upsertAutomation,
} from "./automation-cache";

const EMPTY_TASKS: readonly Automation[] = [];

function showMutationError(title: string, error: unknown): void {
  toast.danger(title, { description: readableIpcError(error) || undefined });
}

/**
 * Automations and their runs, with every task action the Automations destination offers.
 * Saves are optimistic: the list reflects an edit or status change before Core confirms it.
 */
export function useAutomations() {
  const queryClient = useQueryClient();
  const tasksQuery = useAutomationsQuery();
  const runsQuery = useAutomationRunsInbox();
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const tasks = tasksQuery.data ?? EMPTY_TASKS;
  const runItems = runsQuery.data?.items ?? [];
  const unreadTaskIds = new Set(runsQuery.data?.unreadRunCounts.automationIds ?? []);
  const listKey = queryKeys.automations.list();

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.automations.all() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.automationRuns.all() }),
    ]);
  };

  const saveUpdate = async (
    update: AutomationUpdateInput,
    errorTitle = "Could not update automation",
  ): Promise<Automation | null> => {
    const previous = queryClient.getQueryData<Automation[]>(listKey);
    setPendingTaskId(update.id);
    queryClient.setQueryData<Automation[]>(listKey, (current) =>
      applyOptimisticAutomationUpdate(current, update),
    );
    return runWithCleanup(
      async () => {
        const { item } = await updateAutomation(update);
        queryClient.setQueryData<Automation[]>(listKey, (current) =>
          upsertAutomation(current, item),
        );
        await refresh();
        return item;
      },
      {
        onError: (error) => {
          if (previous) queryClient.setQueryData(listKey, previous);
          showMutationError(errorTitle, error);
          return null;
        },
        cleanup: () => {
          setPendingTaskId(null);
        },
      },
    );
  };

  const createTask = async (input: AutomationCreateInput): Promise<Automation | null> => {
    setPendingTaskId("new");
    return runWithCleanup(
      async () => {
        const { item } = await createAutomation(input);
        queryClient.setQueryData<Automation[]>(listKey, (current) =>
          upsertAutomation(current, item),
        );
        await refresh();
        return item;
      },
      {
        onError: (error) => {
          showMutationError("Could not create automation", error);
          return null;
        },
        cleanup: () => {
          setPendingTaskId(null);
        },
      },
    );
  };

  const setTaskStatus = (task: Automation, status: "ACTIVE" | "PAUSED") =>
    saveUpdate(buildAutomationStatusUpdate(task, status));

  const runNow = async (task: Automation): Promise<void> => {
    setPendingTaskId(task.id);
    return runWithCleanup(
      async () => {
        await runAutomationNow({ id: task.id });
        await refresh();
        toast.info(task.mode === "dry_run" ? "Dry run recorded" : "Automation started");
      },
      {
        onError: (error) => {
          showMutationError("Could not start automation", error);
        },
        cleanup: () => {
          setPendingTaskId(null);
        },
      },
    );
  };

  const deleteTask = async (task: Automation): Promise<boolean> => {
    setPendingTaskId(task.id);
    return runWithCleanup(
      async () => {
        const response = await deleteAutomation({ id: task.id });
        if (!response.success) {
          toast.danger("Could not delete automation", { description: "Try again." });
          await refresh();
          return false;
        }
        queryClient.setQueryData<Automation[]>(listKey, (current) =>
          removeAutomation(current, task.id),
        );
        await refresh();
        return true;
      },
      {
        onError: (error) => {
          showMutationError("Could not delete automation", error);
          return false;
        },
        cleanup: () => {
          setPendingTaskId(null);
        },
      },
    );
  };

  const markRunRead = async (runId: string): Promise<void> => {
    try {
      await setAutomationRunReadState({ runId, readAt: Date.now() });
      await queryClient.invalidateQueries({ queryKey: queryKeys.automationRuns.all() });
    } catch {
      // Read state is advisory; the next refresh shows the run as it is.
    }
  };

  const archiveRun = async (runId: string): Promise<void> => {
    try {
      await archiveAutomationRun({ runId });
      await queryClient.invalidateQueries({ queryKey: queryKeys.automationRuns.all() });
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
    runNow,
    deleteTask,
    markRunRead,
    archiveRun,
  };
}

export type Automations = ReturnType<typeof useAutomations>;
