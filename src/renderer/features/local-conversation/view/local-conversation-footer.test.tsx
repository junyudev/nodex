import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import {
  installAsyncRequestAnimationFrame,
  installMotionPreferenceForTest,
} from "../../../test/browser-globals";
import { NodexTooltipProvider as TooltipProvider } from "../../../components/ui/tooltip";
import { renderWithMaitai } from "../../../test/thread-maitai";
import { settleAsyncRender } from "../../../test/dom";
import { TestQueryProvider } from "../../../test/query";
import type { ThreadFooterModel, ThreadStageActions } from "../thread-stage-types";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
} from "./local-conversation-thread-scroll-controller";

vi.mock("@/lib/use-command-keymap-state", () => ({
  useCommandKeymapState: () => ({
    data: { version: 1, platform: "macOS", entries: [], hasCustomBindings: false },
  }),
}));

const render = (ui: Parameters<typeof renderWithMaitai>[0]) =>
  renderWithMaitai(ui, { wrapper: TestQueryProvider });

function buildModel(overrides?: Partial<ThreadFooterModel>): ThreadFooterModel {
  return {
    projectId: "project_1",
    hostId: "default",
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
        canEditLastUserTurn: true,
        canForkFromTurn: true,
        canSearch: true,
        canCollapseTurns: true,
      },
    },
    resumeState: "resumed",
    activeTurn: null,
    isThreadRunning: false,
    isNewThreadTab: false,
    isCloudNewThreadTarget: false,
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
    permissionMode: "auto",
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
      backgroundTerminalRows: [],
      showRequestCards: false,
      showComposer: true,
      showApprovalMode: false,
    },
    ...overrides,
  };
}

