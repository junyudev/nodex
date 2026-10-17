import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, useState, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AgentSnapshot, AgentTurnItem } from "@nodex/agent-runtime/contracts";
import { agentRuntimeRuntime } from "../../lib/agent-runtime-runtime";
import {
  useAgentRuntimeConversationAdapter,
  type AgentRuntimeProvider,
} from "./agent-runtime-conversation-adapter";
import { sessionFirstSubmissionOwner } from "../conversation-launch/session-first-submission-owner";
import { acquireAgentRuntimeConversationOwner } from "./agent-runtime-conversation-owner";
import { MaitaiProvider, createMaitaiStore } from "../../lib/maitai";
import * as presentation from "../../lib/codex-turn-presentation";
import { TestQueryProvider } from "../../test/query";
import { NodexTooltipProvider } from "../../components/ui/tooltip";
import { ConversationRuntimeContext } from "./conversation-runtime";
import { CodexTranscriptReadOwnerContext } from "./normalized-transcript-hooks";
import { ConversationMarkdownSourceProvider } from "./view/conversation-markdown-source";
import { MarkdownCore } from "./view/shared/markdown/markdown-core";
import { agentRuntimeProviderId } from "../../../shared/agent-runtime-provider";
import { CodexThreadSettingsProvider } from "../../lib/use-codex-thread-settings";
import { CodexServiceTierSettingsProvider } from "../../lib/use-codex-service-tier-settings";
import { THREAD_SETTINGS_STORAGE_KEY } from "../../lib/codex-thread-settings";
import { CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY } from "../../lib/codex-service-tier-settings";
import { openCodeSetupRuntime } from "../../lib/opencode-setup-runtime";
import type { OpenCodeSetupState } from "../../../shared/opencode-setup";
import { readyExecutable, setupState } from "../opencode-setup/opencode-setup.test-fixtures";

function RuntimeWorkbench({ children }: PropsWithChildren) {
  const [store] = useState(createMaitaiStore);
  return <MaitaiProvider store={store}>{children}</MaitaiProvider>;
}

const instances = [] as const;
const provider = {
  instanceId: "codex",
  driver: "codex",
  displayName: "Codex",
  enabled: true,
  installed: true,
  status: "ready",
  models: [{ slug: "model", name: "Model", isDefault: true, isCustom: false, capabilities: null }],
  skills: [],
  slashCommands: [],
} as unknown as AgentRuntimeProvider;
const snapshot = {
  kind: "snapshot",
  snapshotSequence: 1,
  historyCursor: null,
  hasMoreHistory: false,
  latestLocalTurnOrdinal: null,
  payloadBudgetExceeded: false,
  projection: {
    thread: {
      id: "engine-thread",
      projectId: "project",
      title: "Task",
      modelSelection: { instanceId: "codex", model: "model" },
      runtimeMode: "auto",
      interactionMode: "default",
      worktreePath: "/workspace",
      archivedAt: null,
      deletedAt: null,
      forkedFrom: null,
      createdAt: "2026-10-14T00:00:00Z",
      updatedAt: "2026-10-14T00:00:00Z",
      lineage: { rootThreadId: "engine-thread", parentThreadId: null },
    },
    visibleTurnItems: [],
    turnItems: [],
    runs: [],
    runtimeRequests: [],
    nodes: [],
    messages: [],
    subagents: [],
    attempts: [],
    plans: [],
    checkpoints: [],
    checkpointScopes: [],
    contextHandoffs: [],
    contextTransfers: [],
  },
} as unknown as AgentSnapshot;
beforeEach(() => {
  // The Profile-wide activity feed is read once per attachment and shared by every adapter.
  vi.spyOn(agentRuntimeRuntime, "connection").mockResolvedValue({
    status: "ready",
    generation: "generation",
  });
  vi.spyOn(agentRuntimeRuntime, "activity").mockResolvedValue({
    sequence: 1,
    complete: true,
    items: [
      {
        sessionId: "background-session",
        threadId: "engine-thread",
        status: "background",
        activeRunId: null,
        pendingRequestCount: 0,
        activeTaskCount: 1,
        resumesAutomatically: true,
        providerInstanceId: "codex",
        model: "model",
        updatedAt: "2026-10-15T00:00:00Z",
      },
    ],
  });
  vi.spyOn(presentation, "captureCodexTurnPresentation").mockResolvedValue(undefined);
  vi.spyOn(agentRuntimeRuntime, "readQueuePage").mockResolvedValue({
    snapshotSequence: 1,
    entries: [],
    nextCursor: null,
    nextRunId: null,
  });
  vi.spyOn(agentRuntimeRuntime, "readQueuedPreview").mockResolvedValue(null);
  vi.spyOn(agentRuntimeRuntime, "readQueuedMessage").mockResolvedValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  sessionFirstSubmissionOwner.dispose();
});

