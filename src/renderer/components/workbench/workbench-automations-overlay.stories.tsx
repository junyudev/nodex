import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CodexAutomationInboxItem,
  CodexAutomationRunsInboxResponse,
  CodexModelOption,
  CodexScheduledAutomation,
  CodexScheduledAutomationCreateInput,
  CodexScheduledAutomationUpdateInput,
  Project,
  WorktreeEnvironmentOption,
} from "@/lib/types";
import { NODEX_QUERY_DEFAULT_OPTIONS } from "@/lib/query-client";
import { WorkbenchAutomationsRouteShell } from "./workbench-automations-overlay";
import { buildAutomationsPath } from "./workbench-automations-routes";

const AUTOMATIONS: CodexScheduledAutomation[] = [
  {
    id: "automation-standup",
    definitionRevision: 1,
    kind: "heartbeat",
    status: "ACTIVE",
    targetThreadId: "thread-standup",
    name: "Daily engineering standup",
    prompt: "Check the daily engineering standup thread.",
    rrule: "FREQ=DAILY",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    backendBinding: { kind: "codex" },
    cwds: [],
    executionEnvironment: "worktree",
    localEnvironmentConfigPath: null,
    nextRunAt: new Date("2026-07-09T09:00:00.000Z").getTime(),
    lastRunAt: null,
    createdAt: new Date("2026-07-01T09:00:00.000Z").getTime(),
    updatedAt: new Date("2026-07-08T09:00:00.000Z").getTime(),
  },
  {
    id: "automation-review",
    definitionRevision: 1,
    kind: "heartbeat",
    status: "ACTIVE",
    targetThreadId: "thread-review",
    name: "Weekly review sweep",
    prompt: "Review active project threads.",
    rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    backendBinding: { kind: "codex" },
    cwds: [],
    executionEnvironment: "worktree",
    localEnvironmentConfigPath: null,
    nextRunAt: new Date("2026-07-10T16:00:00.000Z").getTime(),
    lastRunAt: null,
    createdAt: new Date("2026-07-02T16:00:00.000Z").getTime(),
    updatedAt: new Date("2026-07-08T16:00:00.000Z").getTime(),
  },
  {
    id: "automation-paused",
    definitionRevision: 1,
    kind: "heartbeat",
    status: "PAUSED",
    targetThreadId: "thread-paused",
    name: "Paused inbox triage",
    prompt: "Triage inbox updates.",
    rrule: "FREQ=DAILY;INTERVAL=2",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    backendBinding: { kind: "codex" },
    cwds: [],
    executionEnvironment: "worktree",
    localEnvironmentConfigPath: null,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: new Date("2026-07-03T12:00:00.000Z").getTime(),
    updatedAt: new Date("2026-07-08T12:00:00.000Z").getTime(),
  },
];

const HISTORY_AUTOMATION: CodexScheduledAutomation = {
  id: "automation-history",
  definitionRevision: 1,
  kind: "cron",
  status: "ACTIVE",
  targetThreadId: null,
  name: "Repository pulse",
  prompt: "Summarize repository health and open follow-ups.",
  rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
  model: "gpt-5",
  reasoningEffort: "low",
  serviceTier: null,
  backendBinding: { kind: "codex" },
  cwds: ["/Users/asc/repo/nodex"],
  executionEnvironment: "local",
  localEnvironmentConfigPath: null,
  nextRunAt: new Date("2026-07-10T09:00:00.000Z").getTime(),
  lastRunAt: new Date("2026-07-09T09:00:00.000Z").getTime(),
  createdAt: new Date("2026-07-01T09:00:00.000Z").getTime(),
  updatedAt: new Date("2026-07-09T09:00:00.000Z").getTime(),
};

const HISTORY_AUTOMATION_RUNS: CodexAutomationInboxItem[] = [
  {
    id: "thread-run-latest",
    automationId: "automation-history",
    automationName: "Repository pulse",
    title: "Repository pulse",
    description: "Ready for review.",
    archivedAssistantMessage: null,
    archivedUserMessage: null,
    archivedReason: null,
    sourceCwd: "/Users/asc/repo/nodex",
    threadId: "thread-run-latest",
    readAt: null,
    createdAt: Date.now() - 3 * 60 * 60_000,
    status: "PENDING_REVIEW",
  },
  {
    id: "thread-run-accepted",
    automationId: "automation-history",
    automationName: "Repository pulse",
    title: "Repository pulse",
    description: "Accepted yesterday.",
    archivedAssistantMessage: null,
    archivedUserMessage: null,
    archivedReason: null,
    sourceCwd: "/Users/asc/repo/nodex",
    threadId: "thread-run-accepted",
    readAt: Date.now() - 24 * 60 * 60_000,
    createdAt: Date.now() - 24 * 60 * 60_000,
    status: "ACCEPTED",
  },
  {
    id: "thread-run-archived",
    automationId: "automation-history",
    automationName: "Repository pulse",
    title: "Repository pulse",
    description: "Archived after review.",
    archivedAssistantMessage: null,
    archivedUserMessage: null,
    archivedReason: "manual",
    sourceCwd: "/Users/asc/repo/nodex",
    threadId: "thread-run-archived",
    readAt: Date.now() - 2 * 24 * 60 * 60_000,
    createdAt: Date.now() - 2 * 24 * 60 * 60_000,
    status: "ARCHIVED",
  },
];