function buildActions(overrides?: Partial<ThreadStageActions>): ThreadStageActions {
  return {
    onCollaborationModeChange: () => {},
    onModelChange: () => {},
    onReasoningEffortChange: () => {},
    onPermissionModeChange: () => {},
    onQueueingEnabledChange: () => {},
    onSendPrompt: async () => {},
    onSteerPrompt: async () => {},
    onInterruptTurn: async () => {},
    onRespondApproval: async () => {},
    onRespondUserInput: async () => {},
    onRespondMcpElicitation: async () => {},
    onResolvePlanImplementationRequest: async () => {},
    onEnqueueQueuedFollowUp: async () => {},
    onRemoveQueuedFollowUp: async () => {},
    onReorderQueuedFollowUps: async () => {},
    onSendQueuedFollowUpNow: async () => {},
    onEditQueuedFollowUp: async () => {},
    onEditLastUserTurn: async () => {},
    onForkFromTurn: async () => {},
    onUnarchiveThread: async () => {},
    onOpenTurnDiffReview: () => {},
    onConsumeComposerIntent: () => {},
    onOpenThread: () => {},
    onCleanBackgroundTerminals: async () => {},
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

function isBefore(node: Element | null | undefined, nextNode: Element | null | undefined) {
  if (!node || !nextNode) return false;
  return Boolean(node.compareDocumentPosition(nextNode) & Node.DOCUMENT_POSITION_FOLLOWING);
}

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
    const { LocalConversationFooter } = await import("./local-conversation-footer");
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
            errorMessage={null}
            onErrorMessage={() => {}}
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
    const { LocalConversationFooter } = await import("./local-conversation-footer");
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
            <LocalConversationFooter
              model={model}
              actions={buildActions()}
              errorMessage={null}
              onErrorMessage={() => {}}
            />
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

  test("updates composer mode chrome when the selected collaboration mode changes", async () => {
    const { LocalConversationFooter } = await import("./local-conversation-footer");
    const baseModel = buildModel({
      collaborationModes: [
        { mode: "default", name: "Default", model: null },
        { mode: "plan", name: "Plan", model: null },
      ],
    });
    const actions = buildActions();
    const view = render(
      <TooltipProvider>
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationFooter
            model={{ ...baseModel, selectedCollaborationMode: "default" }}
            actions={actions}
            errorMessage={null}
            onErrorMessage={() => {}}
          />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>,
    );

    expect(view.queryByLabelText("Plan") === null).toBe(true);

    view.rerender(
      <TooltipProvider>
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationFooter
            model={{ ...baseModel, selectedCollaborationMode: "plan" }}
            actions={actions}
            errorMessage={null}
            onErrorMessage={() => {}}
          />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>,
    );

    const planButton = await view.findByLabelText("Plan");
    const formFooter = view.container.querySelector('[data-composer-form-footer="true"]');
    expect(formFooter !== null).toBe(true);
    expect(Boolean(formFooter?.contains(planButton))).toBe(true);

    fireEvent.pointerDown(view.getByLabelText("Add files and more"), { button: 0, ctrlKey: false });
    fireEvent.click(view.getByLabelText("Add files and more"));

    await waitFor(() => {
      const planRow = view.container.ownerDocument.body.querySelector(
        '[data-add-context-row="plan-mode"]',
      );
      if (!planRow) {
        throw new Error("Expected the Plan mode row.");
      }
      expect(planRow.querySelector('[data-state="checked"]') !== null).toBe(true);
    });

    view.rerender(
      <TooltipProvider>
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationFooter
            model={{ ...baseModel, selectedCollaborationMode: "default" }}
            actions={actions}
            errorMessage={null}
            onErrorMessage={() => {}}
          />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>,
    );

    expect(view.queryByLabelText("Plan") === null).toBe(true);
  });

  test("renders the catch-up button inside the footer owner", async () => {
    const restoreMotionPreference = installMotionPreferenceForTest(true);
    const { LocalConversationFooter } = await import("./local-conversation-footer");
    const { container, getByLabelText } = render(
      <TooltipProvider>
        <div className="h-96">
          <EnsureLocalConversationThreadScrollController>
            <div className="flex h-full flex-col">
              <div className="min-h-0 flex-1">
                <LocalConversationThreadScrollLayout>
                  <div style={{ height: "1200px" }}>Thread content</div>
                </LocalConversationThreadScrollLayout>
              </div>
              <LocalConversationFooter
                model={buildModel()}
                actions={buildActions()}
                errorMessage={null}
                onErrorMessage={() => {}}
              />
            </div>
          </EnsureLocalConversationThreadScrollController>
        </div>
      </TooltipProvider>,
    );
    await settleAsyncRender();

    const viewport = container.querySelector(
      "[data-local-conversation-thread-body='true']",
    ) as HTMLDivElement | null;
    expect(Boolean(viewport)).toBe(true);

    if (!viewport) return;

    let scrollTopValue = 0;
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });
    const scrollToCalls: Array<{ top?: number; behavior?: ScrollBehavior }> = [];
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: ({ top, behavior }: { top?: number; behavior?: ScrollBehavior }) => {
        scrollToCalls.push({ top, behavior });
        if (typeof top === "number") {
          scrollTopValue = top;
        }
      },
    });

    scrollTopValue = -200;
    await act(async () => {
      fireEvent.scroll(viewport);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(Boolean(container.querySelector('[aria-label="Scroll to latest message"]'))).toBe(
        true,
      );
    });

    scrollToCalls.length = 0;
    await act(async () => {
      fireEvent.click(getByLabelText("Scroll to latest message"));
      await Promise.resolve();
    });

    const footerOwner = container.querySelector('[data-thread-find-composer="true"]');
    const catchUpSlot = footerOwner?.querySelector('[data-thread-catch-up-control="true"]');
    const footerStack = footerOwner?.querySelector('[data-thread-footer-stack="true"]');
    const aboveComposerPortal = footerStack?.querySelector("#above-composer-portal");
    const queuePortal = footerStack?.querySelector("#above-composer-queue-portal");
    const composerShell = footerStack?.querySelector(
      '[data-local-conversation-composer-shell="true"]',
    );
    expect(footerOwner !== null).toBe(true);
    expect(catchUpSlot !== null).toBe(true);
    expect(footerStack !== null).toBe(true);
    expect(aboveComposerPortal !== null).toBe(true);
    expect(queuePortal !== null).toBe(true);
    expect(composerShell !== null).toBe(true);
    expect(isBefore(catchUpSlot, footerStack)).toBe(true);
    expect(isBefore(aboveComposerPortal, queuePortal)).toBe(true);
    expect(isBefore(queuePortal, composerShell)).toBe(true);
    expect(scrollToCalls.length).toBe(1);
    expect(scrollToCalls[0]?.top).toBe(0);
    restoreMotionPreference();
  });

  test("overlay mode renders portals, latest-turn preview, and composer in fixture order", async () => {
    const { LocalConversationFooter } = await import("./local-conversation-footer");
    const target = document.createElement("div");
    document.body.appendChild(target);

    render(
      <TooltipProvider>
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationFooter
            model={buildModelWithRenderableLatestTurn()}
            actions={buildActions()}
            errorMessage={null}
            onErrorMessage={() => {}}
            rightPanelComposerOverlay={{ enabled: true, target }}
          />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>,
    );

    await waitFor(() => {
      const overlay = document.body.querySelector('[data-testid="right-panel-composer-overlay"]');
      if (!overlay) throw new Error("Expected right-panel overlay");
      expect(overlay.querySelector('[data-thread-find-composer="true"]') !== null).toBe(true);
      expect(overlay.querySelector('[data-thread-catch-up-control="true"]') !== null).toBe(true);
      expect(overlay.querySelector('[data-thread-footer-stack="true"]') !== null).toBe(true);
      expect(overlay.querySelector("#above-composer-portal") !== null).toBe(true);
      expect(overlay.querySelector("#above-composer-queue-portal") !== null).toBe(true);
      expect(overlay.querySelector('[data-right-panel-latest-turn-preview="true"]') !== null).toBe(
        true,
      );
      expect(
        overlay.querySelector('[data-local-conversation-composer-shell="true"]') !== null,
      ).toBe(true);
    });

    const overlay = document.body.querySelector(
      '[data-testid="right-panel-composer-overlay"]',
    ) as HTMLElement;
    const footerOwner = overlay.querySelector('[data-thread-find-composer="true"]');
    const catchUpSlot = footerOwner?.querySelector('[data-thread-catch-up-control="true"]');
    const footerStack = footerOwner?.querySelector('[data-thread-footer-stack="true"]');
    const aboveComposerPortal = footerStack?.querySelector("#above-composer-portal");
    const queuePortal = footerStack?.querySelector("#above-composer-queue-portal");
    const latestTurnPreview = footerStack?.querySelector(
      '[data-right-panel-latest-turn-preview="true"]',
    );
    const composerShell = footerStack?.querySelector(
      '[data-local-conversation-composer-shell="true"]',
    );
    if (!aboveComposerPortal || !queuePortal || !latestTurnPreview || !composerShell) {
      throw new Error("Expected overlay fixture nodes");
    }

    expect(isBefore(catchUpSlot, footerStack)).toBe(true);
    expect(
      Boolean(
        aboveComposerPortal.compareDocumentPosition(queuePortal) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(
      Boolean(
        queuePortal.compareDocumentPosition(latestTurnPreview) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(
      Boolean(
        latestTurnPreview.compareDocumentPosition(composerShell) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    await waitFor(() => {
      expect(overlay.getAttribute("aria-hidden")).toBe("false");
      const prompt = overlay.querySelector('[data-codex-composer="true"]');
      if (!prompt) throw new Error("Expected floating prompt editor");
      expect(prompt.getAttribute("aria-label")).toBe("Do anything");
    });
    const addContext = overlay.querySelector('button[aria-label="Add files and more"]');
    const prompt = overlay.querySelector('[data-codex-composer="true"]');
    const permission = overlay.querySelector('button[aria-label="Change permissions"]');
    const formFooter = overlay.querySelector('[data-composer-form-footer="true"]');
    const inputSlot = formFooter?.querySelector('[data-composer-input-slot="true"]');
    expect(isBefore(addContext, prompt)).toBe(true);
    expect(isBefore(prompt, permission)).toBe(true);
    expect(permission?.textContent).toBe("");
    expect(formFooter?.getAttribute("data-composer-layout")).toBe("single-line");
    expect(inputSlot?.getAttribute("data-composer-footer-row")).toBe("single-line");
    expect(inputSlot?.contains(prompt)).toBe(true);
    expect(overlay.textContent?.includes("Run the checks") ?? false).toBe(false);
    expect(overlay.querySelector('[data-composer-attachments="true"]')).toBeNull();

    const previewToggle = latestTurnPreview.querySelector("button");
    if (!previewToggle) throw new Error("Expected latest turn toggle");
    await act(async () => {
      fireEvent.click(previewToggle);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(overlay.querySelector('button[aria-label="Copy"]') !== null).toBe(true);
    });
  });

  test("unifies a connected Project Dock target and latest turn in one context rail", async () => {
    const { LocalConversationFooter } = await import("./local-conversation-footer");
    const target = document.createElement("div");
    document.body.appendChild(target);

    render(
      <TooltipProvider>
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationFooter
            model={buildModelWithRenderableLatestTurn()}
            actions={buildActions()}
            errorMessage={null}
            onErrorMessage={() => {}}
            rightPanelComposerOverlay={{
              enabled: true,
              target,
              leadingContent: (
                <div className="contents">
                  <button type="button" className="order-1">
                    Greet user
                  </button>
                  <button type="button" className="order-3">
                    Open task
                  </button>
                </div>
              ),
            }}
          />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>,
    );

    const overlay = await waitFor(() => {
      const element = document.body.querySelector<HTMLElement>(
        '[data-testid="right-panel-composer-overlay"]',
      );
      if (!element) throw new Error("Expected right-panel overlay");
      return element;
    });
    const rails = overlay.querySelectorAll('[data-composer-context-rail="true"]');
    expect(rails).toHaveLength(1);
    const rail = rails[0];
    if (!(rail instanceof HTMLElement)) throw new Error("Expected context rail");
    expect(within(rail).getByRole("button", { name: "Greet user" })).not.toBeNull();
    expect(within(rail).getByRole("button", { name: "Open task" })).not.toBeNull();
    expect(rail.querySelector('button[aria-expanded="false"]')).not.toBeNull();
  });

  test("keeps the Project Dock target when the latest turn has no renderable blocks", async () => {
    const { LocalConversationFooter } = await import("./local-conversation-footer");
    const target = document.createElement("div");
    document.body.appendChild(target);

    render(
      <TooltipProvider>
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationFooter
            model={buildModel()}
            actions={buildActions()}
            errorMessage={null}
            onErrorMessage={() => {}}
            rightPanelComposerOverlay={{
              enabled: true,
              target,
              leadingContent: <button type="button">Greet user</button>,
            }}
          />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>,
    );

    const overlay = await waitFor(() => {
      const element = document.body.querySelector<HTMLElement>(
        '[data-testid="right-panel-composer-overlay"]',
      );
      if (!element) throw new Error("Expected right-panel overlay");
      return element;
    });
    const rails = overlay.querySelectorAll('[data-composer-context-rail="true"]');
    expect(rails).toHaveLength(1);
    expect(
      within(rails[0] as HTMLElement).getByRole("button", {
        name: "Greet user",
      }),
    ).not.toBeNull();
    expect(overlay.querySelector('[data-right-panel-latest-turn-preview="true"]')).toBeNull();
  });

  test("unifies a Project-scoped new task without repeating its fixed Project", async () => {
    const { LocalConversationFooter } = await import("./local-conversation-footer");
    const target = document.createElement("div");
    document.body.appendChild(target);
    const baseModel = buildModel();
    const model = buildModel({
      threadId: null,
      conversation: null,
      isNewThreadTab: true,
      newThreadTarget: {
        projectId: "project_1",
        projectName: "Project",
        sessionId: "session_1",
        projectDraftId: "draft_1",
        runInTarget: "localProject",
      },
      newThreadProjectSelector: {
        projects: [
          {
            id: "project_1",
            label: "Project",
            appearance: {
              color: "blue",
              marker: { kind: "icon", icon: "folder" },
            },
            description: "/tmp/project",
            primaryWorkspaceRoot: "/tmp/project",
            searchText: "project /tmp/project",
          },
        ],
        selectedProjectId: "project_1",
        disabled: true,
        canAddProject: false,
      },
      body: {
        ...baseModel.body,
        threadId: null,
        turnCount: 0,
        latestTurnId: null,
      },
    });

    render(
      <TestQueryProvider>
        <TooltipProvider>
          <EnsureLocalConversationThreadScrollController>
            <LocalConversationFooter
              model={model}
              actions={buildActions()}
              errorMessage={null}
              onErrorMessage={() => {}}
              rightPanelComposerOverlay={{
                enabled: true,
                target,
                leadingContent: <button type="button">New task</button>,
              }}
            />
          </EnsureLocalConversationThreadScrollController>
        </TooltipProvider>
      </TestQueryProvider>,
    );

    const overlay = await waitFor(() => {
      const element = document.body.querySelector<HTMLElement>(
        '[data-testid="right-panel-composer-overlay"]',
      );
      if (!element) throw new Error("Expected right-panel overlay");
      return element;
    });
    const rails = overlay.querySelectorAll('[data-composer-context-rail="true"]');
    expect(rails).toHaveLength(1);
    const rail = rails[0];
    if (!(rail instanceof HTMLElement)) throw new Error("Expected context rail");
    expect(within(rail).getByRole("button", { name: "New task" })).not.toBeNull();
    expect(within(rail).getByRole("button", { name: "Run target" })).not.toBeNull();
    expect(within(rail).queryByRole("button", { name: "Select project" })).toBeNull();
  });

  test("resets an expanded latest-turn tray atomically when the composer target changes", async () => {
    const { LocalConversationFooter } = await import("./local-conversation-footer");
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
            errorMessage={null}
            onErrorMessage={() => {}}
            rightPanelComposerOverlay={{ enabled: true, target }}
          />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>
    );
    const view = render(renderFooter("project-dock:session-a"));
    const preview = await waitFor(() => {
      const element = document.body.querySelector<HTMLElement>(
        '[data-right-panel-latest-turn-preview="true"]',
      );
      if (!element) throw new Error("Expected latest-turn tray");
      return element;
    });
    const previewToggle = preview.querySelector("button");
    if (!previewToggle) throw new Error("Expected latest-turn toggle");

    await act(async () => {
      fireEvent.click(previewToggle);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.body.querySelector('button[aria-label="Copy"]')).not.toBeNull();
    });

    await act(async () => {
      view.rerender(renderFooter("project-dock:session-b"));
      await Promise.resolve();
    });

    const nextPreview = document.body.querySelector<HTMLElement>(
      '[data-right-panel-latest-turn-preview="true"]',
    );
    expect(nextPreview?.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector('button[aria-label="Copy"]')).toBeNull();
  });

  test("floating multiline drafts retain the attachment tray layout", async () => {
    const { LocalConversationFooter } = await import("./local-conversation-footer");
    const target = document.createElement("div");
    document.body.appendChild(target);

    render(
      <TooltipProvider>
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationFooter
            model={{
              ...buildModelWithRenderableLatestTurn(),
              composerIntent: {
                prompt: "First line\nSecond line",
                focusNonce: 1,
              },
            }}
            actions={buildActions()}
            errorMessage={null}
            onErrorMessage={() => {}}
            rightPanelComposerOverlay={{ enabled: true, target }}
          />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>,
    );

    await waitFor(() => {
      const composer = document.body.querySelector(
        '[data-testid="right-panel-composer-overlay"] [data-codex-composer="true"]',
      );
      const attachmentTray = document.body.querySelector(
        '[data-testid="right-panel-composer-overlay"] [data-composer-attachments="true"]',
      );
      const formFooter = document.body.querySelector(
        '[data-testid="right-panel-composer-overlay"] [data-composer-form-footer="true"]',
      );
      const inputSlot = formFooter?.querySelector('[data-composer-input-slot="true"]');
      const leadingSlot = formFooter?.querySelector('[data-composer-footer-leading="true"]');
      const trailingSlot = formFooter?.querySelector('[data-composer-footer-trailing="true"]');
      expect(composer?.textContent).toContain("First line");
      expect(composer?.textContent).toContain("Second line");
      expect(attachmentTray !== null).toBe(true);
      expect(formFooter?.getAttribute("data-composer-layout")).toBe("multiline");
      expect(inputSlot?.getAttribute("data-composer-footer-row")).toBe("prompt");
      expect(inputSlot?.contains(composer ?? null)).toBe(true);
      expect(leadingSlot?.getAttribute("data-composer-footer-row")).toBe("controls");
      expect(trailingSlot?.getAttribute("data-composer-footer-row")).toBe("controls");
    });
  });

  test("promotes a visually wrapped one-line overlay draft to the normal composer layout", async () => {
    const { LocalConversationFooter } = await import("./local-conversation-footer");
    const target = document.createElement("div");
    document.body.appendChild(target);
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const measurement = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function measuredComposerRect(this: HTMLElement) {
        if (this.dataset.codexComposer === "true" && this.style.position === "fixed") {
          return new DOMRect(0, 0, 520, 20);
        }
        if (this.dataset.composerFormFooter === "true") {
          return new DOMRect(0, 0, 736, 44);
        }
        if (this.dataset.composerFooterLeading === "true") {
          return new DOMRect(0, 0, 28, 28);
        }
        if (this.dataset.composerInputSlot === "true") {
          return new DOMRect(0, 0, 400, 20);
        }
        if (this.dataset.composerFooterTrailing === "true") {
          return new DOMRect(0, 0, 280, 28);
        }
        return originalGetBoundingClientRect.call(this);
      });
    let view: ReturnType<typeof render> | null = null;

    try {
      view = render(
        <TooltipProvider>
          <EnsureLocalConversationThreadScrollController>
            <LocalConversationFooter
              model={{
                ...buildModelWithRenderableLatestTurn(),
                composerIntent: {
                  prompt:
                    "This prompt contains no newline but is wider than the compact composer input.",
                  focusNonce: 1,
                },
              }}
              actions={buildActions()}
              errorMessage={null}
              onErrorMessage={() => {}}
              rightPanelComposerOverlay={{ enabled: true, target }}
            />
          </EnsureLocalConversationThreadScrollController>
        </TooltipProvider>,
      );

      await waitFor(() => {
        const overlay = document.body.querySelector('[data-testid="right-panel-composer-overlay"]');
        const formFooter = overlay?.querySelector('[data-composer-form-footer="true"]');
        const inputSlot = formFooter?.querySelector('[data-composer-input-slot="true"]');
        const leadingSlot = formFooter?.querySelector('[data-composer-footer-leading="true"]');
        const trailingSlot = formFooter?.querySelector('[data-composer-footer-trailing="true"]');
        const permissionTrigger = formFooter?.querySelector(
          'button[aria-label="Change permissions"]',
        );
        const modelTrigger = formFooter?.querySelector(
          'button[data-intelligence-selector-trigger="true"]',
        );
        const sendButton = formFooter?.querySelector('button[aria-label="Send prompt"]');
        expect(formFooter?.getAttribute("data-composer-layout")).toBe("multiline");
        expect(inputSlot?.getAttribute("data-composer-footer-row")).toBe("prompt");
        expect(leadingSlot?.contains(permissionTrigger ?? null)).toBe(true);
        expect(trailingSlot?.contains(modelTrigger ?? null)).toBe(true);
        expect(trailingSlot?.contains(sendButton ?? null)).toBe(true);
        expect(leadingSlot?.contains(modelTrigger ?? null)).toBe(false);
      });
    } finally {
      view?.unmount();
      measurement.mockRestore();
      target.remove();
    }
  });

  test("keeps queued follow-ups in the queue portal outside the fixed pill", async () => {
    const { LocalConversationFooter } = await import("./local-conversation-footer");
    const baseModel = buildModel();
    const model = buildModel({
      isQueueingEnabled: true,
      composerShell: {
        ...baseModel.composerShell,
        queuedFollowUpRows: [
          {
            followUpId: "follow-up-1",
            threadId: "thread_1",
            prompt: "Run the final checks",
            displayText: "Run the final checks",
          },
        ],
      },
    });
    const { container } = render(
      <TooltipProvider>
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationFooter
            model={model}
            actions={buildActions()}
            errorMessage={null}
            onErrorMessage={() => {}}
          />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>,
    );

    await waitFor(() => {
      const queuePortal = container.querySelector("#above-composer-queue-portal");
      if (!queuePortal?.textContent?.includes("Run the final checks")) {
        throw new Error("Expected queued follow-up in queue portal");
      }
    });

    const aboveComposerPortal = container.querySelector("#above-composer-portal");
    const queuePortal = container.querySelector("#above-composer-queue-portal");
    expect(Boolean(queuePortal?.textContent?.includes("Run the final checks"))).toBe(true);
    expect(Boolean(aboveComposerPortal?.textContent?.includes("Run the final checks"))).toBe(false);
    expect(container.querySelector("[data-above-composer-fixed-pill]") === null).toBe(true);
  });

  test("overlay outside pointerdown collapses preview without globally dismissing tooltips", async () => {
    const { LocalConversationFooter } = await import("./local-conversation-footer");
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
              errorMessage={null}
              onErrorMessage={() => {}}
              rightPanelComposerOverlay={{ enabled: true, target }}
            />
          </EnsureLocalConversationThreadScrollController>
        </TooltipProvider>,
      );

      const overlay = await waitFor(() => {
        const element = document.body.querySelector(
          '[data-testid="right-panel-composer-overlay"]',
        ) as HTMLElement | null;
        if (!element) throw new Error("Expected right-panel overlay");
        expect(element.getAttribute("aria-hidden")).toBe("false");
        return element;
      });

      const latestTurnPreview = overlay.querySelector(
        '[data-right-panel-latest-turn-preview="true"]',
      );
      const previewToggle = latestTurnPreview?.querySelector("button");
      expect(previewToggle?.getAttribute("aria-expanded")).toBe("false");

      if (!previewToggle) throw new Error("Expected latest turn toggle");
      await act(async () => {
        fireEvent.click(previewToggle);
      });
      expect(previewToggle.getAttribute("aria-expanded")).toBe("true");

      await act(async () => {
        fireEvent.pointerDown(document.body);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(previewToggle?.getAttribute("aria-expanded")).toBe("false");
      });
      expect(tooltipDismissEvents).toBe(0);
    } finally {
      window.removeEventListener("codex:dismiss-tooltips", handleTooltipDismiss);
    }
  });

  test("resuming active threads keep overlay composer ownership disabled", async () => {
    const { LocalConversationFooter } = await import("./local-conversation-footer");
    const target = document.createElement("div");
    document.body.appendChild(target);

    const { container } = render(
      <TooltipProvider>
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationFooter
            model={buildModel({ resumeState: "needs_resume" })}
            actions={buildActions()}
            errorMessage={null}
            onErrorMessage={() => {}}
            rightPanelComposerOverlay={{ enabled: true, target }}
          />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>,
    );

    expect(
      document.body.querySelector('[data-testid="right-panel-composer-overlay"]') === null,
    ).toBe(true);
    expect(
      container.querySelector('[data-local-conversation-composer-shell="true"]') === null,
    ).toBe(true);
    expect(container.querySelector('[data-thread-find-composer="true"]') !== null).toBe(true);
    expect(container.querySelector("#above-composer-portal") !== null).toBe(true);
    expect(container.querySelector("#above-composer-queue-portal") !== null).toBe(true);
  });

  test("controlled Docks retain target chrome in the overlay while a Thread resumes", async () => {
    const { LocalConversationFooter } = await import("./local-conversation-footer");
    const target = document.createElement("div");
    document.body.appendChild(target);

    render(
      <TooltipProvider>
        <EnsureLocalConversationThreadScrollController>
          <LocalConversationFooter
            model={buildModel({ resumeState: "needs_resume" })}
            actions={buildActions()}
            errorMessage={null}
            onErrorMessage={() => {}}
            rightPanelComposerOverlay={{
              enabled: true,
              target,
              visibility: {
                kind: "controlled",
                visible: true,
                attention: "activity",
                onVisibleChange: () => undefined,
              },
              leadingContent: <button type="button">Choose task</button>,
            }}
          />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>,
    );

    const overlay = await waitFor(() => {
      const element = document.body.querySelector('[data-testid="right-panel-composer-overlay"]');
      if (!element) throw new Error("Expected controlled Dock overlay");
      return element;
    });
    expect(
      within(overlay as HTMLElement).getByRole("button", {
        name: "Choose task",
      }) !== null,
    ).toBe(true);
    expect(overlay.querySelector('[data-local-conversation-composer-shell="true"]')).toBe(null);
  });
});