const codexModel = (slug: string, isDefault = false) => ({
  slug,
  name: slug.toUpperCase(),
  isCustom: false,
  ...(isDefault ? { isDefault: true } : {}),
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select" as const,
        options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
        currentValue: "medium",
      },
      {
        id: "serviceTier",
        label: "Service Tier",
        type: "select" as const,
        options: [
          { id: "default", label: "Standard", isDefault: true },
          { id: "fast", label: "Fast" },
        ],
        currentValue: "default",
      },
    ],
  },
});
const codexProvider = {
  ...provider,
  models: [codexModel("gpt", true), codexModel("gpt-mini")],
} as unknown as AgentRuntimeProvider;

function SavedSettingsWorkbench({ children }: PropsWithChildren) {
  return (
    <RuntimeWorkbench>
      <CodexThreadSettingsProvider>
        <CodexServiceTierSettingsProvider>{children}</CodexServiceTierSettingsProvider>
      </CodexThreadSettingsProvider>
    </RuntimeWorkbench>
  );
}

describe("Agent Runtime Codex controls", () => {
  afterEach(() => {
    localStorage.removeItem(THREAD_SETTINGS_STORAGE_KEY);
    localStorage.removeItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY);
  });

  it("starts a new chat from the saved model, effort and speed", async () => {
    localStorage.setItem(
      THREAD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ model: "gpt-mini", reasoningEffort: "high" }),
    );
    localStorage.setItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY, "fast");
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([codexProvider]);
    const launch = vi
      .spyOn(agentRuntimeRuntime, "launch")
      .mockResolvedValue({ sessionId: "saved-draft", projectId: "project", threadId: "thread" });
    vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
      sessionId: "saved-draft",
      projectId: "project",
      threadId: "thread",
      snapshot,
    });
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
    const { result, unmount } = renderHook(
      () =>
        useAgentRuntimeConversationAdapter({
          sessionId: "saved-draft",
          projectId: "project",
          modelProjectId: "project",
          instances,
          onRefresh: async () => {},
          onOpenThread: () => {},
          ensureDraft: async () => ({ id: "saved-draft" }),
        }),
      { wrapper: SavedSettingsWorkbench },
    );
    await waitFor(() => expect(result.current.selectedModel).toBe("gpt-mini"));
    expect(result.current.selectedEffort).toBe("high");
    expect(result.current.provider.serviceTier).toBe("fast");
    await act(async () => {
      await result.current.actions.onStartThreadForSession!({
        projectId: "project",
        sessionId: "saved-draft",
        prompt: "Go",
      });
    });
    expect(launch.mock.calls[0]![0].modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-mini",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "fast" },
      ],
    });
    await act(async () => unmount());
  });

  it("waits for the Agent catalog when a first message outruns it", async () => {
    let resolveCatalog: (providers: AgentRuntimeProvider[]) => void = () => {};
    vi.spyOn(agentRuntimeRuntime, "catalog").mockReturnValue(
      new Promise((resolve) => {
        resolveCatalog = resolve;
      }),
    );
    const launch = vi
      .spyOn(agentRuntimeRuntime, "launch")
      .mockResolvedValue({ sessionId: "early-draft", projectId: "project", threadId: "thread" });
    vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
      sessionId: "early-draft",
      projectId: "project",
      threadId: "thread",
      snapshot,
    });
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
    const { result, unmount } = renderHook(
      () =>
        useAgentRuntimeConversationAdapter({
          sessionId: "early-draft",
          projectId: "project",
          modelProjectId: "project",
          instances,
          onRefresh: async () => {},
          onOpenThread: () => {},
          ensureDraft: async () => ({ id: "early-draft" }),
        }),
      { wrapper: SavedSettingsWorkbench },
    );
    let started: Promise<void> | undefined;
    await act(async () => {
      started = result.current.actions.onStartThreadForSession!({
        projectId: "project",
        sessionId: "early-draft",
        prompt: "Go",
      });
      await Promise.resolve();
    });
    // The message is already shown; only its launch waits for a model.
    expect(
      sessionFirstSubmissionOwner.getSnapshot().submissions.map(({ prompt }) => prompt),
    ).toEqual(["Go"]);
    expect(launch).not.toHaveBeenCalled();
    await act(async () => {
      resolveCatalog([codexProvider]);
      await started;
    });
    expect(launch.mock.calls[0]![0].modelSelection).toMatchObject({
      instanceId: "codex",
      model: "gpt",
    });
    await act(async () => unmount());
  });

  it("launches a first message once its default Agent is checked, not every Agent", async () => {
    // Another Agent's first check never finishes; the whole catalog stays pending.
    const catalog = vi
      .spyOn(agentRuntimeRuntime, "catalog")
      .mockImplementation((input) =>
        input?.instanceIds ? Promise.resolve([codexProvider]) : new Promise(() => {}),
      );
    const launch = vi
      .spyOn(agentRuntimeRuntime, "launch")
      .mockResolvedValue({ sessionId: "early-draft", projectId: "project", threadId: "thread" });
    vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
      sessionId: "early-draft",
      projectId: "project",
      threadId: "thread",
      snapshot,
    });
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
    const { result, unmount } = renderHook(
      () =>
        useAgentRuntimeConversationAdapter({
          sessionId: "early-draft",
          projectId: "project",
          modelProjectId: "project",
          instances,
          onRefresh: async () => {},
          onOpenThread: () => {},
          ensureDraft: async () => ({ id: "early-draft" }),
        }),
      { wrapper: SavedSettingsWorkbench },
    );
    await act(async () => {
      await result.current.actions.onStartThreadForSession!({
        projectId: "project",
        sessionId: "early-draft",
        prompt: "Go",
      });
    });
    expect(catalog).toHaveBeenCalledWith({ instanceIds: ["codex"] });
    expect(launch.mock.calls[0]![0].modelSelection).toMatchObject({
      instanceId: "codex",
      model: "gpt",
    });
    await act(async () => unmount());
  });

  it("starts later new chats from the last Codex model, effort and speed chosen", async () => {
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([codexProvider]);
    const renderDraft = (sessionId: string) =>
      renderHook(
        () =>
          useAgentRuntimeConversationAdapter({
            sessionId,
            projectId: "project",
            modelProjectId: "project",
            instances,
            onRefresh: async () => {},
            onOpenThread: () => {},
            ensureDraft: async () => ({ id: sessionId }),
          }),
        { wrapper: SavedSettingsWorkbench },
      );
    const first = renderDraft("first-draft");
    await waitFor(() => expect(first.result.current.selectedModel).toBe("gpt"));
    await act(async () => {
      await first.result.current.actions.onIntelligenceSelectionChange!({
        kind: "codex",
        model: "gpt-mini",
        reasoningEffort: "high",
        serviceTier: "fast",
      });
    });
    await act(async () => first.unmount());

    const next = renderDraft("next-draft");
    await waitFor(() => expect(next.result.current.selectedModel).toBe("gpt-mini"));
    expect(next.result.current.selectedEffort).toBe("high");
    expect(next.result.current.provider.serviceTier).toBe("fast");
    await act(async () => next.unmount());
  });

  it("names a bound chat by its Session, not by the prompt its engine Thread started from", async () => {
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([codexProvider]);
    vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
      sessionId: "titled-session",
      projectId: "project",
      threadId: "engine-thread",
      snapshot,
    });
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
    const { result, rerender, unmount } = renderHook(
      ({ sessionTitle }: { sessionTitle: string }) =>
        useAgentRuntimeConversationAdapter({
          sessionId: "titled-session",
          sessionTitle,
          executionRef: { runtimeId: "engine", threadId: "engine-thread" },
          projectId: "project",
          modelProjectId: "project",
          instances,
          onRefresh: async () => {},
          onOpenThread: () => {},
          ensureDraft: async () => ({ id: "titled-session" }),
        }),
      { wrapper: SavedSettingsWorkbench, initialProps: { sessionTitle: "Fix the login" } },
    );
    await waitFor(() => expect(result.current.state.connection).toBe("ready"));
    expect(snapshot.projection.thread.title).not.toBe("Fix the login");
    expect(result.current.summary?.threadName).toBe("Fix the login");
    rerender({ sessionTitle: "Renamed in the sidebar" });
    expect(result.current.summary?.threadName).toBe("Renamed in the sidebar");
    await act(async () => unmount());
  });

  it("applies model, effort and speed in one selection change under Codex's own option ids", async () => {
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([codexProvider]);
    vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
      sessionId: "codex-session",
      projectId: "project",
      threadId: "engine-thread",
      snapshot: {
        ...snapshot,
        projection: {
          ...snapshot.projection,
          thread: {
            ...snapshot.projection.thread,
            modelSelection: { instanceId: "codex", model: "gpt" },
          },
        },
      } as AgentSnapshot,
    });
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
    const setModel = vi.spyOn(agentRuntimeRuntime, "setModel").mockResolvedValue({ sequence: 2 });
    const { result, unmount } = renderHook(
      () =>
        useAgentRuntimeConversationAdapter({
          sessionId: "codex-session",
          executionRef: { runtimeId: "engine", threadId: "engine-thread" },
          projectId: "project",
          modelProjectId: "project",
          instances,
          onRefresh: async () => {},
          onOpenThread: () => {},
          ensureDraft: async () => ({ id: "codex-session" }),
        }),
      { wrapper: SavedSettingsWorkbench },
    );
    await waitFor(() => expect(result.current.state.connection).toBe("ready"));
    await waitFor(() => expect(result.current.provider.modelCatalog?.loading).toBe(false));
    await act(async () => {
      await result.current.actions.onReasoningEffortChange!("high");
    });
    expect(setModel.mock.calls[0]![0].modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    await act(async () => {
      await result.current.actions.onIntelligenceSelectionChange!({
        kind: "codex",
        model: "gpt-mini",
        reasoningEffort: "low",
        serviceTier: "fast",
      });
    });
    expect(setModel).toHaveBeenCalledTimes(2);
    expect(setModel.mock.calls[1]![0].modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-mini",
      options: [
        { id: "reasoningEffort", value: "low" },
        { id: "serviceTier", value: "fast" },
      ],
    });
    expect(result.current.provider.controls?.goals).toBe(false);
    await act(async () => unmount());
  });
});

