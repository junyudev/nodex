import { useSyncExternalStore } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import type { AgentBackendSessionPresentation } from "../../../shared/agent-conversation";
import type { CodexThreadSummary } from "../../../shared/types";
import type {
  AgentConversationOwnerPort,
  AgentConversationOwnerSnapshot,
} from "./agent-conversation-owner";
import type { ConversationRuntime } from "./conversation-runtime";
import {
  createAgentConversationRuntime,
  useAgentConversationAdapter,
} from "./agent-conversation-adapter";
import { nativeAgentDraftOwner } from "../../lib/native-agent-draft-owner";
import { useConversationRuntimeTaskObservations } from "./conversation-runtime-hooks";

const mocks = vi.hoisted(() => ({
  readPermission: vi.fn(async () => "auto"),
  setPermission: vi.fn(async (_projectId: string | null, mode: string) => mode),
  acquire: vi.fn(),
  catalog: vi.fn(),
  startThread: vi.fn(),
}));

vi.mock("../../lib/api", () => ({ readPastedTextAttachment: vi.fn() }));
vi.mock("../../lib/workspace-catalog-commands", () => ({
  workspaceSessionCommands: { markUnread: vi.fn() },
}));
vi.mock("../../components/ui/toast", () => ({ toast: { error: vi.fn() } }));
vi.mock("../../lib/agent-backend-runtime", () => ({
  agentBackendRuntime: {
    readPermissionMode: mocks.readPermission,
    setPermissionMode: mocks.setPermission,
    startThread: mocks.startThread,
  },
}));
vi.mock("./use-claude-model-catalog", () => ({ useClaudeModelCatalog: mocks.catalog }));
vi.mock("./agent-conversation-owner", () => ({ acquireAgentConversationOwner: mocks.acquire }));

const summary: CodexThreadSummary = {
  threadId: "thread",
  projectId: "project",
  source: null,
  threadName: "Work",
  threadPreview: "",
  cwd: "/workspace",
  statusType: "idle",
  statusActiveFlags: [],
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  linkedAt: "2026-09-30T00:00:00Z",
};

const presentation: AgentBackendSessionPresentation = {
  snapshot: {
    backend: "claude",
    threadId: "thread",
    sessionId: "native",
    status: "idle",
    error: null,
    turns: [],
    revision: 1,
    tasks: [
      {
        id: "watch",
        description: "Watch",
        status: "running",
        bornTurnSequence: 1,
        backgrounded: true,
      },
    ],
    liveBackgroundTaskIds: ["watch"],
  },
  configOptions: [],
  modes: null,
  capabilities: {
    prompt: { text: true, image: true, audio: false, resourceLink: true, embeddedContext: false },
    session: {
      load: true,
      list: false,
      delete: false,
      resume: true,
      unstableFork: false,
      close: true,
      additionalDirectories: false,
    },
    authMethods: [],
  },
};

function RuntimeProbe({
  runtime,
  threadId,
}: {
  runtime: ConversationRuntime;
  threadId: string | null;
}) {
  const subscribe = (listener: () => void) => runtime.subscribe(threadId, listener);
  const children = useSyncExternalStore(subscribe, () => runtime.children(threadId));
  const attachment = useSyncExternalStore(subscribe, () => runtime.attachment(threadId));
  return (
    <output role="status">
      {children.length}:{children[0]?.statusType ?? "none"}:{attachment.status}
    </output>
  );
}

test("native drafts expose stable empty stores and mount without update loops", () => {
  const runtime = createAgentConversationRuntime("claude", null, null, "draft");
  expect(runtime.children(null)).toBe(runtime.children(null));
  expect(runtime.attachment(null)).toBe(runtime.attachment(null));
  const view = render(<RuntimeProbe runtime={runtime} threadId={null} />);
  expect(view.getByRole("status").textContent).toBe("0:none:idle");
  view.rerender(<RuntimeProbe runtime={runtime} threadId={null} />);
  expect(view.getByRole("status").textContent).toBe("0:none:idle");
});

