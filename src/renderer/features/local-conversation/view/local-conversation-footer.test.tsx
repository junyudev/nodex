import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { installAsyncRequestAnimationFrame } from "../../../test/browser-globals";
import { NodexTooltipProvider as TooltipProvider } from "../../../components/ui/tooltip";
import { renderWithMaitai } from "../../../test/thread-maitai";
import { LocalConversationFooter } from "./local-conversation-footer";
import { TestQueryProvider } from "../../../test/query";
import type { ThreadFooterModel, ThreadStageActions } from "../thread-stage-types";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import { EnsureLocalConversationThreadScrollController } from "./local-conversation-thread-scroll-controller";

vi.mock("@/lib/use-command-keymap-state", () => ({
  useCommandKeymapState: () => ({
    data: { version: 1, platform: "macOS", entries: [], hasCustomBindings: false },
  }),
}));

const render = (ui: Parameters<typeof renderWithMaitai>[0]) =>
  renderWithMaitai(ui, { wrapper: TestQueryProvider });

function buildModel(overrides?: Partial<ThreadFooterModel>): ThreadFooterModel {
  return {
    connectionStatus: "connected",
    workspaceSearchContext: {
      hostId: "local",
      roots: ["/tmp/project"],
      skillRoots: ["/tmp/project"],
    },
    projectId: "project_1",
    hostId: "local",
    projectWorkspacePath: "/tmp/project",
    threadId: "thread_1",
    cwd: "/tmp/project",
    account: null,
    conversation: {
      threadId: "thread_1",
      projectId: "project_1",
      source: null,
      threadName: "Thread",
      threadPreview: "Preview",
      modelProvider: "openai",
      cwd: "/tmp/project",
      statusType: "active",
      statusActiveFlags: [],
      archived: false,
      createdAt: 1,
      updatedAt: 2,
      linkedAt: "2026-04-06T00:00:00.000Z",
      resumeState: "resumed",
      turns: [
        {
          threadId: "thread_1",
          turnId: "turn_1",
          status: "completed",
          itemIds: [],
          items: [],
        },
      ],
      requests: [],
      queuedFollowUps: {
        status: "ready",
        ledgerRevision: 0,
        projectionRevision: 0,
        entries: [],
        inFlightFollowUpId: null,
        editingFollowUpId: null,
        error: null,
      },
      pendingSteers: [],
      backgroundTerminalRows: [],
      capabilityFlags: {
        canEditUserTurns: true,
        canForkFromTurn: true,
        canSearch: true,
        canCollapseTurns: true,
      },
    },
    resumeState: "resumed",
    activeTurn: null,
    isThreadRunning: false,
    isNewThreadTab: false,
    newThreadTarget: null,
    availableModels: [],
    collaborationModes: [],
    selectedCollaborationMode: "default",
    selectedModel: "gpt-5.3-codex",
    modelPickerShortcut: {
      label: "Ctrl+Shift+M",
      ariaKeyShortcuts: "Control+Shift+M",
    },
    selectedReasoningEffort: "high",
    reasoningEffortOptions: [],

    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    composerIntent: null,
    dictation: {
      isEnabled: true,
      authMethod: "chatgpt",
      shortcutLabel: "Ctrl+M",
      capabilities: {
        composer: true,
        global: true,
        history: true,
        streaming: "available",
        semanticCleanup: false,
        sounds: false,
        voiceDictionary: false,
        microphoneOwner: "none",
        auth: "chatgpt",
      },
    },
    body: {
      threadId: "thread_1",
      turnCount: 1,
      isThreadRunning: false,
      activeTurnId: null,
      latestTurnId: "turn_1",
      emptyState: { type: "none" },
      showThreadStartProgressPanel: false,
    },
    composerShell: {
      activeRequest: null,
      backgroundRequest: null,
      pendingSteerRows: [],
      queuedFollowUpRows: [],
      backgroundAgentRows: [],
      showRequestCards: false,
      showComposer: true,
    },
    ...overrides,
  };
}

function buildActions(overrides?: Partial<ThreadStageActions>): ThreadStageActions {
  return {
    onCollaborationModeChange: () => {},
    onModelChange: () => {},
    onReasoningEffortChange: () => {},

    onQueueingEnabledChange: () => {},
    onSendPrompt: async () => {},
    onSendCapturedFollowUp: async () => {},
    onSteerPrompt: async () => {},
    onInterruptTurn: async () => {},
    onRespondUserInput: async () => {},
    onRespondMcpElicitation: async () => {},
    onResolvePlanImplementationRequest: async () => {},
    onEnqueueQueuedFollowUp: async () => {},
    onRemoveQueuedFollowUp: async () => {},
    onReorderQueuedFollowUps: async () => {},
    onSendQueuedFollowUpNow: async () => {},
    onEditQueuedFollowUp: async () => {},
    onEditUserTurn: async () => {},
    onForkFromTurn: async () => {},
    onUnarchiveThread: async () => {},
    onOpenTurnDiffReview: () => {},
    onOpenThread: () => {},
    onStopBackgroundTerminals: async () => {},
    ...overrides,
  };
}