describe("Agent Runtime background status", () => {
  it("explains a root waiting on subagents and stops them all from the composer", async () => {
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([provider]);
    vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
      sessionId: "background-session",
      projectId: "project",
      threadId: "engine-thread",
      snapshot,
    });
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
    const overview = vi.spyOn(agentRuntimeRuntime, "overview").mockResolvedValue({
      active: {
        items: [
          {
            id: "native-task",
            threadId: "engine-thread",
            runId: "parent-run",
            parentNodeId: "node",
            origin: "provider_native",
            driver: "claudeAgent",
            providerInstanceId: "codex",
            providerThreadId: null,
            childThreadId: null,
            childRunId: null,
            title: "Audit",
            model: "model",
            status: "running",
            startedAt: null,
            completedAt: null,
            updatedAt: "2026-10-15T00:00:00Z",
            resultAvailable: false,
          },
        ],
        nextCursor: null,
        hasMore: false,
        totalCount: 1,
      },
      terminal: { items: [], nextCursor: null, hasMore: false, totalCount: 0 },
    });
    const stopTask = vi.spyOn(agentRuntimeRuntime, "stopTask").mockResolvedValue({ sequence: 3 });
    const { result, unmount } = renderHook(
      () =>
        useAgentRuntimeConversationAdapter({
          sessionId: "background-session",
          executionRef: { runtimeId: "engine", threadId: "engine-thread" },
          projectId: "project",
          modelProjectId: "project",
          instances,
          onRefresh: async () => {},
          onOpenThread: () => {},
          ensureDraft: async () => ({ id: "background-session" }),
        }),
      { wrapper: RuntimeWorkbench },
    );
    await waitFor(() =>
      expect(result.current.provider.status?.message).toBe(
        "Waiting for 1 background task · resumes automatically",
      ),
    );
    await act(async () => {
      await result.current.provider.status!.actions![0]!.run();
    });
    expect(overview).toHaveBeenCalledWith({
      sessionId: "background-session",
      threadId: "engine-thread",
    });
    expect(stopTask).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "parent-run", taskId: "native-task" }),
    );
    await act(async () => unmount());
  });
});