const PROJECTS: Project[] = [
  {
    id: "nodex",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "nodex",
    description: "",
    appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
    sources: [{ root: "/Users/asc/repo/nodex", order: 0 }],
    primaryWorkspaceRoot: "/Users/asc/repo/nodex",
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-07-01T09:00:00.000Z"),
    updated: new Date("2026-07-09T09:00:00.000Z"),
  },
  {
    id: "devtools-codex",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "devtools-codex",
    description: "",
    appearance: { color: "blue", marker: { kind: "icon", icon: "terminal" } },
    sources: [{ root: "/Users/asc/repo/devtools-codex", order: 0 }],
    primaryWorkspaceRoot: "/Users/asc/repo/devtools-codex",
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-07-01T09:00:00.000Z"),
    updated: new Date("2026-07-09T09:00:00.000Z"),
  },
];

const WORKTREE_ENVIRONMENTS_BY_PROJECT: Record<string, WorktreeEnvironmentOption[]> = {
  nodex: [
    {
      path: ".codex/environments/environment.toml",
      name: "Default",
      hasSetupScript: true,
      hasCleanupScript: false,
      actionCount: 1,
    },
    {
      path: ".codex/environments/review.toml",
      name: "Review",
      hasSetupScript: true,
      hasCleanupScript: true,
      actionCount: 0,
    },
  ],
};

const CODEX_MODELS: CodexModelOption[] = [
  {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Default coding model",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  },
  {
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "Long-context coding model",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "high", description: "Deep" },
      { reasoningEffort: "xhigh", description: "Extra deep" },
    ],
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  },
];

type StoryModelListState = "loaded" | "loading";

function createStoryQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        ...NODEX_QUERY_DEFAULT_OPTIONS.queries,
        retry: false,
      },
      mutations: {
        ...NODEX_QUERY_DEFAULT_OPTIONS.mutations,
        retry: false,
      },
    },
  });
}

function upsertStoryAutomation(
  automations: CodexScheduledAutomation[],
  automation: CodexScheduledAutomation,
): CodexScheduledAutomation[] {
  const didReplace = automations.some((item) => item.id === automation.id);
  if (didReplace) {
    return automations.map((item) => (item.id === automation.id ? automation : item));
  }
  return [...automations, automation];
}