function buildUserItem(overrides?: Partial<CodexConversationItem>): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "user_1",
    entryId: "user_1",
    type: "user_message",
    kind: "userMessage",
    semanticKind: "userMessage",
    role: "user",
    markdownText: "Run the checks",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildAssistantItem(overrides?: Partial<CodexConversationItem>): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "assistant_1",
    entryId: "assistant_1",
    type: "assistant_message",
    kind: "assistantMessage",
    semanticKind: "assistantMessage",
    assistantPhase: "final_answer",
    role: "assistant",
    markdownText: "Checks passed",
    status: "completed",
    createdAt: 2,
    updatedAt: 2,
    ...overrides,
  };
}

function buildRenderableTurn(overrides?: Partial<CodexConversationTurn>): CodexConversationTurn {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    status: "completed",
    itemIds: ["user_1", "assistant_1"],
    items: [buildUserItem(), buildAssistantItem()],
    ...overrides,
  };
}

/** Stands in for the connected thread an expanded floating composer shows. */
const floatingThread = <p data-testid="floating-thread">Release notes are ready.</p>;

function buildModelWithRenderableLatestTurn(): ThreadFooterModel {
  const baseModel = buildModel();
  const latestTurn = buildRenderableTurn();
  if (!baseModel.conversation) return baseModel;

  return buildModel({
    conversation: {
      ...baseModel.conversation,
      turns: [latestTurn],
    },
    body: {
      ...baseModel.body,
      turnCount: 1,
      latestTurnId: latestTurn.turnId,
    },
  });
}

