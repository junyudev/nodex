import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, useState, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  AgentHistoryPage,
  AgentSnapshot,
  AgentTurnItem,
} from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeSessionEvent } from "../../../shared/agent-runtime-api";
import { agentRuntimeRuntime } from "../../lib/agent-runtime-runtime";
import {
  createAgentRuntimeConversationRuntime,
  useAgentRuntimeConversationAdapter,
  type AgentRuntimeProvider,
} from "./agent-runtime-conversation-adapter";
import { sessionFirstSubmissionOwner } from "../conversation-launch/session-first-submission-owner";
import {
  acquireAgentRuntimeConversationOwner,
  AgentRuntimeConversationOwner,
} from "./agent-runtime-conversation-owner";
import { MaitaiProvider, createMaitaiStore } from "../../lib/maitai";
import { clearPersistedAtomStoreForTests } from "../../lib/persisted-atom-store";
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
import { supportsConversationProviderControl } from "./conversation-provider-controls";
import { AgentSettingsNavigationProvider } from "../../lib/agent-settings-navigation";
import { renderWithMaitai } from "../../test/thread-maitai";
import { LocalConversationTestQueryProvider } from "./view/local-conversation-test-query.test-fixtures";
import { LocalConversationTurnEntry } from "./view/local-conversation-turn-entry";
import { selectNormalizedConversationTurnEntries } from "./normalized-transcript-selectors";
import {
  isCodexRealtimeTimelineEntry,
  projectNormalizedTimelineEntries,
} from "./projection/normalized-timeline-entries";

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
    providerThreads: [],
    providerSessions: [],
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
  vi.spyOn(agentRuntimeRuntime, "readRunMessage").mockResolvedValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  sessionFirstSubmissionOwner.dispose();
  clearPersistedAtomStoreForTests();
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

describe("Agent Runtime failed-provider settings", () => {
  it.each(["configured", "missing-configuration", "codex", "no-window-navigation"] as const)(
    "keeps the failed Agent's settings authority with %s",
    async (scenario) => {
      const binding = { kind: "claude" as const, instanceConfigId: "failed-settings" };
      const instanceId = agentRuntimeProviderId(binding)!;
      const modelSelection = {
        instanceId: scenario === "codex" ? "codex" : instanceId,
        model: "model",
      };
      const failedSnapshot = {
        ...snapshot,
        projection: {
          ...snapshot.projection,
          thread: {
            ...snapshot.projection.thread,
            modelSelection,
            activeProviderThreadId: "provider-thread",
          },
          runs: [{ id: "failed-run", ordinal: 1, status: "failed", modelSelection }],
          providerThreads: [
            {
              id: "provider-thread",
              appThreadId: "engine-thread",
              providerInstanceId: modelSelection.instanceId,
              providerSessionId: null,
              nativeThreadRef: { driver: "claude", nativeId: "native", strength: "strong" },
            },
          ],
        },
      } as unknown as AgentSnapshot;
      const sessionId = `failed-settings-${scenario}`;
      const configuredInstances =
        scenario === "missing-configuration" ? [] : [{ binding, label: "Claude", enabled: true }];
      const conversation = {
        sessionId,
        projectId: "project",
        threadId: "engine-thread",
        snapshot: failedSnapshot,
      };
      vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([
        provider,
        { ...provider, instanceId, driver: "claude", displayName: "Claude" },
      ]);
      vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue(conversation);
      vi.spyOn(agentRuntimeRuntime, "read").mockResolvedValue(conversation);
      vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
      const openAgentSettings = vi.fn();
      const wrapper = ({ children }: PropsWithChildren) => (
        <RuntimeWorkbench>
          {scenario === "no-window-navigation" ? (
            children
          ) : (
            <AgentSettingsNavigationProvider openAgentSettings={openAgentSettings}>
              {children}
            </AgentSettingsNavigationProvider>
          )}
        </RuntimeWorkbench>
      );
      const { result, unmount } = renderHook(
        () => {
          const adapter = useAgentRuntimeConversationAdapter({
            sessionId,
            executionRef: { runtimeId: "engine", threadId: "engine-thread" },
            projectId: "project",
            modelProjectId: "project",
            instances: configuredInstances,
            onRefresh: async () => {},
            onOpenThread: () => {},
            ensureDraft: async () => ({ id: sessionId }),
          });
          const transcript = adapter.runtime.transcriptReadOwner?.("engine-thread");
          useEffect(() => transcript?.subscribeStructure(() => {}), [transcript]);
          return adapter;
        },
        { wrapper },
      );
      await waitFor(() => expect(result.current.state.connection).toBe("ready"));
      await waitFor(() => expect(result.current.provider.modelCatalog?.loading).toBe(false));
      if (scenario === "configured") {
        await act(async () => {
          await result.current.provider.modelCatalog!.choose({
            binding: { kind: "codex" },
            model: "model",
          });
        });
        expect(result.current.runtime.kind).toBe("codex");
        await act(async () => {
          result.current.actions.onManageFailedProvider!("failed-run");
        });
        expect(openAgentSettings).toHaveBeenCalledExactlyOnceWith("claude");
      } else {
        expect(result.current.actions.onManageFailedProvider).toBeUndefined();
        expect(openAgentSettings).not.toHaveBeenCalled();
      }
      await act(async () => unmount());
    },
  );
});