test("native task and attachment stores update once per owner snapshot and retain stable reads", async () => {
  let state: AgentConversationOwnerSnapshot = {
    connection: "ready",
    presentation,
    promptPending: false,
    controlPending: null,
    error: null,
  };
  const listeners = new Set<() => void>();
  const owner = {
    threadId: "thread",
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as AgentConversationOwnerPort;
  const runtime = createAgentConversationRuntime("claude", summary, owner, "session");
  const children = runtime.children("thread");
  const attachment = runtime.attachment("thread");
  expect(runtime.children("thread")).toBe(children);
  expect(runtime.attachment("thread")).toBe(attachment);
  const view = render(<RuntimeProbe runtime={runtime} threadId="thread" />);
  expect(view.getByRole("status").textContent).toBe("1:active:attached");
  await act(async () => {
    state = {
      ...state,
      presentation: {
        ...presentation,
        snapshot: { ...presentation.snapshot, revision: 2, liveBackgroundTaskIds: [] },
      },
    };
    for (const listener of listeners) listener();
  });
  expect(view.getByRole("status").textContent).toBe("1:idle:attached");
  expect(runtime.children("thread")).not.toBe(children);
  expect(runtime.children("thread")).toBe(runtime.children("thread"));
  expect(runtime.attachment("thread")).toBe(runtime.attachment("thread"));
});

test("native task observations share one owner subscription across visible children", async () => {
  let state: AgentConversationOwnerSnapshot = {
    connection: "ready",
    presentation: {
      ...presentation,
      snapshot: {
        ...presentation.snapshot,
        tasks: [
          ...(presentation.snapshot.tasks ?? []),
          { id: "review", description: "Review", status: "running", bornTurnSequence: 1 },
        ],
        liveBackgroundTaskIds: ["watch", "review"],
      },
    },
    promptPending: false,
    controlPending: null,
    error: null,
  };
  const listeners = new Set<() => void>();
  const owner = {
    threadId: "thread",
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as AgentConversationOwnerPort;
  const runtime = createAgentConversationRuntime("claude", summary, owner, "session");
  const view = renderHook(() => useConversationRuntimeTaskObservations(runtime, "thread"));
  expect(listeners.size).toBe(1);
  expect(view.result.current.map((entry) => entry.membership.threadId)).toEqual([
    "agent-task:thread:watch",
    "agent-task:thread:review",
  ]);
  expect(view.result.current.every((entry) => entry.membership.statusType === "active")).toBe(true);
  expect(
    view.result.current.every(
      (entry) => entry.conversation?.threadId === entry.membership.threadId,
    ),
  ).toBe(true);
  await act(async () => {
    const current = state.presentation;
    if (!current) throw new Error("Expected native presentation");
    state = {
      ...state,
      presentation: {
        ...current,
        snapshot: {
          ...current.snapshot,
          revision: 2,
          tasks: current.snapshot.tasks?.map((task) => ({ ...task, status: "completed" })),
          liveBackgroundTaskIds: [],
        },
      },
    };
    for (const listener of listeners) listener();
  });
  expect(view.result.current.every((entry) => entry.membership.statusType === "idle")).toBe(true);
  expect(listeners.size).toBe(1);
  view.unmount();
  expect(listeners.size).toBe(0);
});

const modelOptions = [
  {
    value: "opus",
    name: "Opus",
    description: null,
    reasoningEfforts: ["medium", "high"],
    fastMode: true,
    disableThinking: true,
  },
  { value: "sonnet", name: "Sonnet", description: null, reasoningEfforts: ["medium", "high"] },
];
const hookInput = (sessionId: string, threadSummary: CodexThreadSummary | null = null) => ({
  binding: { kind: "claude" as const, instanceConfigId: "work" },
  summary: threadSummary,
  onRefresh: async () => {},
  sessionProjectId: "project",
  modelProjectId: "project",
  sessionId,
  ensureDraft: async () => {
    throw new Error("Unexpected draft materialization");
  },
});
const configureCatalog = () =>
  mocks.catalog.mockReturnValue({
    options: modelOptions,
    error: null,
    discovery: {
      models: modelOptions,
      commands: [],
      skills: [],
      intelligence: { model: "opus", effort: "medium", fast: false, thinking: true },
    },
  });

test("native first submission preserves the selected worktree, environment, and starting state", async () => {
  configureCatalog();
  mocks.startThread.mockResolvedValueOnce({ thread: { threadId: "native-worktree" } });
  const refresh = vi.fn(async () => {});
  const { result } = renderHook(() =>
    useAgentConversationAdapter({ ...hookInput("worktree-draft"), onRefresh: refresh }),
  );
  await waitFor(() => expect(result.current.controls.permissionMode).toBe(true));
  await act(async () => {
    await result.current.actions.onStartThreadForSession?.({
      projectId: "project",
      sessionId: "worktree-draft",
      prompt: "Build in a worktree",
      runInTarget: "newWorktree",
      runInEnvironmentPath: ".codex/environments/development.toml",
      worktreeStartingState: { type: "working-tree" },
    });
  });
  expect(mocks.startThread).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sessionId: "worktree-draft",
      backendKind: "claude",
      instanceConfigId: "work",
      prompt: "Build in a worktree",
      runInTarget: "newWorktree",
      runInEnvironmentPath: ".codex/environments/development.toml",
      worktreeStartingState: { type: "working-tree" },
    }),
  );
  expect(refresh).toHaveBeenLastCalledWith("project");
});