describe("LocalConversationFooter", () => {
  test("resumes an interrupted turn once without creating a tooltip action", async () => {
    const base = buildModel();
    const model = buildModel({
      conversation: base.conversation
        ? {
            ...base.conversation,
            statusType: "idle",
            statusActiveFlags: [],
            turns: base.conversation.turns.map((turn, index, turns) =>
              index === turns.length - 1 ? { ...turn, status: "interrupted" } : turn,
            ),
          }
        : null,
      activeTurn: null,
      isThreadRunning: false,
    });
    let releaseResume: () => void = () => undefined;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const onResumeInterruptedTurn = vi.fn(async () => await resumeGate);
    const view = render(
      <TooltipProvider>
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationFooter
            model={model}
            actions={buildActions({ onResumeInterruptedTurn })}
          />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>,
    );

    const resumeButton = await view.findByLabelText("Resume");
    expect(resumeButton.getAttribute("title")).toBeNull();

    await act(async () => {
      fireEvent.click(resumeButton);
      await Promise.resolve();
    });
    expect(onResumeInterruptedTurn).toHaveBeenCalledTimes(1);
    expect(resumeButton.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      fireEvent.click(resumeButton);
      releaseResume();
      await resumeGate;
    });
    expect(onResumeInterruptedTurn).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(resumeButton.hasAttribute("disabled")).toBe(false));
  });

  beforeEach(() => {
    installAsyncRequestAnimationFrame();
  });

  test("keeps a pending worktree draft visible but prevents a second start", async () => {
    const blockedReason = "Worktree setup is already in progress";
    const model = buildModel({
      threadId: null,
      conversation: null,
      isNewThreadTab: true,
      newThreadTarget: {
        projectId: "project_1",
        projectName: "Project",
        sessionId: "session_1",
        runInTarget: "newWorktree",
      },
      newThreadStartBlockedReason: blockedReason,
    });
    const view = render(
      <TestQueryProvider>
        <TooltipProvider>
          <EnsureLocalConversationThreadScrollController>
            <LocalConversationFooter model={model} actions={buildActions()} />
          </EnsureLocalConversationThreadScrollController>
        </TooltipProvider>
      </TestQueryProvider>,
    );

    await waitFor(() => {
      const prompt = view.container.querySelector('[data-codex-composer="true"]');
      if (!prompt) throw new Error("Expected pending worktree composer");
      expect(prompt.getAttribute("aria-label")).toBe(blockedReason);
      expect(prompt.getAttribute("contenteditable")).toBe("false");
    });
  });

  test("expands a chat before its first turn, and keeps the Project Dock target without one", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const base = buildModel();
    const renderFooter = (transcript: ReactNode) => (
      <TooltipProvider>
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationFooter
            model={buildModel({
              conversation: base.conversation ? { ...base.conversation, turns: [] } : null,
              body: { ...base.body, turnCount: 0, latestTurnId: null },
            })}
            actions={buildActions()}
            rightPanelComposerOverlay={{
              enabled: true,
              target,
              transcript,
              leadingContent: <button type="button">Greet user</button>,
            }}
          />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>
    );
    const view = render(renderFooter(null));

    const overlay = await waitFor(() => {
      const element = document.body.querySelector<HTMLElement>(
        '[data-testid="right-panel-composer-overlay"]',
      );
      if (!element) throw new Error("Expected right-panel overlay");
      return element;
    });
    const rails = await waitFor(() => {
      const found = overlay.querySelectorAll('[data-composer-context-rail="true"]');
      expect(found).toHaveLength(1);
      return found;
    });
    expect(
      within(rails[0] as HTMLElement).getByRole("button", {
        name: "Greet user",
        hidden: true,
      }),
    ).not.toBeNull();
    // Without a chat there is nothing to expand into.
    expect(overlay.querySelector('button[aria-label="Expand composer"]')).toBeNull();

    // A chat expands as soon as it exists, before its first turn.
    await act(async () => {
      view.rerender(renderFooter(floatingThread));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(overlay.querySelector('button[aria-label="Expand composer"]')).not.toBeNull();
    });
  });

  test("collapses the floating conversation atomically when the composer target changes", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const model = buildModelWithRenderableLatestTurn();
    const actions = buildActions();
    const renderFooter = (composerScopeIdentity: string) => (
      <TooltipProvider>
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationFooter
            model={{ ...model, composerScopeIdentity }}
            actions={actions}
            rightPanelComposerOverlay={{ enabled: true, target, transcript: floatingThread }}
          />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>
    );
    const view = render(renderFooter("project-dock:session-a"));
    const expand = await waitFor(() => {
      const element = document.body.querySelector<HTMLElement>(
        'button[aria-label="Expand composer"]',
      );
      if (!element) throw new Error("Expected the expand toggle");
      return element;
    });

    await act(async () => {
      fireEvent.click(expand);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="floating-thread"]')).not.toBeNull();
    });

    await act(async () => {
      view.rerender(renderFooter("project-dock:session-b"));
      await Promise.resolve();
    });

    expect(
      document.body
        .querySelector('button[aria-label="Expand composer"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(document.body.querySelector('[data-testid="floating-thread"]')).toBeNull();
  });

  test("outside pointerdown collapses the floating conversation without globally dismissing tooltips", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    let tooltipDismissEvents = 0;
    const handleTooltipDismiss = () => {
      tooltipDismissEvents += 1;
    };
    window.addEventListener("codex:dismiss-tooltips", handleTooltipDismiss);

    try {
      render(
        <TooltipProvider>
          <EnsureLocalConversationThreadScrollController>
            <LocalConversationFooter
              model={buildModelWithRenderableLatestTurn()}
              actions={buildActions()}
              rightPanelComposerOverlay={{ enabled: true, target, transcript: floatingThread }}
            />
          </EnsureLocalConversationThreadScrollController>
        </TooltipProvider>,
      );

      const expand = await waitFor(() => {
        const element = document.body.querySelector<HTMLElement>(
          'button[aria-label="Expand composer"]',
        );
        if (!element) throw new Error("Expected the expand toggle");
        return element;
      });
      await act(async () => {
        fireEvent.click(expand);
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          document.body.querySelector('button[aria-label="Collapse composer"]'),
        ).not.toBeNull();
      });

      await act(async () => {
        fireEvent.pointerDown(document.body);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(
          document.body
            .querySelector('button[aria-label="Expand composer"]')
            ?.getAttribute("aria-expanded"),
        ).toBe("false");
      });
      expect(tooltipDismissEvents).toBe(0);
    } finally {
      window.removeEventListener("codex:dismiss-tooltips", handleTooltipDismiss);
    }
  });

  test("a reconnecting chat keeps its composer and holds sending", async () => {
    const { container } = render(
      <TooltipProvider>
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationFooter
            model={buildModel({
              resumeState: "needs_resume",
              attachmentState: { status: "failed", message: "socket closed" },
              sendGate: {
                unsentReason: "Nodex couldn’t connect to this chat",
                notice: {
                  key: "chat:connection-failed",
                  tone: "danger",
                  title: "Couldn’t connect to this chat",
                  actions: [{ label: "Retry", run: () => undefined }],
                },
              },
            })}
            actions={buildActions()}
          />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>,
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-local-conversation-composer-shell="true"]'),
      ).not.toBeNull(),
    );
    const notice = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('[data-composer-notice="danger"]');
      if (!element) throw new Error("Expected the connection notice");
      return element;
    });
    expect(within(notice).getByText("Couldn’t connect to this chat")).not.toBeNull();
    expect(within(notice).getByRole("button", { name: "Retry" })).not.toBeNull();
  });
});