describe("Agent Runtime response fork entrypoint", () => {
  it.each(["claude", "opencode"] as const)(
    "forks a completed %s response from its exact Run and opens the accepted Session",
    async (kind) => {
      const binding = { kind, instanceConfigId: "fork-test" };
      const instanceId = agentRuntimeProviderId(binding);
      if (!instanceId) throw new Error("Expected the configured Agent Instance");
      const configured = [{ binding, label: kind, enabled: true }];
      const sessionId = `${kind}-response-fork`;
      const answer: AgentTurnItem = {
        id: `${kind}-answer`,
        threadId: "engine-thread",
        runId: `${kind}-completed-run`,
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
        messageId: `${kind}-message`,
        text: "The review is complete.",
        streaming: false,
      };
      const conversation = {
        sessionId,
        projectId: "project",
        threadId: "engine-thread",
        snapshot: {
          ...snapshot,
          projection: {
            ...snapshot.projection,
            thread: {
              ...snapshot.projection.thread,
              modelSelection: { instanceId, model: "model" },
            },
            runs: [
              {
                id: answer.runId!,
                threadId: answer.threadId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection: { instanceId, model: "model" },
                providerThreadId: null,
                userMessageId: `${kind}-user-message`,
                rootNodeId: null,
                activeAttemptId: null,
                status: "completed" as const,
                requestedAt: "2026-10-14T00:00:00Z",
                startedAt: "2026-10-14T00:00:00Z",
                completedAt: "2026-10-14T00:00:00Z",
                checkpointId: null,
                contextHandoffId: null,
              },
            ],
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
      vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([
        { ...provider, instanceId, driver: kind, displayName: kind },
      ]);
      vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue(conversation);
      vi.spyOn(agentRuntimeRuntime, "read").mockResolvedValue(conversation);
      vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
      const accepted = {
        sourceSessionId: sessionId,
        sessionId: `${kind}-fork`,
        projectId: "project",
        threadId: "fork-thread",
      };
      const fork = vi.spyOn(agentRuntimeRuntime, "fork").mockResolvedValue(accepted);
      const onOpenThread = vi.fn();
      const { result, unmount } = renderHook(
        () => {
          const adapter = useAgentRuntimeConversationAdapter({
            sessionId,
            executionRef: { runtimeId: "engine", threadId: "engine-thread" },
            projectId: "project",
            modelProjectId: "project",
            instances: configured,
            onRefresh: async () => {},
            onOpenThread,
            ensureDraft: async () => ({ id: sessionId }),
          });
          const transcript = adapter.runtime.transcriptReadOwner!("engine-thread");
          useEffect(() => transcript?.subscribeStructure(() => {}), [transcript]);
          return { adapter, transcript };
        },
        { wrapper: RuntimeWorkbench },
      );
      await waitFor(() => {
        expect(result.current.adapter.state.connection).toBe("ready");
        expect(result.current.transcript?.readStructure()?.turns).toHaveLength(1);
        expect(
          result.current.transcript?.readItem(
            JSON.stringify(["agent-run", answer.threadId, answer.runId]),
            answer.id,
          ),
        ).toMatchObject({ type: "agentMessage", text: answer.text });
      });
      const { adapter, transcript } = result.current;
      if (!transcript) throw new Error("Expected Runtime transcript");
      const structure = transcript.readStructure()!;
      const { entries } = projectNormalizedTimelineEntries({
        owner: transcript,
        structure,
        entries: selectNormalizedConversationTurnEntries({
          owner: transcript,
          structure,
          conversation: adapter.state.view,
        }),
      });
      const entry = entries[0];
      if (!entry || isCodexRealtimeTimelineEntry(entry))
        throw new Error("Expected completed response entry");
      const view = renderWithMaitai(
        <NodexTooltipProvider>
          <ConversationRuntimeContext value={adapter.runtime}>
            <CodexTranscriptReadOwnerContext value={transcript}>
              <LocalConversationTurnEntry
                conversationId="engine-thread"
                entry={entry}
                cwd="/workspace"
                canEditTurnUserPrefix={false}
                canForkTurn={adapter.state.view!.capabilityFlags.canForkFromTurn}
                onForkTurnMessage={adapter.actions.onForkFromTurn}
              />
            </CodexTranscriptReadOwnerContext>
          </ConversationRuntimeContext>
        </NodexTooltipProvider>,
        { wrapper: LocalConversationTestQueryProvider },
      );
      try {
        const action = await view.findByRole("button", { name: "Fork chat from here" });
        expect(action.hasAttribute("disabled")).toBe(false);
        await act(async () => {
          fireEvent.click(action);
          await Promise.resolve();
        });
        await waitFor(() => expect(fork).toHaveBeenCalledOnce());
        expect(fork.mock.calls[0]![0]).toMatchObject({
          source: { sessionId, threadId: "engine-thread" },
          sourceRunId: answer.runId,
          environment: "same-directory",
        });
        expect(onOpenThread).toHaveBeenCalledWith(accepted.threadId, {
          runtimeSessionId: accepted.sessionId,
        });
      } finally {
        await act(async () => {
          view.unmount();
          unmount();
        });
      }
    },
  );
});

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

  it("keeps overlapping chat launches on their independently selected speed", async () => {
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([codexProvider]);
    let finishFirst!: () => void;
    const firstLaunch = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const launch = vi.spyOn(agentRuntimeRuntime, "launch").mockImplementation(async (request) => {
      if (request.sessionId === "fast-draft") await firstLaunch;
      return { sessionId: request.sessionId, projectId: "project", threadId: request.sessionId };
    });
    vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
      sessionId: "launched",
      projectId: "project",
      threadId: "engine-thread",
      snapshot,
    });
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
    const mount = (sessionId: string) =>
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
    const fast = mount("fast-draft");
    let pendingLaunch: Promise<void> | undefined;
    let standard: ReturnType<typeof mount> | undefined;
    try {
      await waitFor(() => expect(fast.result.current.selectedModel).toBe("gpt"));
      await act(async () => {
        await fast.result.current.actions.onIntelligenceSelectionChange!({
          kind: "codex",
          model: "gpt",
          reasoningEffort: "high",
          serviceTier: "fast",
        });
        pendingLaunch = fast.result.current.actions.onStartThreadForSession!({
          projectId: "project",
          sessionId: "fast-draft",
          prompt: "Fast task",
        });
      });
      await waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
      standard = mount("standard-draft");
      const current = standard;
      await waitFor(() => expect(current.result.current.selectedModel).toBe("gpt"));
      await act(async () => {
        await current.result.current.actions.onIntelligenceSelectionChange!({
          kind: "codex",
          model: "gpt",
          reasoningEffort: "high",
          serviceTier: null,
        });
      });
      expect(fast.result.current.provider.serviceTier).toBe("fast");
      expect(current.result.current.provider.serviceTier).toBeNull();
      await act(async () => {
        await current.result.current.actions.onStartThreadForSession!({
          projectId: "project",
          sessionId: "standard-draft",
          prompt: "Standard task",
        });
        finishFirst();
        await pendingLaunch;
      });
      expect(
        launch.mock.calls.map(([request]) => ({
          sessionId: request.sessionId,
          tier: request.modelSelection.options?.find((option) => option.id === "serviceTier")
            ?.value,
        })),
      ).toEqual([
        { sessionId: "fast-draft", tier: "fast" },
        { sessionId: "standard-draft", tier: "default" },
      ]);
    } finally {
      await act(async () => {
        finishFirst();
        await pendingLaunch;
        fast.unmount();
        standard?.unmount();
      });
    }
  });

  it("restores each chat's pending speed despite other chats and a Fast catalog default", async () => {
    const fastCatalog = {
      ...codexProvider,
      models: codexProvider.models.map((model) => ({
        ...model,
        capabilities: {
          ...model.capabilities,
          optionDescriptors: model.capabilities?.optionDescriptors?.map((option) =>
            option.id === "serviceTier" ? { ...option, currentValue: "fast" } : option,
          ),
        },
      })),
    } as AgentRuntimeProvider;
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([fastCatalog]);
    vi.spyOn(agentRuntimeRuntime, "control").mockImplementation(async (target) => ({
      ...target,
      projectId: "project",
      threadId: target.threadId!,
      snapshot: {
        ...snapshot,
        projection: {
          ...snapshot.projection,
          thread: {
            ...snapshot.projection.thread,
            id: target.threadId!,
            modelSelection: {
              instanceId: "codex",
              model: "gpt",
              options: [
                { id: "reasoningEffort", value: "high" },
                { id: "serviceTier", value: target.threadId === "speed-a" ? "fast" : "default" },
              ],
            },
          },
        },
      } as AgentSnapshot,
    }));
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
    const message = vi.spyOn(agentRuntimeRuntime, "message").mockResolvedValue({ sequence: 1 });
    const mount = (threadId: string) =>
      renderHook(
        () =>
          useAgentRuntimeConversationAdapter({
            sessionId: `session-${threadId}`,
            executionRef: { runtimeId: "engine", threadId },
            projectId: "project",
            modelProjectId: "project",
            instances,
            onRefresh: async () => {},
            onOpenThread: () => {},
            ensureDraft: async () => ({ id: `session-${threadId}` }),
          }),
        { wrapper: SavedSettingsWorkbench },
      );
    for (const [threadId, tier] of [
      ["speed-a", null],
      ["speed-b", "fast"],
    ] as const) {
      const chat = mount(threadId);
      try {
        await waitFor(() => expect(chat.result.current.state.connection).toBe("ready"));
        await waitFor(() => expect(chat.result.current.provider.modelCatalog?.loading).toBe(false));
        expect(chat.result.current.provider.serviceTier).toBe(
          threadId === "speed-a" ? "fast" : null,
        );
        await act(async () => {
          await chat.result.current.actions.onIntelligenceSelectionChange!({
            kind: "codex",
            model: "gpt",
            reasoningEffort: "high",
            serviceTier: tier,
          });
        });
        expect(chat.result.current.provider.serviceTier).toBe(tier);
      } finally {
        await act(async () => chat.unmount());
      }
    }
    for (const [threadId, tier] of [
      ["speed-a", null],
      ["speed-b", "fast"],
    ] as const) {
      const chat = mount(threadId);
      try {
        await waitFor(() => expect(chat.result.current.state.connection).toBe("ready"));
        await waitFor(() => expect(chat.result.current.provider.modelCatalog?.loading).toBe(false));
        expect(chat.result.current.provider.serviceTier).toBe(tier);
        await act(async () => {
          await chat.result.current.actions.onSendPrompt!("Continue");
        });
        expect(message.mock.lastCall?.[0]).toMatchObject({
          sessionId: `session-${threadId}`,
          threadId,
          message: {
            modelSelection: {
              instanceId: "codex",
              model: "gpt",
              options: [
                { id: "reasoningEffort", value: "high" },
                { id: "serviceTier", value: tier ?? "default" },
              ],
            },
          },
        });
      } finally {
        await act(async () => chat.unmount());
      }
    }
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

  it("carries model, effort and speed to the next message as one choice under Codex's own option ids", async () => {
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
    const message = vi.spyOn(agentRuntimeRuntime, "message").mockResolvedValue({ sequence: 1 });
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
    expect(result.current.selectedEffort).toBe("high");
    await act(async () => {
      await result.current.actions.onIntelligenceSelectionChange!({
        kind: "codex",
        model: "gpt-mini",
        reasoningEffort: "low",
        serviceTier: "fast",
      });
    });
    // Choosing changes nothing in the chat until a message uses the choice.
    expect(message).not.toHaveBeenCalled();
    expect(result.current.selectedModel).toBe("gpt-mini");
    await act(async () => {
      await result.current.actions.onSendPrompt!("Continue");
    });
    expect(message.mock.calls[0]![0].message.modelSelection).toEqual({
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

describe("Agent Runtime Agent switching", () => {
  const claudeBinding = { kind: "claude" as const, instanceConfigId: "switch-claude" };
  const claudeId = agentRuntimeProviderId(claudeBinding)!;
  const configured = [{ binding: claudeBinding, enabled: true, label: "Claude" }];
  const claudeProvider = {
    ...provider,
    instanceId: claudeId,
    driver: "claude",
    displayName: "Claude",
    models: [{ slug: "sonnet", name: "Sonnet", isCustom: false, capabilities: null }],
  } as unknown as AgentRuntimeProvider;
  const finishedCodex = (runStatus: string) =>
    ({
      ...snapshot,
      projection: {
        ...snapshot.projection,
        thread: {
          ...snapshot.projection.thread,
          activeProviderThreadId: "provider-thread",
          modelSelection: { instanceId: "codex", model: "model" },
        },
        runs: [
          {
            id: "run",
            ordinal: 1,
            status: runStatus,
            providerThreadId: "provider-thread",
            modelSelection: { instanceId: "codex", model: "model" },
          },
        ],
        providerSessions: [],
        providerThreads: [
          {
            id: "provider-thread",
            appThreadId: "engine-thread",
            providerInstanceId: "codex",
            providerSessionId: null,
            nativeThreadRef: { driver: "codex", nativeId: "native", strength: "strong" },
          },
        ],
      },
    }) as unknown as AgentSnapshot;
  const mount = (initial: AgentSnapshot) => {
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([provider, claudeProvider]);
    vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
      sessionId: "switch-session",
      projectId: "project",
      threadId: "engine-thread",
      snapshot: initial,
    });
    const listeners: Array<(event: AgentRuntimeSessionEvent) => void> = [];
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockImplementation(async (_input, listener) => {
      listeners.push(listener);
      return () => {};
    });
    const hook = renderHook(
      () =>
        useAgentRuntimeConversationAdapter({
          sessionId: "switch-session",
          executionRef: { runtimeId: "engine", threadId: "engine-thread" },
          projectId: "project",
          modelProjectId: "project",
          instances: configured,
          onRefresh: async () => {},
          onOpenThread: () => {},
          ensureDraft: async () => ({ id: "switch-session" }),
        }),
      { wrapper: RuntimeWorkbench },
    );
    let sequence = initial.snapshotSequence;
    const switchThread = async (modelSelection: { instanceId: string; model: string }) => {
      sequence += 1;
      await act(async () => {
        for (const listener of listeners)
          listener({
            type: "event",
            subscriptionId: "subscription",
            sessionId: "switch-session",
            threadId: "engine-thread",
            event: {
              sequence,
              event: {
                type: "thread.provider-switched",
                threadId: "engine-thread",
                providerInstanceId: modelSelection.instanceId,
                occurredAt: "2026-10-20T00:00:00Z",
                payload: { ...initial.projection.thread, modelSelection },
              },
            },
          } as unknown as AgentRuntimeSessionEvent);
        await Promise.resolve();
      });
    };
    return { ...hook, switchThread };
  };
  const claudeEntry = (result: {
    current: ReturnType<typeof useAgentRuntimeConversationAdapter>;
  }) =>
    result.current.provider.modelCatalog!.entries.find((entry) => entry.binding.kind === "claude")!;

  it("continues a finished Codex chat on Claude from the next message, then follows the chat", async () => {
    const message = vi.spyOn(agentRuntimeRuntime, "message").mockResolvedValue({ sequence: 1 });
    const { result, unmount, switchThread } = mount(finishedCodex("completed"));
    await waitFor(() => expect(result.current.state.connection).toBe("ready"));
    await waitFor(() => expect(result.current.provider.modelCatalog?.loading).toBe(false));
    expect(claudeEntry(result).unavailableReason).toBeUndefined();
    await act(async () => {
      await result.current.provider.modelCatalog!.choose(claudeEntry(result).selection);
    });
    // The Composer now speaks for Claude; the chat itself is unchanged until a message uses it.
    expect(result.current.provider.kind).toBe("claude");
    expect(result.current.selectedModel).toBe("sonnet");
    expect(message).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.actions.onSendPrompt!("Continue with Claude");
    });
    expect(message.mock.calls[0]![0].message).toMatchObject({
      text: "Continue with Claude",
      modelSelection: { instanceId: claudeId, model: "sonnet" },
    });
    await switchThread({ instanceId: claudeId, model: "sonnet" });
    await act(async () => {
      await result.current.actions.onSendPrompt!("Keep going");
    });
    // The applied choice is spent: later messages carry nothing and the chat's own Agent applies.
    expect(message.mock.calls[1]![0].message.modelSelection).toBeUndefined();
    await switchThread({ instanceId: "codex", model: "model" });
    expect(result.current.provider.kind).toBe("codex");
    await act(async () => unmount());
  });

  it("restores a model's own options after a round trip and keeps the chat's choice across restart", async () => {
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([codexProvider, claudeProvider]);
    vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
      sessionId: "switch-session",
      projectId: "project",
      threadId: "engine-thread",
      snapshot: {
        ...finishedCodex("completed"),
        projection: {
          ...finishedCodex("completed").projection,
          thread: {
            ...finishedCodex("completed").projection.thread,
            modelSelection: { instanceId: "codex", model: "gpt" },
          },
        },
      } as AgentSnapshot,
    });
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
    const useChat = () =>
      useAgentRuntimeConversationAdapter({
        sessionId: "switch-session",
        executionRef: { runtimeId: "engine", threadId: "engine-thread" },
        projectId: "project",
        modelProjectId: "project",
        instances: configured,
        onRefresh: async () => {},
        onOpenThread: () => {},
        ensureDraft: async () => ({ id: "switch-session" }),
      });
    const first = renderHook(useChat, { wrapper: SavedSettingsWorkbench });
    const { result } = first;
    await waitFor(() => expect(result.current.state.connection).toBe("ready"));
    await waitFor(() => expect(result.current.provider.modelCatalog?.loading).toBe(false));
    await act(async () => {
      await result.current.actions.onReasoningEffortChange!("high");
    });
    await act(async () => {
      await result.current.provider.modelCatalog!.choose(claudeEntry(result).selection);
    });
    expect(result.current.provider.kind).toBe("claude");
    const gptEntry = result.current.provider.modelCatalog!.entries.find(
      (entry) => entry.binding.kind === "codex" && entry.model.id === "gpt",
    )!;
    await act(async () => {
      await result.current.provider.modelCatalog!.choose(gptEntry.selection);
    });
    // Coming back to Codex starts from the effort last chosen for that model.
    expect(result.current.selectedEffort).toBe("high");
    await act(async () => {
      await result.current.provider.modelCatalog!.choose(claudeEntry(result).selection);
    });
    await act(async () => first.unmount());
    // A new window store reads the same persisted choice, as after a restart.
    const reopened = renderHook(useChat, { wrapper: SavedSettingsWorkbench });
    await waitFor(() => expect(reopened.result.current.state.connection).toBe("ready"));
    await waitFor(() => expect(reopened.result.current.provider.kind).toBe("claude"));
    await act(async () => reopened.unmount());
  });

  it("keeps other Agents listed but unavailable while a reply starts without its session", async () => {
    const { result, unmount } = mount(finishedCodex("starting"));
    await waitFor(() => expect(result.current.state.connection).toBe("ready"));
    await waitFor(() => expect(result.current.provider.modelCatalog?.loading).toBe(false));
    const entry = claudeEntry(result);
    expect(entry.unavailableReason).toBe(
      "Wait for the current reply to start, then choose another Agent.",
    );
    await expect(result.current.provider.modelCatalog!.choose(entry.selection)).rejects.toThrow(
      entry.unavailableReason,
    );
    expect(result.current.provider.kind).toBe("codex");
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
  it("routes history to its bound Thread and keeps page failures out of attachment state", async () => {
    const target = { sessionId: "history-session", threadId: "engine-thread" };
    const read = vi.spyOn(agentRuntimeRuntime, "read").mockResolvedValue({
      ...target,
      projectId: "project",
      snapshot: { ...snapshot, historyCursor: "older", hasMoreHistory: true },
    });
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
    const failure = new Error("Page unavailable");
    const history = vi
      .spyOn(agentRuntimeRuntime, "history")
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        snapshotSequence: 1,
        items: [],
        nextCursor: null,
        hasMoreHistory: false,
      });
    const owner = new AgentRuntimeConversationOwner(target);
    const release = owner.readOwner.subscribeStructure(() => {});
    try {
      await owner.resume();
      const runtime = createAgentRuntimeConversationRuntime("codex", target, owner);
      const gap = owner.readOwner.readStructure()?.timeline?.find((entry) => entry.kind === "gap");
      if (gap?.kind !== "gap" || !gap.newerBoundary) throw new Error("Expected older history");
      const boundary = gap.newerBoundary;
      expect(runtime.history!("foreign-thread")).toBeNull();
      expect(history).not.toHaveBeenCalled();
      const historyPort = runtime.history!(target.threadId)!;
      await expect(historyPort.loadBoundary(boundary)).rejects.toBe(failure);
      expect(runtime.attachment(target.threadId)).toEqual({ status: "attached" });
      expect(owner.getSnapshot().error).toBeNull();
      await expect(historyPort.loadBoundary(boundary)).resolves.toBe("applied");
      expect(history).toHaveBeenLastCalledWith({ ...target, cursor: "older" });
      expect(history).toHaveBeenCalledTimes(2);
      expect(read).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  });

  it("retires the bound history port when its reader reconnects even while an old page is pending", async () => {
    const target = { sessionId: "history-session", threadId: "engine-thread" };
    vi.spyOn(agentRuntimeRuntime, "read").mockResolvedValue({
      ...target,
      projectId: "project",
      snapshot: { ...snapshot, historyCursor: "older", hasMoreHistory: true },
    });
    let notify!: (event: AgentRuntimeSessionEvent) => void;
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockImplementation(async (_target, listener) => {
      notify = listener;
      return () => {};
    });
    let completeOld!: (page: AgentHistoryPage) => void;
    const oldPage = new Promise<AgentHistoryPage>((resolve) => {
      completeOld = resolve;
    });
    const complete: AgentHistoryPage = {
      snapshotSequence: 1,
      items: [],
      nextCursor: null,
      hasMoreHistory: false,
    };
    const history = vi
      .spyOn(agentRuntimeRuntime, "history")
      .mockReturnValueOnce(oldPage)
      .mockResolvedValueOnce(complete);
    const owner = new AgentRuntimeConversationOwner(target);
    const runtime = createAgentRuntimeConversationRuntime("codex", target, owner);
    expect(runtime.history!(target.threadId)).toBeNull();
    const release = owner.readOwner.subscribeStructure(() => {});
    try {
      await owner.resume();
      const oldPort = runtime.history!(target.threadId)!;
      const oldGap = owner.readOwner
        .readStructure()
        ?.timeline?.find((entry) => entry.kind === "gap");
      if (oldGap?.kind !== "gap" || !oldGap.newerBoundary)
        throw new Error("Expected older history");
      const pending = oldPort.loadBoundary(oldGap.newerBoundary);
      await waitFor(() => expect(history).toHaveBeenCalledOnce());
      notify({ type: "reset-required", ...target, reason: "delivery-gap" });
      expect(runtime.history!(target.threadId)).toBeNull();
      await owner.resume();
      const gap = owner.readOwner.readStructure()?.timeline?.find((entry) => entry.kind === "gap");
      if (gap?.kind !== "gap" || !gap.newerBoundary) throw new Error("Expected older history");
      const currentPort = runtime.history!(target.threadId)!;
      expect(currentPort).not.toBe(oldPort);
      await expect(oldPort.loadBoundary(gap.newerBoundary)).resolves.toBe("stale");
      expect(history).toHaveBeenCalledOnce();
      await expect(currentPort.loadBoundary(gap.newerBoundary)).resolves.toBe("applied");
      expect(history).toHaveBeenCalledTimes(2);
      completeOld(complete);
      await expect(pending).resolves.toBe("stale");
    } finally {
      completeOld(complete);
      release();
    }
  });

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
  it("retries a child read through its root Session and releases only the child's bounded owner", async () => {
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([provider]);
    const read = vi.spyOn(agentRuntimeRuntime, "read");
    const control = vi
      .spyOn(agentRuntimeRuntime, "control")
      .mockRejectedValueOnce(new Error("History unavailable"))
      .mockResolvedValue({
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
    await waitFor(() => expect(result.current.state.connection).toBe("failed"));
    await act(async () => {
      await result.current.runtime.loadHistory("root-thread");
    });
    expect(control).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.runtime.loadHistory("child-thread");
    });
    await waitFor(() => expect(result.current.state.connection).toBe("ready"));
    expect(read).not.toHaveBeenCalled();
    expect(control).toHaveBeenCalledTimes(2);
    expect(control).toHaveBeenLastCalledWith({
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

describe("Agent Runtime image capabilities", () => {
  const imageProvider = {
    ...provider,
    models: [
      {
        slug: "vision",
        name: "Vision",
        isCustom: false,
        isDefault: true,
        capabilities: { optionDescriptors: [], inputModalities: ["text", "image"] },
      },
      {
        slug: "text",
        name: "Text",
        isCustom: false,
        capabilities: { optionDescriptors: [], inputModalities: ["text"] },
      },
      { slug: "unknown", name: "Unknown", isCustom: true, capabilities: null },
    ],
  } as unknown as AgentRuntimeProvider;

  it("uses the next message's model for image controls and refuses images before sending", async () => {
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([imageProvider]);
    vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
      sessionId: "image-capability-session",
      projectId: "project",
      threadId: "engine-thread",
      snapshot: {
        ...snapshot,
        projection: {
          ...snapshot.projection,
          thread: {
            ...snapshot.projection.thread,
            modelSelection: { instanceId: "codex", model: "vision" },
          },
        },
      },
    });
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
    const send = vi.spyOn(agentRuntimeRuntime, "message").mockResolvedValue({ sequence: 1 });
    const { result, unmount } = renderHook(
      () =>
        useAgentRuntimeConversationAdapter({
          sessionId: "image-capability-session",
          executionRef: { runtimeId: "engine", threadId: "engine-thread" },
          projectId: "project",
          modelProjectId: "project",
          instances,
          onRefresh: async () => {},
          onOpenThread: () => {},
          ensureDraft: async () => ({ id: "image-capability-session" }),
        }),
      { wrapper: RuntimeWorkbench },
    );
    await waitFor(() => expect(result.current.state.connection).toBe("ready"));
    await waitFor(() => expect(result.current.provider.modelCatalog?.loading).toBe(false));
    expect(supportsConversationProviderControl(result.current.provider, "images")).toBe(true);
    const entries = result.current.provider.modelCatalog!.entries;
    expect(entries.find((entry) => entry.model.id === "text")?.model.inputModalities).toEqual([
      "text",
    ]);
    expect(
      entries.find((entry) => entry.model.id === "unknown")?.model.inputModalities,
    ).not.toContain("image");
    const images = [{ source: "data:image/png;base64,aGVsbG8=" }];
    for (const model of ["text", "unknown"]) {
      await act(async () => {
        await result.current.provider.modelCatalog!.choose({ binding: { kind: "codex" }, model });
      });
      expect(supportsConversationProviderControl(result.current.provider, "images")).toBe(false);
      await act(async () => {
        await expect(
          result.current.actions.onSendPrompt!("Inspect this", {
            promptInput: { text: "Inspect this", images },
          }),
        ).rejects.toThrow(model === "text" ? "does not support image" : "has not reported image");
      });
      expect(send).not.toHaveBeenCalled();
    }
    await act(async () => {
      await result.current.actions.onSendPrompt!("Text still works");
    });
    expect(send.mock.calls[0]![0].message.modelSelection).toMatchObject({
      instanceId: "codex",
      model: "unknown",
    });
    await act(async () => {
      await result.current.provider.modelCatalog!.choose({
        binding: { kind: "codex" },
        model: "vision",
      });
    });
    await act(async () => {
      await result.current.actions.onSendPrompt!("Inspect this", {
        promptInput: { text: "Inspect this", images },
      });
    });
    expect(send.mock.calls[1]![0].message.images).toEqual(images);
    await act(async () => unmount());
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

describe("Agent Runtime sent-message editing capabilities", () => {
  it.each([
    { driver: "opencode", supportsConversationRollback: true, editable: true },
    { driver: "acp", supportsConversationRollback: undefined, editable: false },
    { driver: "acp", supportsConversationRollback: false, editable: false },
  ])(
    "requires an explicit historical rewind capability: $driver/$supportsConversationRollback",
    async ({ driver, supportsConversationRollback, editable }) => {
      const binding =
        driver === "opencode"
          ? { kind: "opencode" as const, instanceConfigId: "edit-capability-agent" }
          : {
              kind: "acp" as const,
              agentDefinitionId: "reset-only",
              instanceConfigId: "edit-capability-agent",
            };
      const instanceId = agentRuntimeProviderId(binding)!;
      vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([
        {
          ...provider,
          instanceId,
          driver,
          supportsConversationRollback,
        } as AgentRuntimeProvider,
      ]);
      vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
        sessionId: "edit-capability-session",
        projectId: "project",
        threadId: "engine-thread",
        snapshot: {
          ...snapshot,
          projection: {
            ...snapshot.projection,
            thread: {
              ...snapshot.projection.thread,
              modelSelection: { instanceId, model: "model" },
            },
          },
        } as AgentSnapshot,
      });
      vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
      const { result, unmount } = renderHook(
        () =>
          useAgentRuntimeConversationAdapter({
            sessionId: "edit-capability-session",
            executionRef: { runtimeId: "engine", threadId: "engine-thread" },
            projectId: "project",
            modelProjectId: "project",
            instances: [{ binding, enabled: true, label: "Editing capability test" }],
            onRefresh: async () => {},
            onOpenThread: () => {},
            ensureDraft: async () => ({ id: "edit-capability-session" }),
          }),
        { wrapper: RuntimeWorkbench },
      );
      try {
        await waitFor(() => expect(result.current.state.connection).toBe("ready"));
        await waitFor(() => expect(result.current.provider.modelCatalog?.loading).toBe(false));
        await waitFor(() =>
          expect(result.current.state.view?.capabilityFlags.canEditUserTurns).toBe(editable),
        );
      } finally {
        await act(async () => unmount());
      }
    },
  );
});

describe("Agent Runtime effective image capability", () => {
  it("refreshes image support after a live ACP handshake without replacing the model's options", async () => {
    const binding = {
      kind: "acp" as const,
      agentDefinitionId: "image-negotiation",
      instanceConfigId: "live-image-negotiation",
    };
    const instanceId = agentRuntimeProviderId(binding)!;
    const sessionId = "live-image-negotiation-session";
    const options = [{ id: "effort", value: "high" }];
    const liveProvider = (inputModalities?: ("text" | "image")[]) =>
      ({
        ...provider,
        instanceId,
        driver: "acpRegistry",
        models: [
          {
            slug: "model",
            name: "Model",
            isCustom: false,
            capabilities: {
              ...(inputModalities ? { inputModalities } : {}),
              optionDescriptors: [
                {
                  id: "effort",
                  label: "Effort",
                  type: "select",
                  options: [{ id: "high", label: "High" }],
                },
              ],
            },
          },
        ],
      }) as AgentRuntimeProvider;
    let catalog = liveProvider();
    vi.spyOn(agentRuntimeRuntime, "catalog").mockImplementation(async () => [catalog]);
    vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
      sessionId,
      projectId: "project",
      threadId: "engine-thread",
      snapshot: {
        ...snapshot,
        projection: {
          ...snapshot.projection,
          thread: {
            ...snapshot.projection.thread,
            modelSelection: { instanceId, model: "model", options },
          },
        },
      },
    });
    const listeners = new Set<(event: AgentRuntimeSessionEvent) => void>();
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockImplementation(async (_input, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const send = vi.spyOn(agentRuntimeRuntime, "message").mockResolvedValue({ sequence: 1 });
    const configured = [{ binding, enabled: true, label: "ACP" }];
    const { result, unmount } = renderHook(
      () =>
        useAgentRuntimeConversationAdapter({
          sessionId,
          executionRef: { runtimeId: "engine", threadId: "engine-thread" },
          projectId: "project",
          modelProjectId: "project",
          instances: configured,
          onRefresh: async () => {},
          onOpenThread: () => {},
          ensureDraft: async () => ({ id: sessionId }),
        }),
      { wrapper: RuntimeWorkbench },
    );
    const handshake = async (sequence: number) => {
      await act(async () => {
        for (const listener of listeners)
          listener({
            type: "event",
            subscriptionId: "live-images",
            sessionId,
            threadId: "engine-thread",
            event: {
              sequence,
              commandId: null,
              event: {
                id: `handshake:${sequence}`,
                type: sequence === 2 ? "provider-session.attached" : "provider-session.updated",
                threadId: "engine-thread",
                occurredAt: "2026-10-22T00:00:00.000Z",
                payload: {
                  id: "live-acp-session",
                  providerInstanceId: instanceId,
                  driver: "acpRegistry",
                  status: "ready",
                  cwd: "/workspace",
                  model: "model",
                  capabilities: { sessions: { supportsProviderSwitchingViaHandoff: true } },
                  createdAt: "2026-10-22T00:00:00.000Z",
                  updatedAt: `2026-10-22T00:00:0${sequence}.000Z`,
                  lastError: null,
                },
              },
            },
          } as unknown as AgentRuntimeSessionEvent);
        await Promise.resolve();
      });
    };
    const promptInput = {
      text: "Inspect this",
      images: [{ source: "data:image/png;base64,aW1hZ2U=" }],
    };
    try {
      await waitFor(() => expect(result.current.state.connection).toBe("ready"));
      await waitFor(() => expect(result.current.provider.modelCatalog?.loading).toBe(false));
      expect(result.current.provider.controls?.images).toBe(false);
      expect(result.current.provider.imageInputUnavailableReason).toContain("has not reported");
      catalog = liveProvider(["text", "image"]);
      await handshake(2);
      await waitFor(() => expect(result.current.provider.controls?.images).toBe(true));
      expect(result.current.provider.modelCatalog?.selected.options).toEqual(options);
      await act(async () => {
        await result.current.actions.onSendPrompt!(promptInput.text, { promptInput });
      });
      expect(send).toHaveBeenCalledOnce();
      catalog = liveProvider(["text"]);
      await handshake(3);
      await waitFor(() => expect(result.current.provider.controls?.images).toBe(false));
      expect(result.current.provider.modelCatalog?.selected.options).toEqual(options);
      await act(async () => {
        await expect(
          result.current.actions.onSendPrompt!(promptInput.text, { promptInput }),
        ).rejects.toThrow("does not support image");
      });
      expect(send).toHaveBeenCalledOnce();
    } finally {
      await act(async () => unmount());
    }
  });

  it("edits a queued vision message after choosing a text-only model for the next message", async () => {
    const sessionId = "queued-image-capability-session";
    const imageProvider = {
      ...provider,
      models: [
        {
          slug: "vision",
          name: "Vision",
          isCustom: false,
          capabilities: { inputModalities: ["text", "image"] },
        },
        {
          slug: "text-only",
          name: "Text only",
          isCustom: false,
          capabilities: { inputModalities: ["text"] },
        },
      ],
    } as AgentRuntimeProvider;
    const conversation = {
      sessionId,
      projectId: "project",
      threadId: "engine-thread",
      snapshot: {
        ...snapshot,
        projection: {
          ...snapshot.projection,
          thread: {
            ...snapshot.projection.thread,
            modelSelection: { instanceId: "codex", model: "vision" },
          },
          runs: [
            {
              id: "queued-vision-run",
              threadId: "engine-thread",
              ordinal: 1,
              providerInstanceId: "codex",
              providerThreadId: null,
              rootNodeId: null,
              activeAttemptId: null,
              userMessageId: "queued-vision-message",
              modelSelection: { instanceId: "codex", model: "vision" },
              status: "queued",
              requestedAt: "2026-10-22T00:00:00.000Z",
              startedAt: null,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          ],
        },
      } as AgentSnapshot,
    };
    vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue([imageProvider]);
    vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue(conversation);
    vi.spyOn(agentRuntimeRuntime, "read").mockResolvedValue(conversation);
    vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
    vi.mocked(agentRuntimeRuntime.readQueuePage).mockResolvedValue({
      snapshotSequence: 1,
      entries: [
        {
          runId: "queued-vision-run",
          userMessageId: "queued-vision-message",
          userItemId: "queued-vision-item",
          queuePosition: 1,
          held: false,
          requestedAt: "2026-10-22T00:00:00.000Z",
        },
      ],
      nextCursor: null,
      nextRunId: null,
    });
    vi.mocked(agentRuntimeRuntime.readQueuedPreview).mockResolvedValue({
      threadId: "engine-thread",
      runId: "queued-vision-run",
      messageId: "queued-vision-message",
      text: "Inspect this",
      images: [],
    });
    vi.mocked(agentRuntimeRuntime.readRunMessage).mockResolvedValue({
      id: "queued-vision-message",
      threadId: "engine-thread",
      role: "user",
      runId: "queued-vision-run",
      nodeId: null,
      streaming: false,
      text: "Inspect this",
      attachments: [],
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
      createdBy: "user",
      creationSource: "web",
    });
    const edit = vi.spyOn(agentRuntimeRuntime, "queue").mockResolvedValue({ sequence: 1 });
    const { result, unmount } = renderHook(
      () =>
        useAgentRuntimeConversationAdapter({
          sessionId,
          executionRef: { runtimeId: "engine", threadId: "engine-thread" },
          projectId: "project",
          modelProjectId: "project",
          instances,
          onRefresh: async () => {},
          onOpenThread: () => {},
          ensureDraft: async () => ({ id: sessionId }),
        }),
      { wrapper: RuntimeWorkbench },
    );
    let releaseTranscript: (() => void) | undefined;
    try {
      await waitFor(() => expect(result.current.state.connection).toBe("ready"));
      await waitFor(() => expect(result.current.provider.modelCatalog?.loading).toBe(false));
      await act(async () => {
        releaseTranscript = result.current.runtime
          .transcriptReadOwner?.("engine-thread")
          ?.subscribeStructure(() => {});
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(result.current.state.view?.queuedFollowUps?.entries[0]?.followUpId).toBe(
          "queued-vision-run",
        ),
      );
      await act(async () => {
        await result.current.provider.modelCatalog!.choose({
          binding: { kind: "codex" },
          model: "text-only",
        });
      });
      expect(result.current.provider.controls?.images).toBe(false);
      const images = [{ source: "data:image/png;base64,aW1hZ2U=" }];
      await act(async () => {
        await expect(
          result.current.actions.onReplaceQueuedFollowUp!(
            "engine-thread",
            "queued-vision-run",
            1,
            "Inspect this updated image",
            { promptInput: { text: "Inspect this updated image", images } },
          ),
        ).resolves.toBe(true);
      });
      expect(edit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "edit",
          runId: "queued-vision-run",
          message: expect.objectContaining({ text: "Inspect this updated image", images }),
        }),
      );
      expect(edit.mock.calls[0]![0]).toHaveProperty("message");
      const edited = edit.mock.calls[0]![0];
      expect(edited.action === "edit" && edited.message.modelSelection).toBeUndefined();
      expect(result.current.selectedModel).toBe("text-only");
    } finally {
      await act(async () => {
        releaseTranscript?.();
        unmount();
      });
    }
  });
});

describe("Agent Runtime sent-image edit admission", () => {
  it.each([
    { currentModel: "vision", configuredModel: "text-only", accepted: false },
    { currentModel: "text-only", configuredModel: "vision", accepted: true },
  ])(
    "checks the configured $configuredModel model before rewinding a sent image from $currentModel",
    async ({ currentModel, configuredModel, accepted }) => {
      const sessionId = `sent-image-edit-${configuredModel}`;
      const target = { sessionId, threadId: "engine-thread" };
      const providers = [
        {
          ...provider,
          supportsConversationRollback: true,
          models: [
            {
              slug: "vision",
              name: "Vision",
              isCustom: false,
              capabilities: { inputModalities: ["text", "image"] },
            },
            {
              slug: "text-only",
              name: "Text only",
              isCustom: false,
              capabilities: { inputModalities: ["text"] },
            },
          ],
        },
      ] as AgentRuntimeProvider[];
      vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue(providers);
      vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
        ...target,
        projectId: "project",
        snapshot: {
          ...snapshot,
          projection: {
            ...snapshot.projection,
            thread: {
              ...snapshot.projection.thread,
              modelSelection: { instanceId: "codex", model: currentModel },
            },
          },
        },
      });
      vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
      const images = [{ source: "/attachments/chart.png", caption: "chart.png" }];
      const acquired = acquireAgentRuntimeConversationOwner(target);
      vi.spyOn(acquired.owner, "readSentMessage").mockResolvedValue({
        message: {
          id: "sent-image-message",
          threadId: target.threadId,
          runId: "sent-image-run",
          nodeId: null,
          role: "user",
          text: "Inspect this",
          attachments: [
            {
              type: "image",
              id: "sent-image-attachment",
              name: "chart.png",
              mimeType: "image/png",
              sizeBytes: 10,
            },
          ],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: "2026-10-22T00:00:00.000Z",
          updatedAt: "2026-10-22T00:00:00.000Z",
        },
        images,
      });
      const rollback = vi
        .spyOn(agentRuntimeRuntime, "rollback")
        .mockResolvedValue({ rolledBack: true });
      const send = vi.spyOn(agentRuntimeRuntime, "message");
      if (accepted) send.mockResolvedValue({ sequence: 1 });
      else send.mockRejectedValue(new Error("This model does not support image attachments."));
      const { result, unmount } = renderHook(
        () =>
          useAgentRuntimeConversationAdapter({
            sessionId,
            executionRef: { runtimeId: "engine", threadId: target.threadId },
            projectId: "project",
            modelProjectId: "project",
            instances,
            onRefresh: async () => {},
            onOpenThread: () => {},
            ensureDraft: async () => ({ id: sessionId }),
          }),
        { wrapper: RuntimeWorkbench },
      );
      // This is the same raw config form accepted by splitCodexPromptAgentConfigLines.
      const message = `<agent-config model="${configuredModel}" />\nInspect this again`;
      try {
        await waitFor(() => expect(result.current.state.connection).toBe("ready"));
        await waitFor(() => expect(result.current.provider.modelCatalog?.loading).toBe(false));
        await act(async () => {
          const editing = result.current.actions.onEditUserTurn!({
            threadId: target.threadId,
            turnId: "sent-image-run",
            message,
          });
          if (accepted) await editing;
          else await expect(editing).rejects.toThrow("does not support image");
        });
        if (accepted) {
          expect(rollback).toHaveBeenCalledOnce();
          expect(send).toHaveBeenCalledWith(
            expect.objectContaining({
              ...target,
              message: expect.objectContaining({ images }),
            }),
          );
          expect(rollback.mock.invocationCallOrder[0]).toBeLessThan(
            send.mock.invocationCallOrder[0]!,
          );
        } else {
          expect(rollback).not.toHaveBeenCalled();
          expect(send).not.toHaveBeenCalled();
        }
      } finally {
        await act(async () => unmount());
      }
    },
  );
});