describe("Agent Runtime conversation adapter", () => {
  it("shares Claude draft intent across presentations and restores unsupported preferences on switching back", async () => {
    const binding = { kind: "claude" as const, instanceConfigId: "intent-claude" };
    const configured = [{ binding, enabled: true, label: "Claude" }];
    const claude = {
      ...provider,
      instanceId: agentRuntimeProviderId(binding)!,
      driver: "claude",
      displayName: "Claude",
      models: [
        {
          slug: "full",
          name: "Full",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select",
                options: ["low", "high", "max"].map((id) => ({ id, label: id })),
              },
              { id: "fastMode", label: "Speed", type: "boolean" },
              { id: "thinking", label: "Thinking", type: "boolean" },
              {
                id: "contextWindow",
                label: "Context",
                type: "select",
                options: [{ id: "1m", label: "1M" }],
              },
            ],
          },
        },
        {
          slug: "small",
          name: "Small",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select",
                options: [{ id: "low", label: "Low" }],
              },
            ],
          },
        },
      ],
    } as AgentRuntimeProvider;
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([claude]);
    const useDraft = () =>
      useAgentRuntimeConversationAdapter({
        sessionId: "shared-claude-intent-draft",
        projectId: "project",
        modelProjectId: "project",
        instances: configured,
        onRefresh: async () => {},
        onOpenThread: () => {},
        ensureDraft: async () => ({ id: "shared-claude-intent-draft" }),
      });
    const main = renderHook(useDraft, { wrapper: RuntimeWorkbench });
    const dock = renderHook(useDraft, { wrapper: RuntimeWorkbench });
    await waitFor(() => expect(main.result.current.selectedModel).toBe("full"));
    await act(async () => {
      await main.result.current.provider.nativeIntelligence!.change({
        effort: "max",
        fast: true,
        thinking: false,
        context: "1m",
      });
    });
    await waitFor(() => expect(dock.result.current.selectedEffort).toBe("max"));
    await waitFor(() =>
      expect(dock.result.current.provider.nativeIntelligence!.selected).toMatchObject({
        fast: true,
        thinking: false,
        context: "1m",
      }),
    );
    await act(async () => {
      await main.result.current.provider.modelCatalog!.choose({ binding, model: "small" });
    });
    expect(dock.result.current.selectedEffort).toBe("low");
    expect(dock.result.current.provider.nativeIntelligence!.selected).toMatchObject({
      fast: false,
      thinking: undefined,
      context: undefined,
    });
    await act(async () => {
      await dock.result.current.provider.modelCatalog!.choose({ binding, model: "full" });
    });
    expect(main.result.current.selectedEffort).toBe("max");
    expect(main.result.current.provider.nativeIntelligence!.selected).toMatchObject({
      fast: true,
      thinking: false,
      context: "1m",
    });
    await act(async () => {
      main.unmount();
      dock.unmount();
    });
    const reopened = renderHook(useDraft, { wrapper: RuntimeWorkbench });
    await waitFor(() => expect(reopened.result.current.selectedModel).toBe("full"));
    expect(reopened.result.current.selectedEffort).toBe("max");
    expect(reopened.result.current.provider.nativeIntelligence!.selected).toMatchObject({
      fast: true,
      thinking: false,
      context: "1m",
    });
    await act(async () => reopened.unmount());
  });
  it("publishes a child's keyed transcript after StrictMode releases and reuses its render lease", async () => {
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([provider]);
    const answer: AgentTurnItem = {
      id: "strict-child-answer",
      threadId: "strict-child-thread",
      runId: "strict-child-run",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: "2026-10-14T00:00:00Z",
      completedAt: "2026-10-14T00:00:00Z",
      updatedAt: "2026-10-14T00:00:00Z",
      type: "assistant_message",
      messageId: "strict-answer",
      text: "The child completed its review.\n\n[Other](thread://other)",
      streaming: false,
    };
    const child = {
      sessionId: "strict-root-session",
      projectId: "project",
      threadId: "strict-child-thread",
      snapshot: {
        ...snapshot,
        projection: {
          ...snapshot.projection,
          thread: { ...snapshot.projection.thread, id: "strict-child-thread" },
          visibleTurnItems: [
            {
              position: 0,
              visibility: "local" as const,
              sourceThreadId: answer.threadId,
              sourceItemId: answer.id,
              item: answer,
            },
          ],
        },
      },
    };
    vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue(child);
    const read = vi.spyOn(agentRuntimeRuntime, "read").mockResolvedValue(child);
    const observers = new Set<() => void>();
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockImplementation(async () => {
      const release = () => observers.delete(release);
      observers.add(release);
      return release;
    });
    const onOpenThread = vi.fn();
    const wrapper = ({ children }: PropsWithChildren) => (
      <StrictMode>
        <RuntimeWorkbench>{children}</RuntimeWorkbench>
      </StrictMode>
    );
    const { result, unmount } = renderHook(
      () => {
        const adapter = useAgentRuntimeConversationAdapter({
          sessionId: child.sessionId,
          executionRef: { runtimeId: "engine", threadId: "root-thread" },
          threadId: child.threadId,
          projectId: "project",
          modelProjectId: "project",
          instances,
          onRefresh: async () => {},
          onOpenThread,
          ensureDraft: async () => {
            throw new Error("A child uses its root Session");
          },
        });
        const transcript = adapter.runtime.transcriptReadOwner!(child.threadId);
        useEffect(() => transcript?.subscribeStructure(() => {}), [transcript]);
        return { adapter, transcript };
      },
      { wrapper },
    );
    await waitFor(() => {
      expect(result.current.adapter.state.connection).toBe("ready");
      expect(result.current.transcript?.readStructure()).not.toBeNull();
      expect(
        result.current.transcript?.readItem(
          JSON.stringify(["agent-run", answer.threadId, answer.runId]),
          answer.id,
        ),
      ).toMatchObject({ type: "agentMessage", text: answer.text });
    });
    const source = result.current.adapter.runtime.contentSource!(child.threadId);
    expect(source?.isCurrent()).toBe(true);
    // The real Runtime reader supplies the new token presenter without any native registry context.
    const markdown = render(
      <RuntimeWorkbench>
        <TestQueryProvider>
          <NodexTooltipProvider>
            <ConversationRuntimeContext value={result.current.adapter.runtime}>
              <CodexTranscriptReadOwnerContext value={result.current.transcript}>
                <ConversationMarkdownSourceProvider
                  projectId="project"
                  hostId="local"
                  threadId={child.threadId}
                  cwd="/workspace"
                  workspaceRoot="/workspace"
                  onOpenThread={result.current.adapter.actions.onOpenThread}
                >
                  <MarkdownCore
                    dialect="conversation"
                    content={answer.text}
                    nativeSource={{
                      kind: "item",
                      entityKey: JSON.stringify(["agent-run", answer.threadId, answer.runId]),
                      itemId: answer.id,
                    }}
                  />
                </ConversationMarkdownSourceProvider>
              </CodexTranscriptReadOwnerContext>
            </ConversationRuntimeContext>
          </NodexTooltipProvider>
        </TestQueryProvider>
      </RuntimeWorkbench>,
    );
    const link = await markdown.findByRole("button", { name: "Other" });
    await act(async () => {
      fireEvent.click(link);
      await Promise.resolve();
    });
    expect(onOpenThread).toHaveBeenCalledWith(
      "other",
      expect.objectContaining({ runtimeSessionId: child.sessionId, hostId: "local" }),
    );
    await act(async () => {
      markdown.unmount();
      await Promise.resolve();
    });
    expect(result.current.adapter.runtime.attachment(child.threadId)).toEqual({
      status: "attached",
    });
    expect(read).toHaveBeenCalledExactlyOnceWith({
      sessionId: child.sessionId,
      threadId: child.threadId,
    });
    expect(observers.size).toBe(1);
    const concurrent = acquireAgentRuntimeConversationOwner({
      sessionId: child.sessionId,
      threadId: child.threadId,
    });
    expect(concurrent.owner.readOwner).toBe(result.current.transcript);
    let releaseConcurrent: () => void = () => {};
    await act(async () => {
      releaseConcurrent = concurrent.retain();
      await concurrent.owner.resume();
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(observers.size).toBe(1);
    await act(async () => {
      releaseConcurrent();
    });
    const transcript = result.current.transcript;
    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    expect(observers.size).toBe(0);
    expect(source?.isCurrent()).toBe(false);
    expect(transcript?.readStructure()).toBeNull();
    expect(
      transcript?.readItem(JSON.stringify(["agent-run", answer.threadId, answer.runId]), answer.id),
    ).toBeNull();
  });
  it("opens a child through its root Session and releases only the child's bounded owner", async () => {
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([provider]);
    const read = vi.spyOn(agentRuntimeRuntime, "read");
    const control = vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
      sessionId: "root-session",
      projectId: "project",
      threadId: "child-thread",
      snapshot: {
        ...snapshot,
        projection: {
          ...snapshot.projection,
          thread: { ...snapshot.projection.thread, id: "child-thread" },
        },
      },
    });
    const release = vi.fn();
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(release);
    const open = vi.fn();
    const { result, unmount } = renderHook(
      () =>
        useAgentRuntimeConversationAdapter({
          sessionId: "root-session",
          executionRef: { runtimeId: "engine", threadId: "root-thread" },
          threadId: "child-thread",
          projectId: "project",
          modelProjectId: "project",
          instances,
          onRefresh: async () => {},
          onOpenThread: open,
          ensureDraft: async () => {
            throw new Error("No child Session is created");
          },
        }),
      { wrapper: RuntimeWorkbench },
    );
    await waitFor(() => expect(result.current.state.connection).toBe("ready"));
    expect(read).not.toHaveBeenCalled();
    expect(control).toHaveBeenCalledExactlyOnceWith({
      sessionId: "root-session",
      threadId: "child-thread",
    });
    expect(result.current.runtime.read("root-thread")).toBeNull();
    await act(async () => {
      await result.current.actions.onOpenThread!("grandchild-thread", { hostId: "local" });
    });
    expect(open).toHaveBeenCalledWith("grandchild-thread", {
      hostId: "local",
      runtimeSessionId: "root-session",
    });
    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("promotes the existing Session without reading transcript bodies and releases its observer", async () => {
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([provider]);
    const launch = vi
      .spyOn(agentRuntimeRuntime, "launch")
      .mockResolvedValue({ sessionId: "draft", projectId: "project", threadId: "engine-thread" });
    const read = vi.spyOn(agentRuntimeRuntime, "read");
    const control = vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
      sessionId: "draft",
      projectId: "project",
      threadId: "engine-thread",
      snapshot,
    });
    const release = vi.fn();
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(release);
    const open = vi.fn();
    const refresh = vi.fn(async () => {});
    const { result, unmount } = renderHook(
      () =>
        useAgentRuntimeConversationAdapter({
          sessionId: "draft",
          projectId: "project",
          modelProjectId: "project",
          instances,
          onRefresh: refresh,
          onOpenThread: open,
          ensureDraft: async () => ({ id: "replacement" }),
        }),
      { wrapper: RuntimeWorkbench },
    );
    await waitFor(() => expect(result.current.selectedModel).toBe("model"));
    await act(async () => {
      await result.current.actions.onStartThreadForSession!({
        projectId: "project",
        sessionId: "draft",
        prompt: "Build it",
      });
    });
    await waitFor(() => expect(result.current.state.connection).toBe("ready"));
    expect(launch.mock.calls[0]![0]).toMatchObject({
      sessionId: "draft",
      projectId: "project",
      message: { text: "Build it" },
    });
    expect(open).toHaveBeenCalledWith("engine-thread", { runtimeSessionId: "draft" });
    expect(read).not.toHaveBeenCalled();
    expect(control).toHaveBeenCalledTimes(1);
    expect(result.current.runtime.read("engine-thread")?.threadId).toBe("engine-thread");
    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("Host OpenCode setup", () => {
  it("reloads the catalog once OpenCode is ready without replacing the chosen model", async () => {
    const binding = { kind: "opencode", instanceConfigId: "opencode-default" } as const;
    const missingOpenCode = {
      ...provider,
      instanceId: agentRuntimeProviderId(binding),
      driver: "opencode",
      displayName: "OpenCode",
      installed: false,
      status: "error",
      models: [],
    } as unknown as AgentRuntimeProvider;
    const readyOpenCode = {
      ...missingOpenCode,
      installed: true,
      status: "ready",
      models: [
        { slug: "opencode/glm-free", name: "GLM Free", isCustom: false, capabilities: null },
      ],
    } as unknown as AgentRuntimeProvider;
    const catalog = vi
      .spyOn(agentRuntimeRuntime, "catalog")
      .mockResolvedValue([codexProvider, missingOpenCode]);
    const publishSetup = new Set<(state: OpenCodeSetupState) => void>();
    vi.spyOn(openCodeSetupRuntime, "read").mockResolvedValue(setupState(1));
    vi.spyOn(openCodeSetupRuntime, "subscribe").mockImplementation((listener) => {
      publishSetup.add(listener);
      return () => {
        publishSetup.delete(listener);
      };
    });
    const configured = [
      { binding, label: "OpenCode", enabled: true, usesHostExecutable: true },
    ] as const;
    const { result, unmount } = renderHook(
      () =>
        useAgentRuntimeConversationAdapter({
          sessionId: "opencode-setup-draft",
          projectId: "project",
          modelProjectId: "project",
          instances: configured,
          onRefresh: async () => {},
          onOpenThread: () => {},
          ensureDraft: async () => ({ id: "opencode-setup-draft" }),
        }),
      { wrapper: SavedSettingsWorkbench },
    );
    await waitFor(() => expect(result.current.provider.modelCatalog?.setup?.hint).toBe("Install"));
    await act(async () => {
      await result.current.provider.modelCatalog!.choose({
        binding: { kind: "codex" },
        model: "gpt-mini",
      });
    });
    expect(result.current.selectedModel).toBe("gpt-mini");

    catalog.mockResolvedValue([codexProvider, readyOpenCode]);
    await act(async () => {
      for (const publish of publishSetup)
        publish(
          setupState(2, {
            executable: readyExecutable(),
            installation: { phase: "succeeded", log: { lines: [], progress: 1 } },
          }),
        );
    });
    await waitFor(() =>
      expect(
        result.current.provider.modelCatalog?.entries.map((entry) => entry.model.id),
      ).toContain("opencode/glm-free"),
    );
    expect(catalog).toHaveBeenLastCalledWith({ refresh: true });
    expect(result.current.provider.modelCatalog?.setup).toBeNull();
    expect(result.current.selectedModel).toBe("gpt-mini");
    await act(async () => unmount());
  });
});