test("native drafts display resolved choices and save permissions before a first prompt", async () => {
  configureCatalog();
  mocks.readPermission.mockResolvedValueOnce("guardian-approvals");
  const { result } = renderHook(() => useAgentConversationAdapter(hookInput("permission-draft")));
  await waitFor(() => expect(result.current.permissionMode).toBe("guardian-approvals"));
  expect(result.current.selectedModel).toBe("opus");
  expect(result.current.selectedEffort).toBe("medium");
  expect(result.current.nativeIntelligence?.selected.context).toBeUndefined();
  expect(result.current.nativeIntelligence?.selected.contextInherited).toBe(true);
  expect(result.current.nativeIntelligence?.selected).toMatchObject({
    fast: false,
    thinking: true,
  });
  await act(async () => {
    await result.current.actions.onPermissionModeChange?.("full-access");
  });
  expect(mocks.setPermission).toHaveBeenLastCalledWith("project", "full-access");
  expect(result.current.permissionMode).toBe("full-access");
});

test("a late permission save cannot replace the newly selected Project's state", async () => {
  configureCatalog();
  mocks.readPermission.mockResolvedValueOnce("auto").mockResolvedValueOnce("guardian-approvals");
  let complete!: (mode: string) => void;
  mocks.setPermission.mockReturnValueOnce(
    new Promise<string>((resolve) => {
      complete = resolve;
    }),
  );
  const { result, rerender } = renderHook((input) => useAgentConversationAdapter(input), {
    initialProps: hookInput("permission-race"),
  });
  await waitFor(() => expect(result.current.controls.permissionMode).toBe(true));
  let save: Promise<void> | void;
  await act(async () => {
    save = result.current.actions.onPermissionModeChange?.("full-access");
  });
  rerender({ ...hookInput("permission-race"), modelProjectId: "other-project" });
  await waitFor(() => expect(result.current.permissionMode).toBe("guardian-approvals"));
  await act(async () => {
    complete("full-access");
    await save;
  });
  expect(result.current.permissionMode).toBe("guardian-approvals");
});

