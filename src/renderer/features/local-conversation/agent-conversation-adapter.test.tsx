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

const mocks = vi.hoisted(() => ({
  readPermission: vi.fn(async () => "auto"),
  setPermission: vi.fn(async (_projectId: string | null, mode: string) => mode),
  acquire: vi.fn(),
  catalog: vi.fn(),
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

test("native drafts display resolved choices and save permissions before a first prompt", async () => {
  configureCatalog();
  mocks.readPermission.mockResolvedValueOnce("guardian-approvals");
  const { result } = renderHook(() => useAgentConversationAdapter(hookInput("permission-draft")));
  await waitFor(() => expect(result.current.permissionMode).toBe("guardian-approvals"));
  expect(result.current.selectedModel).toBe("opus");
  expect(result.current.selectedEffort).toBe("medium");
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
    context: "1m",
  });
  await act(async () => {
    await result.current.nativeIntelligence?.change({ effort: "high", thinking: true });
  });
  expect(nativeAgentDraftOwner.read(key).selection).toEqual({
    model: "sonnet",
    effort: "high",
    fast: true,
    thinking: true,
    context: "1m",
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
    await expect(result.current.actions.onPermissionModeChange?.("auto")).rejects.toThrow(
      "not accepted",
    );
  });
  expect(control).toHaveBeenLastCalledWith({ kind: "permission-mode", mode: "auto" });
  expect(result.current.permissionMode).toBe("full-access");
});