function storyAutomationFromInput(
  input: CodexScheduledAutomationCreateInput | CodexScheduledAutomationUpdateInput,
): CodexScheduledAutomation {
  const now = Date.now();
  const id = "id" in input ? input.id : `automation-${Date.now()}`;
  return {
    id,
    definitionRevision: 1,
    kind: input.kind,
    status: "status" in input ? input.status : "ACTIVE",
    targetThreadId: input.targetThreadId ?? null,
    name: input.name,
    prompt: input.prompt ?? "",
    rrule: input.rrule ?? null,
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    serviceTier: input.serviceTier ?? null,
    backendBinding: input.backendBinding ?? { kind: "codex" },
    cwds: input.cwds ?? [],
    executionEnvironment: input.executionEnvironment ?? "worktree",
    localEnvironmentConfigPath: input.localEnvironmentConfigPath ?? null,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function installAutomationsStoryApi({
  automations,
  setAutomations,
  automationRuns,
  setAutomationRuns,
  modelListState,
}: {
  automations: CodexScheduledAutomation[];
  setAutomations: (automations: CodexScheduledAutomation[]) => void;
  automationRuns: CodexAutomationInboxItem[];
  setAutomationRuns: (items: CodexAutomationInboxItem[]) => void;
  modelListState: StoryModelListState;
}) {
  if (typeof window === "undefined") return;
  window.api = {
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === "codex:scheduled-automations:list") return { items: automations };
      if (channel === "codex:model:list") {
        if (modelListState === "loading") return new Promise<never>(() => undefined);
        return CODEX_MODELS;
      }
      if (channel === "worktrees:environments:list") {
        const projectId = String(args[0] ?? "");
        return WORKTREE_ENVIRONMENTS_BY_PROJECT[projectId] ?? [];
      }
      if (channel === "codex:automation-runs:inbox-items") {
        const unreadRuns = automationRuns.filter((item) => item.readAt === null);
        return {
          items: automationRuns,
          unreadRunCounts: {
            total: unreadRuns.length,
            automationIds: [...new Set(unreadRuns.map((item) => item.automationId))],
            unreadRuns: unreadRuns.map((item) => ({
              automationId: item.automationId,
              threadId: item.threadId,
            })),
          },
        } satisfies CodexAutomationRunsInboxResponse;
      }
      if (channel === "codex:automation-runs:archive") {
        const threadId = String((args[0] as { threadId?: string } | undefined)?.threadId ?? "");
        setAutomationRuns(
          automationRuns.map((item) =>
            item.threadId === threadId
              ? {
                  ...item,
                  status: "ARCHIVED",
                  readAt: item.readAt ?? Date.now(),
                  archivedReason: "manual",
                }
              : item,
          ),
        );
        return { success: automationRuns.some((item) => item.threadId === threadId) };
      }
      if (channel === "codex:automation-runs:unarchive") {
        const threadId = String((args[0] as { threadId?: string } | undefined)?.threadId ?? "");
        setAutomationRuns(
          automationRuns.map((item) =>
            item.threadId === threadId
              ? {
                  ...item,
                  status: "ACCEPTED",
                  readAt: item.readAt ?? Date.now(),
                  archivedReason: null,
                }
              : item,
          ),
        );
        return { success: automationRuns.some((item) => item.threadId === threadId) };
      }
      if (channel === "codex:automation-runs:delete") {
        const threadId = String((args[0] as { threadId?: string } | undefined)?.threadId ?? "");
        setAutomationRuns(automationRuns.filter((item) => item.threadId !== threadId));
        return { success: automationRuns.some((item) => item.threadId === threadId) };
      }
      if (channel === "codex:automation-runs:set-read-state") {
        const input = args[0] as { threadId?: string; readAt?: number | null };
        let updated: CodexAutomationInboxItem | null = null;
        setAutomationRuns(
          automationRuns.map((item) => {
            if (item.threadId !== input.threadId) return item;
            updated = { ...item, readAt: input.readAt ?? null };
            return updated;
          }),
        );
        return updated;
      }
      if (channel === "codex:scheduled-automations:run-now") return { success: true };
      if (channel === "codex:scheduled-automations:create") {
        const saved = storyAutomationFromInput(args[0] as CodexScheduledAutomationCreateInput);
        setAutomations(upsertStoryAutomation(automations, saved));
        return { item: saved };
      }
      if (channel === "codex:scheduled-automations:update") {
        const saved = storyAutomationFromInput(args[0] as CodexScheduledAutomationUpdateInput);
        setAutomations(upsertStoryAutomation(automations, saved));
        return { item: saved };
      }
      if (channel === "codex:scheduled-automations:delete") {
        const automationId = String((args[0] as { id?: string } | undefined)?.id ?? "");
        const item = automations.find((automation) => automation.id === automationId) ?? null;
        setAutomations(automations.filter((automation) => automation.id !== automationId));
        return {
          item,
          success: true,
          status: item ? "deleted" : "not_found",
        };
      }
      return null;
    },
    on: () => () => undefined,
  } as typeof window.api;
}

function dispatchPointerDown(element: HTMLElement): void {
  const eventInit = {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
    ctrlKey: false,
  };
  const pointerEvent =
    typeof window.PointerEvent === "function"
      ? new window.PointerEvent("pointerdown", { ...eventInit, pointerType: "mouse" })
      : new MouseEvent("pointerdown", eventInit);
  element.dispatchEvent(pointerEvent);
}

function activateStoryTrigger(root: HTMLElement | null, selector: string): void {
  const trigger = root?.querySelector<HTMLElement>(selector);
  if (!trigger) return;
  dispatchPointerDown(trigger);
}