test("draft permissions stay unavailable until the actual Core preference is known", async () => {
  configureCatalog();
  let complete!: (mode: string) => void;
  mocks.readPermission.mockReturnValueOnce(
    new Promise<string>((resolve) => {
      complete = resolve;
    }),
  );
  const { result } = renderHook(() => useAgentConversationAdapter(hookInput("unknown-permission")));
  expect(result.current.controls.permissionMode).toBe(false);
  await act(async () => {
    complete("full-access");
  });
  await waitFor(() => expect(result.current.controls.permissionMode).toBe(true));
  expect(result.current.permissionMode).toBe("full-access");
});

test("native drafts preserve independent settings while changing model or effort", async () => {
  configureCatalog();
  const input = hookInput("intelligence-draft");
  const key = JSON.stringify([input.sessionId, "project", "claude", "work"]);
  nativeAgentDraftOwner.write(key, {
    selection: { model: "opus", effort: "high", fast: true, thinking: false, context: "1m" },
  });
  const { result } = renderHook(() => useAgentConversationAdapter(input));
  await waitFor(() => expect(mocks.readPermission).toHaveBeenCalled());
  await act(async () => {
    await result.current.actions.onIntelligenceSelectionChange?.({
      kind: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
      serviceTier: null,
    });
  });
  expect(nativeAgentDraftOwner.read(key).selection).toEqual({
    model: "sonnet",
    effort: "medium",
    fast: true,
  });
  await act(async () => {
    await result.current.nativeIntelligence?.change({ effort: "high", thinking: true });
  });
  expect(nativeAgentDraftOwner.read(key).selection).toEqual({
    model: "sonnet",
    effort: "high",
    fast: true,
    thinking: true,
  });
  await act(async () => {
    nativeAgentDraftOwner.clear(key);
  });
});

test("live native presentation shows applied choices while preserving requested inheritance on edits", async () => {
  configureCatalog();
  const state: AgentConversationOwnerSnapshot = {
    connection: "ready",
    promptPending: false,
    controlPending: null,
    error: null,
    presentation: {
      ...presentation,
      configOptions: [
        {
          id: "model",
          name: "Model",
          description: null,
          category: "model",
          type: "select",
          currentValue: "opus",
          options: modelOptions,
        },
      ],
      snapshot: {
        ...presentation.snapshot,
        metadata: {
          revision: 1,
          configOptions: [],
          modes: null,
          capabilities: presentation.capabilities,
          requestedSelection: { model: "default", effort: "default", fast: true, context: "1m" },
          effectiveSelection: { model: "opus", effort: "medium", fast: true, thinking: true },
          permissionMode: "full-access",
        },
      },
    },
  };
  const setIntelligence = vi.fn(async () => true);
  const control = vi.fn(async () => false);
  mocks.acquire.mockReturnValue({
    retain: () => () => {},
    owner: {
      threadId: "thread",
      getSnapshot: () => state,
      subscribe: () => () => {},
      setIntelligence,
      control,
    },
  });
  const { result } = renderHook(() => useAgentConversationAdapter(hookInput("live", summary)));
  await waitFor(() => expect(result.current.permissionMode).toBe("full-access"));
  expect(result.current.selectedModel).toBe("opus");
  expect(result.current.selectedEffort).toBe("medium");
  expect(result.current.nativeIntelligence?.selected.context).toBeUndefined();
  expect(result.current.nativeIntelligence?.selected.contextInherited).toBe(false);
  await act(async () => {
    await result.current.nativeIntelligence?.change({ effort: "high", thinking: true });
  });
  expect(setIntelligence).toHaveBeenLastCalledWith({
    model: "default",
    effort: "high",
    fast: true,
    context: "1m",
    thinking: true,
  });
  await act(async () => {
    await result.current.nativeIntelligence?.change({ context: null });
  });
  expect(setIntelligence).toHaveBeenLastCalledWith({
    model: "default",
    effort: "default",
    fast: true,
  });
  await act(async () => {
    await expect(result.current.actions.onPermissionModeChange?.("auto")).rejects.toThrow(
      "not accepted",
    );
  });
  expect(control).toHaveBeenLastCalledWith({ kind: "permission-mode", mode: "auto" });
  expect(result.current.permissionMode).toBe("full-access");
});

