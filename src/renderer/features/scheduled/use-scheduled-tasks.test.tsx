import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  createCodexScheduledAutomation,
  deleteCodexScheduledAutomation,
  runCodexScheduledAutomationNow,
  updateCodexScheduledAutomation,
} from "@/lib/codex-automation-runtime";
import { queryKeys } from "@/lib/query-keys";
import type { CodexScheduledAutomation } from "@/lib/types";
import { buildScheduledTaskStatusUpdate } from "./scheduled-task-cache";
import { useScheduledTasks } from "./use-scheduled-tasks";

vi.mock("@/lib/codex-automation-runtime", () => ({
  createCodexScheduledAutomation: vi.fn(),
  deleteCodexScheduledAutomation: vi.fn(),
  runCodexScheduledAutomationNow: vi.fn(),
  updateCodexScheduledAutomation: vi.fn(),
}));
vi.mock("@/lib/use-codex-scheduled-automations", () => ({
  useCodexScheduledAutomations: () => ({ data: undefined, isPending: false, isError: false }),
}));
vi.mock("@/lib/use-codex-automation-runs-inbox", () => ({
  useCodexAutomationRunsInbox: () => ({ data: undefined }),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { danger: vi.fn(), info: vi.fn() } }));

const task: CodexScheduledAutomation = {
  id: "task",
  definitionRevision: 1,
  kind: "cron",
  status: "ACTIVE",
  projectId: "project",
  targetSessionId: null,
  notificationPolicy: null,
  launch: "ask",
  runbookPageId: null,
  runbookTitle: null,
  heldFiring: null,
  name: "Review changes",
  prompt: "Review the repository",
  rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
  model: null,
  reasoningEffort: null,
  serviceTier: null,
  backendBinding: { kind: "codex" },
  cwds: ["/repo"],
  executionEnvironment: "worktree",
  localEnvironmentConfigPath: null,
  nextRunAt: 1,
  lastRunAt: null,
  createdAt: 0,
  updatedAt: 0,
};

function deferred<T>() {
  let resolve = (_value: T): void => {};
  let reject = (_error: Error): void => {};
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup() {
  const client = new QueryClient();
  const key = queryKeys.codexScheduledAutomations.list();
  client.setQueryData(key, [task]);
  const hook = renderHook(() => useScheduledTasks(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...hook, client, key };
}

afterEach(() => vi.restoreAllMocks());

test("a rejected optimistic status change restores the task and releases its pending action", async () => {
  const response = deferred<Awaited<ReturnType<typeof updateCodexScheduledAutomation>>>();
  vi.mocked(updateCodexScheduledAutomation).mockReturnValueOnce(response.promise);
  const { result, client, key, unmount } = setup();
  try {
    let operation: Promise<CodexScheduledAutomation | null> = Promise.resolve(null);
    await act(async () => {
      operation = result.current.setTaskStatus(task, "PAUSED");
    });
    expect(result.current.pendingTaskId).toBe(task.id);
    expect(client.getQueryData<CodexScheduledAutomation[]>(key)?.[0]?.status).toBe("PAUSED");
    await act(async () => {
      response.reject(new Error("Could not save"));
      expect(await operation).toBeNull();
    });
    expect(client.getQueryData(key)).toEqual([task]);
    expect(result.current.pendingTaskId).toBeNull();
  } finally {
    unmount();
    client.clear();
  }
});

test("creation stays pending through refresh and keeps the saved task when refresh fails", async () => {
  const refresh = deferred<void>();
  vi.mocked(createCodexScheduledAutomation).mockResolvedValueOnce({ item: task });
  const { result, client, key, unmount } = setup();
  vi.spyOn(client, "invalidateQueries").mockReturnValue(refresh.promise);
  try {
    let operation: Promise<CodexScheduledAutomation | null> = Promise.resolve(null);
    await act(async () => {
      operation = result.current.createTask(buildScheduledTaskStatusUpdate(task, "ACTIVE"));
    });
    expect(result.current.pendingTaskId).toBe("new");
    expect(client.getQueryData(key)).toEqual([task]);
    await act(async () => {
      refresh.reject(new Error("Refresh failed"));
      expect(await operation).toBeNull();
    });
    expect(client.getQueryData(key)).toEqual([task]);
    expect(result.current.pendingTaskId).toBeNull();
  } finally {
    unmount();
    client.clear();
  }
});

test("a failed immediate run releases pending state so the task can be retried", async () => {
  vi.mocked(runCodexScheduledAutomationNow).mockRejectedValueOnce(new Error("Offline"));
  vi.mocked(runCodexScheduledAutomationNow).mockResolvedValueOnce({ success: true });
  const { result, client, unmount } = setup();
  try {
    await act(async () => {
      await result.current.runTaskNow(task);
    });
    expect(result.current.pendingTaskId).toBeNull();
    await act(async () => {
      await result.current.runTaskNow(task);
    });
    expect(result.current.pendingTaskId).toBeNull();
    expect(runCodexScheduledAutomationNow).toHaveBeenCalledTimes(2);
  } finally {
    unmount();
    client.clear();
  }
});

test("a refused deletion preserves the task, refreshes it, and releases pending state", async () => {
  vi.mocked(deleteCodexScheduledAutomation).mockResolvedValueOnce({
    item: task,
    success: false,
    status: "remove_failed",
  });
  const { result, client, key, unmount } = setup();
  const refresh = vi.spyOn(client, "invalidateQueries");
  try {
    await act(async () => {
      expect(await result.current.deleteTask(task)).toBe(false);
    });
    expect(client.getQueryData(key)).toEqual([task]);
    expect(refresh).toHaveBeenCalledWith({ queryKey: key });
    expect(result.current.pendingTaskId).toBeNull();
  } finally {
    unmount();
    client.clear();
  }
});