function setStoryInputValue(input: HTMLInputElement | null, value: string): void {
  if (!input) return;
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const EMPTY_AUTOMATION_RUNS: CodexAutomationInboxItem[] = [];

function AutomationsRouteShellStory({
  initialPath,
  automations = AUTOMATIONS,
  automationRuns = EMPTY_AUTOMATION_RUNS,
  autoOpenDeleteDialog = false,
  autoOpenDiscardDialog = false,
  autoOpenSchedulePopover = false,
  autoOpenCreateMenu = false,
  autoOpenProjectDropdown = false,
  autoOpenRunInDropdown = false,
  autoOpenModelDropdown = false,
  autoSearchTasksQuery,
  autoSearchTemplatesQuery,
  autoSelectTemplateId,
  modelListState = "loaded",
}: {
  initialPath: string;
  automations?: CodexScheduledAutomation[];
  automationRuns?: CodexAutomationInboxItem[];
  autoOpenDeleteDialog?: boolean;
  autoOpenDiscardDialog?: boolean;
  autoOpenSchedulePopover?: boolean;
  autoOpenCreateMenu?: boolean;
  autoOpenProjectDropdown?: boolean;
  autoOpenRunInDropdown?: boolean;
  autoOpenModelDropdown?: boolean;
  autoSearchTasksQuery?: string;
  autoSearchTemplatesQuery?: string;
  autoSelectTemplateId?: string;
  modelListState?: StoryModelListState;
}) {
  const [automationState, setAutomationState] = useState(automations);
  const [automationRunState, setAutomationRunState] = useState(automationRuns);
  const rootRef = useRef<HTMLDivElement>(null);
  installAutomationsStoryApi({
    automations: automationState,
    setAutomations: setAutomationState,
    automationRuns: automationRunState,
    setAutomationRuns: setAutomationRunState,
    modelListState,
  });
  const [path, setPath] = useState(initialPath);
  const queryClient = useMemo(createStoryQueryClient, []);

  useEffect(() => {
    setPath(initialPath);
  }, [initialPath]);

  useEffect(() => {
    if (!autoOpenDeleteDialog) return;
    const timeout = window.setTimeout(() => {
      const detailRail = rootRef.current?.querySelector('[data-testid="automation-detail-rail"]');
      const buttons = Array.from(detailRail?.querySelectorAll("button") ?? []);
      const deleteButton = buttons.find((button) => button.textContent?.trim() === "Delete");
      deleteButton?.click();
    }, 100);
    return () => window.clearTimeout(timeout);
  }, [autoOpenDeleteDialog]);

  useEffect(() => {
    if (!autoOpenDiscardDialog) return;
    let attempts = 0;
    let timeout: number | undefined;
    const openDiscardDialog = () => {
      attempts += 1;
      const nameInput = rootRef.current?.querySelector<HTMLInputElement>(
        'input[aria-label="Name"]',
      );
      const collapseButton = rootRef.current?.querySelector<HTMLButtonElement>(
        'button[aria-label="Collapse details"]',
      );
      if (!nameInput || !collapseButton) {
        if (attempts < 6) timeout = window.setTimeout(openDiscardDialog, 100);
        return;
      }
      setStoryInputValue(nameInput, "Draft only");
      timeout = window.setTimeout(() => collapseButton.click(), 75);
    };
    timeout = window.setTimeout(openDiscardDialog, 150);
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [autoOpenDiscardDialog]);

  useEffect(() => {
    if (!autoOpenSchedulePopover) return;
    const timeout = window.setTimeout(() => {
      const scheduleButton = rootRef.current?.querySelector<HTMLButtonElement>(
        'button[aria-label="Schedule"]',
      );
      scheduleButton?.click();
    }, 100);
    return () => window.clearTimeout(timeout);
  }, [autoOpenSchedulePopover]);

  useEffect(() => {
    if (!autoOpenCreateMenu) return;
    const timeout = window.setTimeout(() => {
      activateStoryTrigger(rootRef.current, 'button[aria-label="New scheduled task options"]');
    }, 100);
    return () => window.clearTimeout(timeout);
  }, [autoOpenCreateMenu]);

  useEffect(() => {
    if (!autoOpenProjectDropdown) return;
    const timeout = window.setTimeout(() => {
      activateStoryTrigger(rootRef.current, 'button[aria-label="Project"]');
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [autoOpenProjectDropdown]);

  useEffect(() => {
    if (!autoOpenRunInDropdown) return;
    const timeout = window.setTimeout(() => {
      activateStoryTrigger(rootRef.current, 'button[aria-label="Execution environment"]');
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [autoOpenRunInDropdown]);

  useEffect(() => {
    if (!autoOpenModelDropdown) return;
    const timeout = window.setTimeout(() => {
      const trigger = rootRef.current?.querySelector<HTMLButtonElement>(
        'button[aria-label="Model and reasoning"]',
      );
      if (!trigger || trigger.disabled) return;
      dispatchPointerDown(trigger);
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [autoOpenModelDropdown]);

  useEffect(() => {
    if (!autoSearchTasksQuery) return;
    const timeout = window.setTimeout(() => {
      const input =
        rootRef.current?.querySelector<HTMLInputElement>(
          'input[aria-label="Search scheduled tasks"]',
        ) ?? null;
      setStoryInputValue(input, autoSearchTasksQuery);
    }, 100);
    return () => window.clearTimeout(timeout);
  }, [autoSearchTasksQuery]);

  useEffect(() => {
    if (!autoSearchTemplatesQuery) return;
    const timeout = window.setTimeout(() => {
      const input =
        rootRef.current?.querySelector<HTMLInputElement>('input[aria-label="Search templates"]') ??
        null;
      setStoryInputValue(input, autoSearchTemplatesQuery);
    }, 100);
    return () => window.clearTimeout(timeout);
  }, [autoSearchTemplatesQuery]);

  useEffect(() => {
    if (!autoSelectTemplateId) return;
    const timeout = window.setTimeout(() => {
      const template = rootRef.current?.querySelector<HTMLButtonElement>(
        `[data-testid="automation-template-${autoSelectTemplateId}"]`,
      );
      template?.click();
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [autoSelectTemplateId]);

  return (
    <QueryClientProvider client={queryClient}>
      <div ref={rootRef} className="h-screen w-screen bg-token-main-surface-primary">
        <WorkbenchAutomationsRouteShell path={path} projects={PROJECTS} onPathChange={setPath} />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Workbench/AutomationsRouteShell",
  component: AutomationsRouteShellStory,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof AutomationsRouteShellStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Tasks: Story = {
  args: {
    initialPath: buildAutomationsPath(),
  },
};

export const SelectedTask: Story = {
  args: {
    initialPath: buildAutomationsPath({ automationId: "automation-standup" }),
  },
};

export const CreateTaskMenu: Story = {
  args: {
    initialPath: buildAutomationsPath(),
    autoOpenCreateMenu: true,
  },
};

export const PreviousRuns: Story = {
  args: {
    initialPath: buildAutomationsPath({ automationId: "automation-history" }),
    automations: [HISTORY_AUTOMATION, ...AUTOMATIONS],
    automationRuns: HISTORY_AUTOMATION_RUNS,
  },
};

export const EmptyTasks: Story = {
  args: {
    initialPath: buildAutomationsPath(),
    automations: [],
  },
};

export const TasksSearchEmpty: Story = {
  args: {
    initialPath: buildAutomationsPath(),
    autoSearchTasksQuery: "no matching scheduled task",
  },
};

export const Templates: Story = {
  args: {
    initialPath: buildAutomationsPath({ tab: "templates" }),
  },
};

export const TemplatesSearchEmpty: Story = {
  args: {
    initialPath: buildAutomationsPath({ tab: "templates" }),
    autoSearchTemplatesQuery: "no matching template",
  },
};

export const TemplateSelectedCreateTask: Story = {
  args: {
    initialPath: buildAutomationsPath({ tab: "templates" }),
    autoSelectTemplateId: "daily-bug-scan",
  },
};

export const CreateTask: Story = {
  args: {
    initialPath: buildAutomationsPath({ automationMode: "create" }),
  },
};

export const CreateTaskSchedulePopover: Story = {
  args: {
    initialPath: buildAutomationsPath({ automationMode: "create" }),
    autoOpenSchedulePopover: true,
  },
};

export const CreateTaskProjectDropdown: Story = {
  args: {
    initialPath: buildAutomationsPath({ automationMode: "create" }),
    autoOpenProjectDropdown: true,
  },
};

export const CreateTaskRunInDropdown: Story = {
  args: {
    initialPath: buildAutomationsPath({ automationMode: "create" }),
    autoOpenRunInDropdown: true,
  },
};

export const CreateTaskModelLoading: Story = {
  args: {
    initialPath: buildAutomationsPath({ automationMode: "create" }),
    modelListState: "loading",
  },
};

export const CreateTaskModelDropdown: Story = {
  args: {
    initialPath: buildAutomationsPath({ automationMode: "create" }),
    autoOpenModelDropdown: true,
  },
};

export const DeleteConfirmation: Story = {
  args: {
    initialPath: buildAutomationsPath({ automationId: "automation-standup" }),
    autoOpenDeleteDialog: true,
  },
};

export const DispageDraftConfirmation: Story = {
  args: {
    initialPath: buildAutomationsPath({ automationMode: "create" }),
    autoOpenDiscardDialog: true,
  },
};

export const MissingTask: Story = {
  args: {
    initialPath: buildAutomationsPath({ automationId: "automation-missing" }),
  },
};