test("generic drafts send advertised per-model controls and native mode IDs with the first prompt", async () => {
  configureCatalog();
  const { modelCatalog } = await import("../../lib/agent-model-catalog.test-fixtures");
  const binding = { kind: "opencode", instanceConfigId: "local" } as const;
  const catalog = modelCatalog({
    modelConfigOptions: {
      "moonshot/kimi-k3": [
        {
          type: "select",
          id: "variant",
          name: "Variant",
          category: "thought_level",
          description: null,
          currentValue: "balanced",
          options: [
            { value: "balanced", name: "Balanced", description: null },
            { value: "deep", name: "Deep", description: null },
          ],
        },
        {
          type: "boolean",
          id: "memory",
          name: "Memory",
          category: null,
          description: null,
          currentValue: false,
        },
      ],
      "local/small": [],
    },
    modes: {
      currentModeId: "build",
      availableModes: [
        { id: "build", name: "Build", description: null },
        { id: "review", name: "Review", description: null },
      ],
    },
  });
  mocks.startThread.mockResolvedValueOnce({ thread: { threadId: "opencode-first" } });
  const input = { ...hookInput("generic-first"), binding, catalog };
  const { result } = renderHook(() => useAgentConversationAdapter(input));
  expect(result.current.selectedModel).toBe("moonshot/kimi-k3");
  expect(result.current.reasoningEffortOptions).toEqual([]);
  await act(async () => {
    await result.current.genericIntelligence?.changeConfig("variant", "deep");
    await result.current.genericIntelligence?.changeMode("review");
  });
  await act(async () => {
    await result.current.genericIntelligence?.changeConfig("memory", true);
  });
  await act(async () => {
    await result.current.actions.onStartThreadForSession?.({
      projectId: "project",
      sessionId: "generic-first",
      prompt: "Check this",
      runInTarget: "localProject",
    });
  });
  expect(mocks.startThread).toHaveBeenLastCalledWith(
    expect.objectContaining({
      backendKind: "opencode",
      instanceConfigId: "local",
      model: "moonshot/kimi-k3",
      modeId: "review",
      configOptions: [
        { id: "variant", value: "deep" },
        { id: "memory", value: true },
      ],
    }),
  );
});

test("generic draft model changes remove stale controls and gate image input by advertised modalities", async () => {
  configureCatalog();
  const { modelCatalog, catalogModel } =
    await import("../../lib/agent-model-catalog.test-fixtures");
  const catalog = modelCatalog({
    models: [
      { ...catalogModel("moonshot/kimi-k3"), inputModalities: ["text", "image"] },
      catalogModel("local/small"),
    ],
    modelConfigOptions: {
      "moonshot/kimi-k3": [
        {
          type: "boolean",
          id: "memory",
          name: "Memory",
          category: null,
          description: null,
          currentValue: true,
        },
      ],
      "local/small": [],
    },
  });
  const { result } = renderHook(() =>
    useAgentConversationAdapter({
      ...hookInput("generic-modality"),
      binding: { kind: "opencode", instanceConfigId: "local" },
      catalog,
    }),
  );
  expect(result.current.controls.images).toBe(true);
  await act(async () => {
    await result.current.actions.onModelChange?.("local/small");
  });
  expect(result.current.controls.images).toBe(false);
  expect(result.current.genericIntelligence?.configOptions).toEqual([]);
});

test("ACP negotiates its first session without inventing a pre-session model", async () => {
  configureCatalog();
  const { modelCatalog } = await import("../../lib/agent-model-catalog.test-fixtures");
  const binding = {
    kind: "acp",
    instanceConfigId: "acp-local",
    agentDefinitionId: "custom-agent",
  } as const;
  const catalog = modelCatalog({
    binding,
    models: [],
    defaultModel: null,
    health: { status: "unavailable", error: "Models are available after connecting" },
  });
  mocks.startThread.mockResolvedValueOnce({ thread: { threadId: "acp-first" } });
  const { result } = renderHook(() =>
    useAgentConversationAdapter({ ...hookInput("acp-first"), binding, catalog }),
  );
  expect(result.current.models).toEqual([]);
  expect(result.current.selectedModel).toBe("");
  await act(async () => {
    await result.current.actions.onStartThreadForSession?.({
      projectId: "project",
      sessionId: "acp-first",
      prompt: "Connect and inspect",
      runInTarget: "localProject",
    });
  });
  const request = mocks.startThread.mock.lastCall?.[0];
  expect(request).toMatchObject({ backendKind: "acp", instanceConfigId: "acp-local" });
  expect(request).not.toHaveProperty("model");
});

test("attached ACP model controls come from its live descriptors while pre-session discovery is unavailable", async () => {
  configureCatalog();
  const { modelCatalog } = await import("../../lib/agent-model-catalog.test-fixtures");
  const binding = {
    kind: "acp",
    instanceConfigId: "local",
    agentDefinitionId: "custom-agent",
  } as const;
  const state: AgentConversationOwnerSnapshot = {
    connection: "ready",
    promptPending: false,
    controlPending: null,
    error: null,
    presentation: {
      ...presentation,
      snapshot: { ...presentation.snapshot, backend: "acp" },
      configOptions: [
        {
          type: "select",
          id: "native-model-setting",
          name: "Model",
          category: "model",
          description: null,
          currentValue: "native/first",
          options: [
            { value: "native/first", name: "First", description: null },
            { value: "native/next", name: "Next", description: null },
          ],
        },
      ],
    },
  };
  const setConfigOption = vi.fn(async () => true);
  const owner = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    setConfigOption,
  } as unknown as AgentConversationOwnerPort;
  mocks.acquire.mockReturnValue({ owner, retain: () => () => {} });
  const { result } = renderHook(() =>
    useAgentConversationAdapter({
      ...hookInput("acp-live", summary),
      binding,
      catalog: modelCatalog({
        binding,
        models: [],
        defaultModel: null,
        health: { status: "unavailable", error: null },
      }),
    }),
  );
  expect(result.current.models.map(({ id }) => id)).toEqual(["native/first", "native/next"]);
  expect(result.current.selectedModel).toBe("native/first");
  await act(async () => {
    await result.current.actions.onModelChange?.("native/next");
  });
  expect(setConfigOption).toHaveBeenCalledWith("native-model-setting", "native/next");
});

test("an unavailable draft profile preserves its model but blocks native startup before creating a thread", async () => {
  configureCatalog();
  const { nativeAgentDraftKey } = await import("../../lib/native-agent-draft-owner");
  const binding = { kind: "opencode", instanceConfigId: "disabled" } as const;
  const key = nativeAgentDraftKey("unavailable-draft", "project", binding);
  nativeAgentDraftOwner.write(key, { selection: { model: "moonshot/kimi-k3", effort: "default" } });
  mocks.startThread.mockClear();
  const { result } = renderHook(() =>
    useAgentConversationAdapter({
      ...hookInput("unavailable-draft"),
      binding,
      catalog: null,
      draftUnavailableReason: "This Agent profile is disabled.",
    }),
  );
  expect(result.current.selectedModel).toBe("moonshot/kimi-k3");
  await act(async () => {
    await expect(
      result.current.actions.onStartThreadForSession?.({
        projectId: "project",
        sessionId: "unavailable-draft",
        prompt: "Keep this draft",
        runInTarget: "localProject",
      }),
    ).rejects.toThrow("This Agent profile is disabled.");
  });
  expect(mocks.startThread).not.toHaveBeenCalled();
  expect(nativeAgentDraftOwner.read(key).selection.model).toBe("moonshot/kimi-k3");
});
