import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { useState } from "react";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { AppProviders } from "@/app-providers";
import {
  __getNodexToastSnapshotForTests,
  __resetNodexToastStoreForTests,
} from "@/components/ui/toast";
import { render, settleAsyncRender } from "@/test/dom";
import { installAsyncRequestAnimationFrame, installWindowApi } from "@/test/browser-globals";
import { clearPersistedAtomStoreForTests } from "@/lib/persisted-atom-store";
import {
  clearImageEditComposerDraft,
  getImageEditComposerDraftSnapshot,
  replaceImageEditComposerDraft,
  requestImageEditComposerSubmit,
} from "@/lib/image-edit-composer-channel";
import {
  clearOptimisticGeneratedImageEdits,
  getGeneratedImageLiveCollectionSnapshot,
} from "@/features/user-attachment-image-editor";
import { buildRemoveSubmissionIntent } from "@/features/user-attachment-image-editor/model/image-edit-submission";
import {
  consumeBrowserImageAttachments,
  getBrowserImageAttachmentsSnapshot,
  publishBrowserImageAttachment,
} from "@/features/browser-sidebar/browser-image-attachments";
import { NodexModalHost } from "@/lib/modal-registry";
import type { ThreadGoal } from "@nodex/codex-app-server-protocol/v2";
import type { ThreadFooterModel, ThreadStageActions } from "../../thread-stage-types";
import {
  ThreadComposer,
  __composerAddContextTestUtils,
} from "./local-conversation-thread-composer";
import { TestComposerScopePath } from "@/test/maitai-scope-harness";

const FAST_MODE_ICON_PATH =
  "M11.9125 21.4125C11.5292 21.8625 11.0292 22.0958 10.4125 22.1125C9.79586 22.1291 9.29586 21.9208 8.91252 21.4875C8.53752 21.0541 8.45836 20.4541 8.67503 19.6875L9.68752 16H4.57502C4.00836 16 3.56669 15.8375 3.25002 15.5125C2.93336 15.1791 2.77502 14.7791 2.77502 14.3125C2.77502 13.8375 2.92919 13.4125 3.23752 13.0375L12.1375 2.47497C12.5209 2.02497 13.0209 1.79164 13.6375 1.77497C14.2542 1.75831 14.75 1.96664 15.125 2.39997C15.5084 2.83331 15.5917 3.43331 15.375 4.19997L14.3125 7.99998H19.425C19.9917 7.99998 20.4334 8.16664 20.75 8.49997C21.075 8.83331 21.2375 9.23748 21.2375 9.71247C21.2375 10.1791 21.0792 10.5958 20.7625 10.9625L11.9125 21.4125Z";
const IMAGE_EDIT_COMPOSER_CHANNEL_ID = "AppScope:app/ThreadScope:session:renderer-test::root";

const storageMap = new Map<string, string>();
const persistedAtomState = new Map<string, unknown>();
let persistedAtomRevision = 0;
type PersistedAtomListener = (...args: unknown[]) => void;
const persistedAtomListeners = new Set<PersistedAtomListener>();

const mockStorage = {
  getItem(key: string): string | null {
    return storageMap.has(key) ? (storageMap.get(key) ?? null) : null;
  },
  setItem(key: string, value: string): void {
    storageMap.set(key, value);
  },
  removeItem(key: string): void {
    storageMap.delete(key);
  },
};

if (!(globalThis as { localStorage?: unknown }).localStorage) {
  (globalThis as { localStorage: typeof mockStorage }).localStorage = mockStorage;
}

const localStorageRef = (globalThis as { localStorage: typeof mockStorage }).localStorage;

function resetStorage(): void {
  storageMap.clear();
  persistedAtomState.clear();
  persistedAtomRevision = 0;
  persistedAtomListeners.clear();
  clearPersistedAtomStoreForTests();
  localStorageRef.removeItem("nodex-codex-default-service-tier-v1");
}

type TestInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

function installComposerWindowApi(testInvoke?: TestInvoke): void {
  installWindowApi({
    invoke: async (channel: string, ...args: unknown[]) => {
      if (testInvoke) {
        const result = await testInvoke(channel, ...args);
        if (result !== undefined) return result;
      }
      switch (channel) {
        case "persisted-atom:sync-request":
          return {
            revision: persistedAtomRevision,
            values: Object.fromEntries(persistedAtomState.entries()),
          };
        case "persisted-atom:update": {
          const update = args[0] as { key?: unknown; value?: unknown; mutationId?: unknown };
          if (typeof update.key === "string" && typeof update.mutationId === "string") {
            persistedAtomRevision += 1;
            persistedAtomState.set(update.key, update.value);
            const event = {
              key: update.key,
              value: update.value,
              mutationId: update.mutationId,
              revision: persistedAtomRevision,
              originRendererId: "test-renderer",
            };
            for (const listener of persistedAtomListeners) {
              listener(event);
            }
            return event;
          }
          return null;
        }
        case "codex:permission:state:get":
          return {
            mode: "auto",
            effectivePreset: "auto",
            availableModes: ["auto", "guardian-approvals", "full-access", "custom"],
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandboxMode: "workspace-write",
            sandbox: {
              type: "workspaceWrite",
              writableRoots: ["/tmp/project"],
              readOnlyAccess: { type: "fullAccess" },
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
            autoReviewAvailable: true,
            configTarget: {
              source: "user",
              filePath: "/tmp/project/.codex/config.toml",
            },
          };
        case "branch-metadata":
          return {
            currentBranch: "main",
            defaultBranch: "main",
            branches: ["main"],
          };
        case "subscribe-live-query":
        case "unsubscribe-live-query":
          return true;
        case "codex:thread:goal:materialize-draft": {
          const draft = args[0] as { objective?: string };
          return {
            objective: draft.objective?.trim() ?? "",
            attachmentDirectory: null,
          };
        }
        case "codex:thread:goal:materialized-cleanup":
          return undefined;
        case "codex:thread:goal:editable-objective:read":
          return args[0];
        case "codex:composer-appshot:target":
          return { available: false, target: null };
        default:
          return null;
      }
    },
    on: (channel: string, listener: PersistedAtomListener) => {
      if (channel !== "persisted-atom:updated") return () => {};
      persistedAtomListeners.add(listener);
      return () => {
        persistedAtomListeners.delete(listener);
      };
    },
    resolveManagedAssetPath: (source: string) =>
      source.startsWith("nodex://assets/")
        ? `/managed/${source.slice("nodex://assets/".length)}`
        : null,
    getPathForFile: () => "",
  });
}

function buildModel(overrides?: Partial<ThreadFooterModel>): ThreadFooterModel {
  return {
    projectId: "project_1",
    hostId: "default",
    projectWorkspacePath: "/tmp/project",
    threadId: "thread_1",
    cwd: "/tmp/project",
    account: {
      account: {
        type: "chatgpt",
        email: "asc@example.com",
        planType: "Pro",
      },
      requiresOpenAiAuth: false,
      pendingLogin: null,
      rateLimits: null,
    },
    conversation: {
      threadId: "thread_1",
      projectId: "project_1",
      source: null,
      threadName: "Thread",
      threadPreview: "Preview",
      modelProvider: "openai",
      cwd: "/tmp/project",
      statusType: "idle",
      statusActiveFlags: [],
      archived: false,
      createdAt: 1,
      updatedAt: 2,
      linkedAt: "2026-04-06T00:00:00.000Z",
      resumeState: "resumed",
      turns: [],
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
    collaborationModes: [
      { mode: "default", name: "Default", model: null },
      { mode: "plan", name: "Plan", model: null },
    ],
    selectedCollaborationMode: "default",
    availableModels: [
      {
        id: "gpt-5.3-codex",
        model: "gpt-5.3-codex",
        displayName: "GPT-5.3 Codex",
        description: "Balanced Codex model.",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "high",
        inputModalities: ["text", "image"],
        multiAgentVersion: null,
        serviceTiers: [],
        defaultServiceTier: null,
        supportedReasoningEfforts: [
          { reasoningEffort: "high", description: "Spend more time reasoning before answering." },
          { reasoningEffort: "medium", description: "Balance speed and deeper reasoning." },
        ],
      },
      {
        id: "gpt-5.5",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "Latest Codex model.",
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: "high",
        inputModalities: ["text", "image"],
        multiAgentVersion: null,
        serviceTiers: [],
        defaultServiceTier: null,
        supportedReasoningEfforts: [
          { reasoningEffort: "high", description: "Spend more time reasoning before answering." },
        ],
      },
    ],
    selectedModel: "gpt-5.3-codex",
    modelPickerShortcut: {
      label: "Ctrl+Shift+M",
      ariaKeyShortcuts: "Control+Shift+M",
    },
    selectedReasoningEffort: "high",
    reasoningEffortOptions: [
      { reasoningEffort: "high", description: "Spend more time reasoning before answering." },
      { reasoningEffort: "medium", description: "Balance speed and deeper reasoning." },
    ],
    permissionMode: "auto",
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    composerIntent: null,
    dictation: {
      isEnabled: false,
      authMethod: "chatgpt",
      shortcutLabel: "Ctrl+M",
      capabilities: {
        composer: false,
        global: false,
        history: true,
        streaming: "unavailable",
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
    onReplaceQueuedFollowUp: async () => true,
    onReorderQueuedFollowUps: async () => {},
    onSendQueuedFollowUpNow: async () => {},
    onEditQueuedFollowUp: async () => {},
    onEditLastUserTurn: async () => {},
    onForkFromTurn: async () => {},
    onCompactThread: async () => {},
    onGetThreadGoal: async () => null,
    onSetThreadGoal: async () => null,
    onClearThreadGoal: async () => {},
    onSetThreadMemoryMode: async () => {},
    onUploadFeedback: async () => {},
    onUnarchiveThread: async () => {},
    onOpenTurnDiffReview: () => {},
    onConsumeComposerIntent: () => {},
    onOpenThread: () => {},
    onCleanBackgroundTerminals: async () => {},
    ...overrides,
  };
}

async function settleComposerFrame(): Promise<void> {
  await settleAsyncRender();
  await settleAsyncRender();
}

async function renderComposer(
  overrides?: Partial<ThreadFooterModel>,
  actionOverrides?: Partial<ThreadStageActions>,
  testInvoke?: TestInvoke,
  onErrorMessage: (message: string | null) => void = () => {},
) {
  installAsyncRequestAnimationFrame();
  document.documentElement.dataset.codexWindowType = "electron";
  installComposerWindowApi(testInvoke);

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <AppProviders>
        <TestComposerScopePath>
          <ThreadComposer
            model={buildModel(overrides)}
            actions={buildActions(actionOverrides)}
            errorMessage={null}
            onErrorMessage={onErrorMessage}
          />
          <NodexModalHost />
        </TestComposerScopePath>
      </AppProviders>,
    );
  });
  await settleComposerFrame();

  return view;
}

async function renderControlledThreadIntelligenceComposer() {
  installAsyncRequestAnimationFrame();
  document.documentElement.dataset.codexWindowType = "electron";
  installComposerWindowApi();

  function ControlledComposer() {
    const [executionProfile, setExecutionProfile] = useState<
      NonNullable<ThreadFooterModel["executionProfile"]>
    >({
      modelId: "gpt-5.5",
      reasoningEffort: "high",
      serviceTier: null,
    });
    return (
      <ThreadComposer
        model={buildModel({
          executionProfile,
          executionIdentityLocked: true,
          selectedModel: executionProfile.modelId,
          selectedReasoningEffort: executionProfile.reasoningEffort ?? "high",
        })}
        actions={buildActions({
          onIntelligenceSelectionChange: async (selection) => {
            setExecutionProfile({
              modelId: selection.model,
              reasoningEffort: selection.reasoningEffort,
              serviceTier: selection.serviceTier,
            });
          },
        })}
        errorMessage={null}
        onErrorMessage={() => {}}
      />
    );
  }

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <AppProviders>
        <TestComposerScopePath>
          <ControlledComposer />
        </TestComposerScopePath>
      </AppProviders>,
    );
  });
  await settleComposerFrame();
  return view;
}

async function renderNewThreadComposerThatAttachesBeforeStartCompletes() {
  installAsyncRequestAnimationFrame();
  document.documentElement.dataset.codexWindowType = "electron";
  installComposerWindowApi();

  let completeStart!: () => void;
  const startCompletion = new Promise<void>((resolve) => {
    completeStart = resolve;
  });

  function TransitioningComposer() {
    const [attached, setAttached] = useState(false);

    return (
      <ThreadComposer
        model={
          attached
            ? buildModel({
                composerIntent: null,
              })
            : buildModel({
                threadId: null,
                conversation: null,
                isNewThreadTab: true,
                newThreadTarget: {
                  projectId: "project_1",
                  projectName: "Nodex",
                  sessionId: "session_1",
                  threadTitle: "New thread",
                  runInTarget: "localProject",
                },
                composerIntent: {
                  prompt: "Start an atomic thread",
                  focusNonce: 1,
                },
              })
        }
        actions={buildActions({
          onStartThreadForSession: async () => {
            setAttached(true);
            await startCompletion;
          },
        })}
        errorMessage={null}
        onErrorMessage={() => {}}
      />
    );
  }

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <AppProviders>
        <TestComposerScopePath>
          <TransitioningComposer />
        </TestComposerScopePath>
      </AppProviders>,
    );
  });
  await settleComposerFrame();
  return { view, completeStart };
}

async function submitCurrentComposerDraft(view: ReturnType<typeof render>): Promise<void> {
  const sendButton = within(view.container).getByLabelText("Send prompt");
  await waitFor(() => {
    expect((sendButton as HTMLButtonElement).disabled).toBe(false);
  });
  await act(async () => {
    fireEvent.click(sendButton);
    await Promise.resolve();
  });
}

function readComposerText(view: ReturnType<typeof render>): string {
  const composer = view.container.querySelector<HTMLElement>('[data-codex-composer="true"]');
  if (!composer) return "";
  return Array.from(composer.children)
    .map((child) => child.textContent ?? "")
    .join("\n");
}

function buildActiveTurn(): NonNullable<ThreadFooterModel["activeTurn"]> {
  return {
    threadId: "thread_1",
    turnId: "turn_active",
    status: "inProgress",
    itemIds: [],
    items: [],
  };
}

function buildThreadGoal(overrides?: Partial<ThreadGoal>): ThreadGoal {
  return {
    threadId: "thread_1",
    objective: "Keep the existing goal",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildRunningComposerModel(
  overrides?: Partial<ThreadFooterModel>,
): Partial<ThreadFooterModel> {
  return {
    isThreadRunning: true,
    activeTurn: buildActiveTurn(),
    composerIntent: {
      prompt: "Follow up",
      focusNonce: 1,
    },
    body: {
      ...buildModel().body,
      isThreadRunning: true,
      activeTurnId: "turn_active",
    },
    ...overrides,
  };
}

async function keyDownComposer(
  view: ReturnType<typeof render>,
  init: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  },
  options?: { waitForContent?: boolean },
): Promise<boolean> {
  const composer = view.container.querySelector<HTMLElement>('[data-codex-composer="true"]');
  if (!(composer instanceof HTMLElement)) {
    throw new Error("Expected composer editor.");
  }

  if (options?.waitForContent !== false) {
    await waitFor(() => {
      expect(Boolean(composer.textContent ?? "")).toBe(true);
    });
  }
  composer.focus();
  let wasNotCanceled = true;
  await act(async () => {
    wasNotCanceled = fireEvent.keyDown(composer, init);
    await Promise.resolve();
  });
  return wasNotCanceled;
}

describe("ThreadComposer speed menu", () => {
  beforeEach(() => {
    __resetNodexToastStoreForTests();
  });

  test("turns a one-megabyte paste into a pending owned attachment without growing ProseMirror", async () => {
    resetStorage();
    const source = "x".repeat(1_000_000);
    type CreateResult = {
      file: { label: string; path: string; fsPath: string };
      preview: string;
      characterCount: number;
    };
    let resolveCreateRequest: (result: CreateResult) => void = () => undefined;
    const createRequest = new Promise<CreateResult>((resolve) => {
      resolveCreateRequest = resolve;
    });
    let capturedTextLength = 0;
    const view = await renderComposer(undefined, undefined, async (channel, ...args) => {
      if (channel === "codex:pasted-text:create") {
        capturedTextLength = (args[0] as { text: string }).text.length;
        return await createRequest;
      }
      if (channel === "codex:pasted-text:remove") return undefined;
      return undefined;
    });
    const composer = view.container.querySelector<HTMLElement>('[data-codex-composer="true"]');
    if (!composer) throw new Error("Expected composer editor");

    await act(async () => {
      fireEvent.paste(composer, {
        clipboardData: {
          files: [],
          items: [],
          getData: (format: string) => (format === "text/plain" ? source : ""),
        },
      });
      await Promise.resolve();
    });

    expect(capturedTextLength).toBe(source.length);
    expect(readComposerText(view)).toBe("");
    expect(view.getByText("Adding pasted text…")).toBeDefined();
    expect((view.getByLabelText("Send prompt") as HTMLButtonElement).disabled).toBe(true);

    resolveCreateRequest({
      file: {
        label: "Pasted text.txt",
        path: "/attachments/large/pasted-text.txt",
        fsPath: "/attachments/large/pasted-text.txt",
      },
      preview: "xxxxxxxx",
      characterCount: source.length,
    });
    await waitFor(() => {
      expect(view.getByText("Pasted text.txt")).toBeDefined();
    });
  });

  test("pastes an image into the Codex thumbnail shell and submits its local materialization", async () => {
    resetStorage();
    const sentPromptInputs: unknown[] = [];
    const savedImages: unknown[] = [];
    const view = await renderComposer(
      undefined,
      {
        onSendPrompt: async (_prompt, options) => {
          sentPromptInputs.push(options?.promptInput ?? null);
        },
      },
      async (channel, ...args) => {
        if (channel === "asset:image:save") {
          savedImages.push(args[0]);
          return { source: "nodex://assets/pasted.png" };
        }
        return undefined;
      },
    );
    const composer = view.container.querySelector<HTMLElement>('[data-codex-composer="true"]');
    if (!composer) throw new Error("Expected composer editor");
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    Object.defineProperty(image, "arrayBuffer", {
      configurable: true,
      value: async () => new TextEncoder().encode("image").buffer,
    });

    await act(async () => {
      fireEvent.paste(composer, {
        clipboardData: {
          files: [image],
          items: [
            {
              kind: "file",
              type: image.type,
              getAsFile: () => image,
            },
          ],
          getData: (format: string) => (format === "text/plain" ? image.name : ""),
        },
      });
      await Promise.resolve();
    });

    const thumbnail = await view.findByRole("button", { name: "diagram.png" });
    expect(thumbnail.getAttribute("data-composer-image-attachment-size")).toBe("80");
    expect(thumbnail.querySelector("img")?.getAttribute("src")).toMatch(
      /^data:image\/png;base64,/u,
    );
    await waitFor(() => expect(savedImages).toHaveLength(1));

    await submitCurrentComposerDraft(view);

    expect(sentPromptInputs).toEqual([
      {
        text: "",
        images: [{ source: "/managed/pasted.png", caption: "diagram.png" }],
      },
    ]);
  });

  test("submits Remove area through a projectless New Chat's normal start path", async () => {
    resetStorage();
    const starts: Parameters<NonNullable<ThreadStageActions["onStartThreadForSession"]>>[0][] = [];
    const view = await renderComposer(
      {
        projectId: null,
        threadId: null,
        conversation: null,
        isNewThreadTab: true,
        newThreadTarget: {
          projectId: null,
          projectName: "No project",
          sessionId: "session_1",
          threadTitle: "New thread",
          runInTarget: "localProject",
        },
      },
      {
        onStartThreadForSession: async (input) => {
          starts.push(input);
        },
      },
    );
    const original = {
      id: "original",
      alt: "Original image",
      attachmentSrc: "data:image/png;base64,b3JpZ2luYWw=",
      dataUrl: "data:image/png;base64,b3JpZ2luYWw=",
      source: "uploaded" as const,
      src: "data:image/png;base64,b3JpZ2luYWw=",
    };
    const mask = {
      id: "mask",
      alt: "Removal mask",
      attachmentSrc: "data:image/png;base64,bWFzaw==",
      dataUrl: "data:image/png;base64,bWFzaw==",
      source: "uploaded" as const,
      src: "data:image/png;base64,bWFzaw==",
    };
    let result: Awaited<ReturnType<typeof requestImageEditComposerSubmit>> | null = null;

    await act(async () => {
      result = await requestImageEditComposerSubmit(IMAGE_EDIT_COMPOSER_CHANNEL_ID, {
        intent: buildRemoveSubmissionIntent({
          entrypoint: "image_click",
          image: original,
          mask,
        }),
        source: "single",
      });
    });

    expect(result).toEqual({ status: "submitted" });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      projectId: null,
      sessionId: "session_1",
      prompt: "Remove the area marked in the second image from the first image",
      promptInput: {
        text: "Remove the area marked in the second image from the first image",
        images: [
          {
            source: original.dataUrl,
            caption: "Original image",
          },
          {
            source: mask.dataUrl,
            caption: "image-mask.png",
          },
        ],
      },
      runInTarget: "localProject",
    });
    view.unmount();
  });

  test("reuses a Send to chat managed image when New Chat submits Remove area", async () => {
    resetStorage();
    const sessionId = "session_managed_image_edit";
    const attachmentId = "browser-managed-original";
    const managedSource = "nodex://assets/browser-managed-original.png";
    publishBrowserImageAttachment(sessionId, {
      id: attachmentId,
      filename: "browser-managed-original.png",
      source: managedSource,
    });
    const starts: Parameters<NonNullable<ThreadStageActions["onStartThreadForSession"]>>[0][] = [];
    const errors: string[] = [];
    const view = await renderComposer(
      {
        projectId: null,
        threadId: null,
        conversation: null,
        isNewThreadTab: true,
        newThreadTarget: {
          projectId: null,
          projectName: "No project",
          sessionId,
          threadTitle: "New thread",
          runInTarget: "localProject",
        },
      },
      {
        onStartThreadForSession: async (input) => {
          starts.push(input);
        },
      },
      undefined,
      (message) => {
        if (message) errors.push(message);
      },
    );
    try {
      await waitFor(() => {
        expect(view.getByRole("button", { name: "browser-managed-original.png" })).toBeDefined();
      });
      const editorDescriptor = {
        id: attachmentId,
        attachmentId,
        alt: "User attachment",
        attachmentSrc: managedSource,
        dataUrl: managedSource,
        downloadSrc: managedSource,
        managedSource,
        source: "uploaded" as const,
        src: managedSource,
      };
      const mask = {
        id: "mask",
        alt: "Removal mask",
        attachmentSrc: "data:image/png;base64,bWFzaw==",
        dataUrl: "data:image/png;base64,bWFzaw==",
        source: "uploaded" as const,
        src: "data:image/png;base64,bWFzaw==",
      };

      let result: Awaited<ReturnType<typeof requestImageEditComposerSubmit>> | null = null;
      await act(async () => {
        result = await requestImageEditComposerSubmit(IMAGE_EDIT_COMPOSER_CHANNEL_ID, {
          intent: buildRemoveSubmissionIntent({
            entrypoint: "image_click",
            image: editorDescriptor,
            mask,
          }),
          source: "single",
        });
      });

      expect(result).toEqual({ status: "submitted" });
      expect(errors).toEqual([]);
      expect(starts).toHaveLength(1);
      expect(starts[0]?.promptInput?.images).toEqual([
        {
          source: managedSource,
          caption: "browser-managed-original.png",
        },
        {
          source: mask.dataUrl,
          caption: "image-mask.png",
        },
      ]);
    } finally {
      view.unmount();
      consumeBrowserImageAttachments(
        sessionId,
        getBrowserImageAttachmentsSnapshot(sessionId).map((attachment) => attachment.id),
      );
    }
  });

  test("reuses a managed image when a projectless task submits Remove area", async () => {
    resetStorage();
    const threadId = "thread_1";
    const attachmentId = "projectless-managed-original";
    const managedSource = "nodex://assets/projectless-managed-original.png";
    publishBrowserImageAttachment(threadId, {
      id: attachmentId,
      filename: "projectless-managed-original.png",
      source: managedSource,
    });
    const sentPromptInputs: unknown[] = [];
    const errors: string[] = [];
    const baseConversation = buildModel().conversation;
    if (!baseConversation) throw new Error("Expected a conversation fixture");
    const view = await renderComposer(
      {
        projectId: null,
        projectWorkspacePath: null,
        conversation: { ...baseConversation, projectId: null },
      },
      {
        onSendPrompt: async (_prompt, options) => {
          sentPromptInputs.push(options?.promptInput ?? null);
        },
      },
      undefined,
      (message) => {
        if (message) errors.push(message);
      },
    );

    try {
      await waitFor(() => {
        expect(
          view.getByRole("button", { name: "projectless-managed-original.png" }),
        ).toBeDefined();
      });
      let result: Awaited<ReturnType<typeof requestImageEditComposerSubmit>> | null = null;
      await act(async () => {
        result = await requestImageEditComposerSubmit(IMAGE_EDIT_COMPOSER_CHANNEL_ID, {
          intent: buildRemoveSubmissionIntent({
            entrypoint: "image_click",
            image: {
              id: attachmentId,
              attachmentId,
              alt: "User attachment",
              attachmentSrc: managedSource,
              dataUrl: managedSource,
              managedSource,
              source: "uploaded",
              src: managedSource,
            },
            mask: {
              id: "projectless-mask",
              alt: "Removal mask",
              attachmentSrc: "data:image/png;base64,bWFzaw==",
              dataUrl: "data:image/png;base64,bWFzaw==",
              source: "uploaded",
              src: "data:image/png;base64,bWFzaw==",
            },
          }),
          source: "single",
        });
      });

      expect(result).toEqual({ status: "submitted" });
      expect(errors).toEqual([]);
      expect(sentPromptInputs).toMatchObject([
        {
          text: "Remove the area marked in the second image from the first image",
          images: [
            { source: managedSource, caption: "projectless-managed-original.png" },
            { source: "data:image/png;base64,bWFzaw==", caption: "image-mask.png" },
          ],
        },
      ]);
    } finally {
      view.unmount();
      consumeBrowserImageAttachments(
        threadId,
        getBrowserImageAttachmentsSnapshot(threadId).map((attachment) => attachment.id),
      );
    }
  });

  test("queues an image edit when the existing task is active", async () => {
    resetStorage();
    const queued: Array<{ threadId: string; prompt: string; promptInput: unknown }> = [];
    const view = await renderComposer(buildRunningComposerModel({ composerIntent: null }), {
      onEnqueueQueuedFollowUp: async (threadId, prompt, options) => {
        queued.push({ threadId, prompt, promptInput: options?.promptInput });
      },
    });
    const image = {
      id: "selected",
      alt: "Selected image",
      attachmentSrc: "data:image/png;base64,c2VsZWN0ZWQ=",
      dataUrl: "data:image/png;base64,c2VsZWN0ZWQ=",
      source: "generated" as const,
      src: "data:image/png;base64,c2VsZWN0ZWQ=",
    };

    let result: Awaited<ReturnType<typeof requestImageEditComposerSubmit>> | undefined;
    await act(async () => {
      result = await requestImageEditComposerSubmit(IMAGE_EDIT_COMPOSER_CHANNEL_ID, {
        intent: {
          analytics: { hasGeneralInstruction: true, selectedImageCount: 1 },
          attachmentIds: [image.id],
          attachments: [{ attachmentId: image.id, image, role: "selected" }],
          entrypoint: "canvas_button",
          focusComposerAfterSubmit: true,
          isImageEditFollowUp: true,
          mode: "select",
          promptRaw: "Make the sky warmer",
          queuePolicy: "queue-while-active",
        },
        source: "canvas",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result).toEqual({ status: "queued" });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      threadId: "thread_1",
      prompt: "Make the sky warmer",
      promptInput: {
        text: "Make the sky warmer",
        images: [{ source: image.dataUrl, caption: "Selected image" }],
      },
    });
    view.unmount();
  });

  test("uses the portable image source when the thread runs on another host", async () => {
    resetStorage();
    const sentPromptInputs: unknown[] = [];
    const view = await renderComposer(
      { hostId: "ssh:remote" },
      {
        onSendPrompt: async (_prompt, options) => {
          sentPromptInputs.push(options?.promptInput ?? null);
        },
      },
      async (channel) => {
        if (channel === "asset:image:save") {
          return { source: "nodex://assets/remote-thread.png" };
        }
        return undefined;
      },
    );
    const composer = view.container.querySelector<HTMLElement>('[data-codex-composer="true"]');
    if (!composer) throw new Error("Expected composer editor");
    const image = new File(["image"], "remote-thread.png", { type: "image/png" });
    Object.defineProperty(image, "arrayBuffer", {
      configurable: true,
      value: async () => new TextEncoder().encode("image").buffer,
    });

    await act(async () => {
      fireEvent.paste(composer, {
        clipboardData: {
          files: [image],
          items: [
            {
              kind: "file",
              type: image.type,
              getAsFile: () => image,
            },
          ],
          getData: (format: string) => (format === "text/plain" ? image.name : ""),
        },
      });
      await Promise.resolve();
    });
    expect(await view.findByRole("button", { name: "remote-thread.png" })).toBeDefined();

    await submitCurrentComposerDraft(view);

    expect(sentPromptInputs).toEqual([
      {
        text: "",
        images: [
          {
            source: expect.stringMatching(/^data:image\/png;base64,/u),
            caption: "remote-thread.png",
          },
        ],
      },
    ]);
  });

  test("routes an operating-system image drop through the same thumbnail shell", async () => {
    resetStorage();
    const savedImages: unknown[] = [];
    const view = await renderComposer(undefined, undefined, async (channel, ...args) => {
      if (channel === "asset:image:save") {
        savedImages.push(args[0]);
        return { source: "nodex://assets/dropped.png" };
      }
      return undefined;
    });
    const dropTarget = view.container.querySelector<HTMLElement>('[data-file-drop-active="false"]');
    if (!dropTarget) throw new Error("Expected Composer file drop target");
    const image = new File(["image"], "dropped.png", { type: "image/png" });
    Object.defineProperty(image, "arrayBuffer", {
      configurable: true,
      value: async () => new TextEncoder().encode("image").buffer,
    });
    const dataTransfer = {
      files: [image],
      items: [
        {
          kind: "file",
          type: image.type,
          getAsFile: () => image,
        },
      ],
      types: ["Files"],
      getData: () => "",
      dropEffect: "none",
    };

    await act(async () => {
      fireEvent.dragEnter(dropTarget, { dataTransfer });
      fireEvent.drop(dropTarget, { dataTransfer });
      await Promise.resolve();
    });

    const thumbnail = await view.findByRole("button", { name: "dropped.png" });
    expect(thumbnail.getAttribute("data-composer-image-attachment-size")).toBe("80");
    await waitFor(() => expect(savedImages).toHaveLength(1));
    expect(dataTransfer.dropEffect).toBe("copy");
  });

  test("queues the readable image snapshot while materialization is pending", async () => {
    resetStorage();
    let resolveImageSave!: (value: { source: string }) => void;
    const imageSave = new Promise<{ source: string }>((resolve) => {
      resolveImageSave = resolve;
    });
    const queued: unknown[] = [];
    const view = await renderComposer(
      buildRunningComposerModel({ isQueueingEnabled: true }),
      {
        onEnqueueQueuedFollowUp: async (_threadId, _prompt, options) => {
          queued.push(options?.promptInput ?? null);
        },
      },
      async (channel) => {
        if (channel === "asset:image:save") return await imageSave;
        return undefined;
      },
    );
    const composer = view.container.querySelector<HTMLElement>('[data-codex-composer="true"]');
    if (!composer) throw new Error("Expected composer editor");
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    Object.defineProperty(image, "arrayBuffer", {
      configurable: true,
      value: async () => new TextEncoder().encode("image").buffer,
    });

    await act(async () => {
      fireEvent.paste(composer, {
        clipboardData: {
          files: [image],
          items: [
            {
              kind: "file",
              type: image.type,
              getAsFile: () => image,
            },
          ],
          getData: (format: string) => (format === "text/plain" ? image.name : ""),
        },
      });
      await Promise.resolve();
    });
    expect(await view.findByRole("button", { name: "diagram.png" })).toBeDefined();

    await keyDownComposer(view, { key: "Enter" });
    await settleAsyncRender();
    await waitFor(() => expect(queued).toHaveLength(1));
    expect(queued).toEqual([
      {
        text: "Follow up",
        documentItems: [{ type: "text", text: "Follow up" }],
        images: [
          {
            source: expect.stringMatching(/^data:image\/png;base64,/u),
            caption: "diagram.png",
          },
        ],
      },
    ]);
    await waitFor(() => {
      expect(view.queryByRole("button", { name: "diagram.png" })).toBeNull();
    });

    await act(async () => {
      resolveImageSave({ source: "nodex://assets/late.png" });
      await Promise.resolve();
    });
    expect(view.queryByRole("button", { name: "diagram.png" })).toBeNull();
  });

  test("keeps existing images but blocks send after switching to a text-only model", async () => {
    resetStorage();
    const sent: unknown[] = [];
    const errors: string[] = [];
    const view = await renderComposer(
      {
        availableModels: [
          {
            id: "text-only",
            model: "text-only",
            displayName: "Text only",
            description: "Text-only test model.",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "high",
            inputModalities: ["text"],
            multiAgentVersion: null,
            serviceTiers: [],
            defaultServiceTier: null,
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "Deep reasoning." },
            ],
          },
        ],
        selectedModel: "text-only",
        executionProfile: {
          modelId: "text-only",
          reasoningEffort: "high",
          serviceTier: null,
        },
        composerIntent: {
          prompt: "Describe this image",
          focusNonce: 1,
          promptInput: {
            text: "Describe this image",
            images: [
              {
                source: "data:image/png;base64,aW1hZ2U=",
                caption: "diagram.png",
              },
            ],
          },
        },
      },
      {
        onSendPrompt: async (_prompt, options) => {
          sent.push(options?.promptInput ?? null);
        },
      },
      undefined,
      (message) => {
        if (message) errors.push(message);
      },
    );

    expect(await view.findByRole("button", { name: "diagram.png" })).toBeDefined();
    await submitCurrentComposerDraft(view);

    expect(sent).toEqual([]);
    expect(errors).toContain("Remove images or switch models to send this message");
    expect(view.getByRole("button", { name: "diagram.png" })).toBeDefined();
  });

  test("blocks a restored local-only image when its execution host changes", async () => {
    resetStorage();
    const sent: unknown[] = [];
    const errors: string[] = [];
    const view = await renderComposer(
      {
        hostId: "ssh:remote",
        composerIntent: {
          prompt: "Describe this image",
          focusNonce: 1,
          promptInput: {
            text: "Describe this image",
            images: [
              {
                source: "/managed/local-only.png",
                caption: "local-only.png",
              },
            ],
          },
        },
      },
      {
        onSendPrompt: async (_prompt, options) => {
          sent.push(options?.promptInput ?? null);
        },
      },
      undefined,
      (message) => {
        if (message) errors.push(message);
      },
    );

    const thumbnail = await view.findByRole("button", { name: "local-only.png" });
    expect(thumbnail.querySelector("img")?.getAttribute("src")).toBe(
      "app://fs/@fs/managed/local-only.png",
    );
    await submitCurrentComposerDraft(view);

    expect(sent).toEqual([]);
    expect(errors).toContain(
      "One or more images are unavailable on the selected execution host. Remove them or add them again.",
    );
  });

  test("restores the exact owned paste in one editor replacement and cleans its source", async () => {
    resetStorage();
    const source = `  leading\n${"x".repeat(5_000)}\ntrailing  `;
    const file = {
      label: "Pasted text.txt",
      path: "/attachments/exact/pasted-text.txt",
      fsPath: "/attachments/exact/pasted-text.txt",
    };
    const removedPaths: string[] = [];
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = await renderComposer(undefined, undefined, async (channel, ...args) => {
      if (channel === "codex:pasted-text:create") {
        return { file, preview: "leading x", characterCount: source.length };
      }
      if (channel === "codex:pasted-text:read") return source;
      if (channel === "codex:pasted-text:remove") {
        removedPaths.push((args[0] as { file: { path: string } }).file.path);
      }
      return undefined;
    });
    const composer = view.container.querySelector<HTMLElement>('[data-codex-composer="true"]');
    if (!composer) throw new Error("Expected composer editor");

    try {
      await act(async () => {
        fireEvent.paste(composer, {
          clipboardData: {
            files: [],
            items: [],
            getData: (format: string) => (format === "text/plain" ? source : ""),
          },
        });
        await Promise.resolve();
      });
      const showInField = await view.findByRole("button", { name: "Show in text field" });

      await act(async () => {
        fireEvent.click(showInField);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(readComposerText(view)).toBe(source);
        expect(removedPaths).toEqual([file.path]);
      });
      expect(confirm).toHaveBeenCalledOnce();
      expect(view.queryByText("Pasted text.txt")).toBe(null);
    } finally {
      confirm.mockRestore();
    }
  });

  test("cmd-enter queues instead of steering while running in enter mode with queueing disabled", async () => {
    resetStorage();
    const queuedPrompts: string[] = [];
    const steeredPrompts: string[] = [];
    const view = await renderComposer(
      buildRunningComposerModel({
        isQueueingEnabled: false,
        composerEnterBehavior: "enter",
      }),
      {
        onEnqueueQueuedFollowUp: async (_threadId, prompt) => {
          queuedPrompts.push(prompt);
        },
        onSteerPrompt: async (input) => {
          steeredPrompts.push(input.prompt);
        },
      },
    );

    await keyDownComposer(view, { key: "Enter", metaKey: true });

    await waitFor(() => {
      expect(queuedPrompts.length).toBe(1);
    });
    expect(queuedPrompts[0]).toBe("Follow up");
    expect(steeredPrompts.length).toBe(0);
    await waitFor(() => expect(readComposerText(view)).toBe(""));
  });

  test("Enter clears a New Chat draft as soon as its submission is admitted", async () => {
    resetStorage();
    const { view, completeStart } = await renderNewThreadComposerThatAttachesBeforeStartCompletes();

    await waitFor(() => expect(readComposerText(view)).toBe("Start an atomic thread"));
    await keyDownComposer(view, { key: "Enter" });

    await waitFor(() => {
      expect(
        view.container.querySelector(
          '[data-codex-composer="true"][aria-label="Ask for follow-up changes"]',
        ),
      ).not.toBeNull();
    });
    await waitFor(() => expect(readComposerText(view)).toBe(""));

    await act(async () => {
      completeStart();
      await Promise.resolve();
    });
  });

  test("restores a failed New Chat submission for an explicit retry", async () => {
    resetStorage();
    let rejectStart!: (error: Error) => void;
    const firstStart = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    let startCount = 0;
    const errors: string[] = [];
    const view = await renderComposer(
      {
        threadId: null,
        conversation: null,
        isNewThreadTab: true,
        newThreadTarget: {
          projectId: "project_1",
          projectName: "Nodex",
          sessionId: "session_1",
          threadTitle: "New thread",
          runInTarget: "localProject",
        },
        composerIntent: {
          prompt: "Retry the retained first submission",
          focusNonce: 1,
        },
      },
      {
        onStartThreadForSession: async () => {
          startCount += 1;
          if (startCount === 1) await firstStart;
        },
      },
      undefined,
      (message) => {
        if (message) errors.push(message);
      },
    );

    await waitFor(() => expect(readComposerText(view)).toBe("Retry the retained first submission"));
    await keyDownComposer(view, { key: "Enter" });
    await waitFor(() => expect(readComposerText(view)).toBe(""));

    await act(async () => {
      rejectStart(new Error("Thread start failed"));
      await firstStart.catch(() => undefined);
      await Promise.resolve();
    });
    await waitFor(() => expect(readComposerText(view)).toBe("Retry the retained first submission"));
    expect(errors).toContain("Thread start failed");

    await submitCurrentComposerDraft(view);
    await waitFor(() => expect(startCount).toBe(2));
    await waitFor(() => expect(readComposerText(view)).toBe(""));
  });

  test("edits a queued follow-up in place at its captured ledger revision", async () => {
    resetStorage();
    const replacements: Array<{
      threadId: string;
      followUpId: string;
      expectedLedgerRevision: number;
      prompt: string;
    }> = [];
    const removed: string[] = [];
    const view = await renderComposer(
      buildRunningComposerModel({
        isQueueingEnabled: true,
        composerIntent: {
          prompt: "Edited follow-up",
          queuedFollowUpEdit: { followUpId: "follow-up-edit", ledgerRevision: 7 },
          focusNonce: 2,
        },
      }),
      {
        onReplaceQueuedFollowUp: async (threadId, followUpId, expectedLedgerRevision, prompt) => {
          replacements.push({ threadId, followUpId, expectedLedgerRevision, prompt });
          return true;
        },
        onRemoveQueuedFollowUp: async (_threadId, followUpId) => {
          removed.push(followUpId);
        },
      },
    );

    await keyDownComposer(view, { key: "Enter" });

    await waitFor(() => expect(replacements).toHaveLength(1));
    expect(replacements[0]).toEqual({
      threadId: "thread_1",
      followUpId: "follow-up-edit",
      expectedLedgerRevision: 7,
      prompt: "Edited follow-up",
    });
    expect(removed).toEqual([]);
    await waitFor(() => expect(readComposerText(view)).toBe(""));
  });

  test("keeps the original queued row and draft when an edit loses its revision race", async () => {
    resetStorage();
    const removed: string[] = [];
    const errors: Array<string | null> = [];
    const view = await renderComposer(
      buildRunningComposerModel({
        isQueueingEnabled: true,
        composerIntent: {
          prompt: "Stale queued edit",
          queuedFollowUpEdit: { followUpId: "follow-up-stale", ledgerRevision: 3 },
          focusNonce: 3,
        },
      }),
      {
        onReplaceQueuedFollowUp: async () => false,
        onRemoveQueuedFollowUp: async (_threadId, followUpId) => {
          removed.push(followUpId);
        },
      },
      undefined,
      (message) => errors.push(message),
    );

    await keyDownComposer(view, { key: "Enter" });

    await waitFor(() =>
      expect(errors.at(-1)).toBe("The queued message changed before it could be edited"),
    );
    expect(removed).toEqual([]);
    expect(readComposerText(view)).toBe("Stale queued edit");
  });

  test("removes an edited queued row only after its replacement steer is accepted", async () => {
    resetStorage();
    const events: string[] = [];
    const view = await renderComposer(
      buildRunningComposerModel({
        isQueueingEnabled: true,
        composerIntent: {
          prompt: "Steer with edited row",
          queuedFollowUpEdit: { followUpId: "follow-up-steer", ledgerRevision: 5 },
          focusNonce: 4,
        },
      }),
      {
        onSteerPrompt: async () => {
          events.push("steer");
        },
        onRemoveQueuedFollowUp: async (_threadId, followUpId) => {
          events.push(`remove:${followUpId}`);
        },
      },
    );

    await keyDownComposer(view, { key: "Enter", metaKey: true });

    await waitFor(() => expect(events).toEqual(["steer", "remove:follow-up-steer"]));
  });

  test("enter queues and cmd-enter steers while running in enter mode with queueing enabled", async () => {
    resetStorage();
    const primaryQueuedPrompts: string[] = [];
    const primarySteeredPrompts: string[] = [];
    const primaryView = await renderComposer(
      buildRunningComposerModel({
        isQueueingEnabled: true,
        composerEnterBehavior: "enter",
      }),
      {
        onEnqueueQueuedFollowUp: async (_threadId, prompt) => {
          primaryQueuedPrompts.push(prompt);
        },
        onSteerPrompt: async (input) => {
          primarySteeredPrompts.push(input.prompt);
        },
      },
    );

    await keyDownComposer(primaryView, { key: "Enter" });

    await waitFor(() => {
      expect(primaryQueuedPrompts.length).toBe(1);
    });
    expect(primarySteeredPrompts.length).toBe(0);
    primaryView.unmount();

    const alternateQueuedPrompts: string[] = [];
    const alternateSteeredPrompts: string[] = [];
    const alternateView = await renderComposer(
      buildRunningComposerModel({
        isQueueingEnabled: true,
        composerEnterBehavior: "enter",
      }),
      {
        onEnqueueQueuedFollowUp: async (_threadId, prompt) => {
          alternateQueuedPrompts.push(prompt);
        },
        onSteerPrompt: async (input) => {
          alternateSteeredPrompts.push(input.prompt);
        },
      },
    );

    await keyDownComposer(alternateView, { key: "Enter", metaKey: true });

    await waitFor(() => {
      expect(alternateSteeredPrompts.length).toBe(1);
    });
    expect(alternateSteeredPrompts[0]).toBe("Follow up");
    expect(alternateQueuedPrompts.length).toBe(0);
  });

  test("image-edit follow-ups serialize positional comments and always queue", async () => {
    resetStorage();
    const queued: Array<{ prompt: string; options: unknown }> = [];
    const steeredPrompts: string[] = [];
    replaceImageEditComposerDraft(IMAGE_EDIT_COMPOSER_CHANNEL_ID, {
      attachments: [
        {
          asset: {
            hostId: null,
            localPath: null,
            managedSource: null,
            src: "data:image/png;base64,aW1hZ2U=",
          },
          comments: [{ id: "comment-1", text: "Remove the label", x: 0.25, y: 0.75 }],
          filename: "Generated image 1",
          id: "image-playground:image-1",
          imageSource: "generated",
        },
      ],
      mode: "comment",
    });

    try {
      const view = await renderComposer(
        buildRunningComposerModel({
          isQueueingEnabled: true,
          composerEnterBehavior: "enter",
        }),
        {
          onEnqueueQueuedFollowUp: async (_threadId, prompt, options) => {
            queued.push({ prompt, options });
          },
          onSteerPrompt: async (input) => {
            steeredPrompts.push(input.prompt);
          },
        },
      );

      await keyDownComposer(view, { key: "Enter", metaKey: true });

      await waitFor(() => expect(queued).toHaveLength(1));
      expect(queued[0]?.prompt).toBe(
        [
          "Image 1:",
          "1. (x: 25%, y: 75%) Remove the label",
          "",
          "Additional instructions:",
          "Follow up",
        ].join("\n"),
      );
      expect(queued[0]?.options).toMatchObject({
        promptInput: {
          images: [
            {
              caption: "Generated image 1",
              source: "data:image/png;base64,aW1hZ2U=",
            },
          ],
        },
      });
      expect(steeredPrompts).toEqual([]);
      expect(getImageEditComposerDraftSnapshot(IMAGE_EDIT_COMPOSER_CHANNEL_ID).mode).toBeNull();
      expect(getGeneratedImageLiveCollectionSnapshot("thread_1").images.at(-1)).toMatchObject({
        loading: true,
        status: "loading",
      });
    } finally {
      clearImageEditComposerDraft(IMAGE_EDIT_COMPOSER_CHANNEL_ID);
      clearOptimisticGeneratedImageEdits("thread_1");
    }
  });

  test("cmdIfMultiline keeps cmd-enter primary and cmd-shift-enter alternate for multiline drafts", async () => {
    resetStorage();
    const primaryQueuedPrompts: string[] = [];
    const primarySteeredPrompts: string[] = [];
    const primaryView = await renderComposer(
      buildRunningComposerModel({
        composerIntent: {
          prompt: "Line one\nLine two",
          focusNonce: 1,
        },
        isQueueingEnabled: false,
        composerEnterBehavior: "cmdIfMultiline",
      }),
      {
        onEnqueueQueuedFollowUp: async (_threadId, prompt) => {
          primaryQueuedPrompts.push(prompt);
        },
        onSteerPrompt: async (input) => {
          primarySteeredPrompts.push(input.prompt);
        },
      },
    );

    await keyDownComposer(primaryView, { key: "Enter", metaKey: true });

    await waitFor(() => {
      expect(primarySteeredPrompts.length).toBe(1);
    });
    expect(primarySteeredPrompts[0]).toBe("Line one\nLine two");
    expect(primaryQueuedPrompts.length).toBe(0);
    primaryView.unmount();

    const alternateQueuedPrompts: string[] = [];
    const alternateSteeredPrompts: string[] = [];
    const alternateView = await renderComposer(
      buildRunningComposerModel({
        composerIntent: {
          prompt: "Line one\nLine two",
          focusNonce: 1,
        },
        isQueueingEnabled: false,
        composerEnterBehavior: "cmdIfMultiline",
      }),
      {
        onEnqueueQueuedFollowUp: async (_threadId, prompt) => {
          alternateQueuedPrompts.push(prompt);
        },
        onSteerPrompt: async (input) => {
          alternateSteeredPrompts.push(input.prompt);
        },
      },
    );

    await keyDownComposer(alternateView, { key: "Enter", metaKey: true, shiftKey: true });

    await waitFor(() => {
      expect(alternateQueuedPrompts.length).toBe(1);
    });
    expect(alternateQueuedPrompts[0]).toBe("Line one\nLine two");
    expect(alternateSteeredPrompts.length).toBe(0);
  });

  test("primary submit button follows primary action instead of alternate action", async () => {
    resetStorage();
    const queuedPrompts: string[] = [];
    const steeredPrompts: string[] = [];
    const view = await renderComposer(
      buildRunningComposerModel({
        isQueueingEnabled: false,
        composerEnterBehavior: "enter",
      }),
      {
        onEnqueueQueuedFollowUp: async (_threadId, prompt) => {
          queuedPrompts.push(prompt);
        },
        onSteerPrompt: async (input) => {
          steeredPrompts.push(input.prompt);
        },
      },
    );

    const primaryButton = view.getByLabelText("Steer follow-up");
    await waitFor(() => {
      expect((primaryButton as HTMLButtonElement).disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(primaryButton);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(steeredPrompts.length).toBe(1);
    });
    expect(steeredPrompts[0]).toBe("Follow up");
    expect(queuedPrompts.length).toBe(0);
  });

  test("/side command opens a side chat instead of sending a parent-thread prompt", async () => {
    resetStorage();
    const sentPrompts: string[] = [];
    const sideChatInputs: string[] = [];
    const view = await renderComposer(
      {
        composerIntent: {
          prompt: "/side investigate this",
          focusNonce: 1,
        },
      },
      {
        onSendPrompt: async (prompt) => {
          sentPrompts.push(prompt);
        },
        onOpenSideChat: async (input) => {
          sideChatInputs.push(JSON.stringify(input ?? null));
        },
      },
    );

    await submitCurrentComposerDraft(view);

    await waitFor(() => {
      expect(sideChatInputs.length).toBe(1);
    });
    expect(sideChatInputs[0]).toBe('{"prompt":"investigate this"}');
    expect(sentPrompts.length).toBe(0);
    await waitFor(() => expect(readComposerText(view)).toBe(""));
  });

  test("/side is unavailable inside an existing side chat", async () => {
    resetStorage();
    const baseConversation = buildModel().conversation;
    if (!baseConversation) {
      throw new Error("Expected the base conversation fixture.");
    }

    const sentPrompts: string[] = [];
    const sideChatInputs: string[] = [];
    const view = await renderComposer(
      {
        conversation: {
          ...baseConversation,
          ephemeral: true,
          source: {
            parentThreadId: "thread_1",
            sideConversation: true,
            sideConversationParentNavigationPath: "session:session_1/thread:thread_1",
          },
        },
        composerIntent: {
          prompt: "/side nested check",
          focusNonce: 1,
        },
      },
      {
        onSendPrompt: async (prompt) => {
          sentPrompts.push(prompt);
        },
        onOpenSideChat: async (input) => {
          sideChatInputs.push(JSON.stringify(input ?? null));
        },
      },
    );

    await submitCurrentComposerDraft(view);

    const snapshot = __getNodexToastSnapshotForTests();
    expect(sideChatInputs.length).toBe(0);
    expect(sentPrompts.length).toBe(0);
    expect(snapshot.length).toBe(1);
    expect(String((snapshot[0] as { title?: unknown }).title ?? "")).toBe(
      "'/side' is unavailable in side chats. Return to the main thread first",
    );
    expect(readComposerText(view)).toBe("/side nested check");
  });

  test("preserves the complete prompt when send or side-task creation fails", async () => {
    resetStorage();
    const sendView = await renderComposer(
      {
        composerIntent: {
          prompt: "preserve failed send",
          focusNonce: 1,
          promptInput: {
            text: "preserve failed send",
            skills: [{ name: "Failure Context", path: "/skills/failure-context" }],
          },
        },
      },
      {
        onSendPrompt: async () => {
          throw new Error("transport failed");
        },
      },
    );
    await submitCurrentComposerDraft(sendView);
    await waitFor(() =>
      expect(readComposerText(sendView)).toBe("preserve failed send Failure Context "),
    );
    expect(sendView.container.textContent?.includes("Failure Context") ?? false).toBe(true);
    sendView.unmount();

    resetStorage();
    const sideView = await renderComposer(
      { composerIntent: { prompt: "/side preserve failed side", focusNonce: 2 } },
      {
        onOpenSideChat: async () => {
          throw new Error("side failed");
        },
      },
    );
    await submitCurrentComposerDraft(sideView);
    await waitFor(() => expect(readComposerText(sideView)).toBe("/side preserve failed side"));
  });

  test("treats ordinary empty intent text as no-op and clearText as explicit deletion", async () => {
    resetStorage();
    const actions = buildActions();
    const renderTree = (intent: NonNullable<ThreadFooterModel["composerIntent"]>) => (
      <AppProviders>
        <TestComposerScopePath>
          <ThreadComposer
            model={buildModel({ composerIntent: intent })}
            actions={actions}
            errorMessage={null}
            onErrorMessage={() => {}}
          />
        </TestComposerScopePath>
      </AppProviders>
    );
    const view = render(renderTree({ prompt: "retained text", focusNonce: 1 }));
    await settleComposerFrame();
    expect(readComposerText(view)).toBe("retained text");

    await act(async () => {
      view.rerender(renderTree({ prompt: "", focusNonce: 2 }));
      await Promise.resolve();
    });
    await settleComposerFrame();
    expect(readComposerText(view)).toBe("retained text");

    await act(async () => {
      view.rerender(renderTree({ prompt: "", focusNonce: 3, clearText: true }));
      await Promise.resolve();
    });
    await waitFor(() => expect(readComposerText(view)).toBe(""));
  });

  test("applies explicit attachment append and replace semantics once per nonce", async () => {
    resetStorage();
    const actions = buildActions();
    const renderTree = (intent: NonNullable<ThreadFooterModel["composerIntent"]>) => (
      <AppProviders>
        <TestComposerScopePath>
          <ThreadComposer
            model={buildModel({ composerIntent: intent })}
            actions={actions}
            errorMessage={null}
            onErrorMessage={() => {}}
          />
        </TestComposerScopePath>
      </AppProviders>
    );
    const firstIntent = {
      prompt: "keep prompt",
      focusNonce: 10,
      promptInput: { text: "keep prompt", skills: [{ name: "Alpha", path: "/skills/alpha" }] },
    };
    const view = render(renderTree(firstIntent));
    await settleComposerFrame();
    expect(readComposerText(view)).toBe("keep prompt Alpha ");
    expect(view.container.textContent?.includes("Alpha") ?? false).toBe(true);

    await act(async () => {
      view.rerender(
        renderTree({
          prompt: "",
          focusNonce: 11,
          attachmentMode: "append",
          promptInput: { text: "", skills: [{ name: "Beta", path: "/skills/beta" }] },
        }),
      );
      await Promise.resolve();
    });
    await settleComposerFrame();
    expect(readComposerText(view)).toBe("keep prompt Alpha Beta ");
    expect(view.container.textContent?.includes("Alpha") ?? false).toBe(true);
    expect(view.container.textContent?.includes("Beta") ?? false).toBe(true);

    await act(async () => {
      view.rerender(
        renderTree({
          prompt: "",
          focusNonce: 12,
          attachmentMode: "replace",
          promptInput: { text: "", skills: [{ name: "Beta", path: "/skills/beta" }] },
        }),
      );
      await Promise.resolve();
    });
    await settleComposerFrame();
    expect(readComposerText(view)).toBe("keep prompt Beta ");
    expect(view.container.textContent?.includes("Alpha") ?? false).toBe(false);
    expect(view.container.textContent?.includes("Beta") ?? false).toBe(true);
  });

  test("projects model picker shortcut metadata and respects unassignment", async () => {
    const customizedView = await renderComposer({
      modelPickerShortcut: {
        label: "⌘⌥M",
        ariaKeyShortcuts: "Meta+Alt+M",
      },
    });
    expect(customizedView.getByLabelText("Select model").getAttribute("aria-keyshortcuts")).toBe(
      "Meta+Alt+M",
    );

    customizedView.unmount();

    const unassignedView = await renderComposer({ modelPickerShortcut: null });
    expect(unassignedView.getByLabelText("Select model").hasAttribute("aria-keyshortcuts")).toBe(
      false,
    );
  });

  test("shows the Codex-style fast indicator before the model label only when Fast is active", async () => {
    resetStorage();

    const standardView = await renderComposer();
    const standardModelTrigger = standardView.getByLabelText("Select model");
    expect(Boolean(standardModelTrigger.querySelector('[data-fast-mode-indicator="true"]'))).toBe(
      false,
    );

    standardView.unmount();

    localStorageRef.setItem("nodex-codex-default-service-tier-v1", "fast");

    const fastView = await renderComposer();
    const fastModelTrigger = fastView.getByLabelText("Select model");
    const fastIndicator = fastModelTrigger.querySelector('[data-fast-mode-indicator="true"]');
    expect(Boolean(fastIndicator)).toBe(true);

    const fastIcon = fastIndicator?.querySelector("svg");
    if (!(fastIcon instanceof SVGSVGElement)) {
      throw new Error("Expected the Fast indicator to render an SVG icon.");
    }
    expect(fastIcon.getAttribute("width")).toBe("24");
    expect(fastIcon.getAttribute("height")).toBe("24");
    expect(fastIcon.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(fastIcon.classList.contains("icon-2xs")).toBe(true);
    expect(fastIcon.classList.contains("text-token-foreground")).toBe(true);

    const fastIconPath = fastIcon.querySelector("path");
    if (!(fastIconPath instanceof SVGPathElement)) {
      throw new Error("Expected the Fast indicator SVG to include a path.");
    }
    expect(fastIconPath.getAttribute("d")).toBe(FAST_MODE_ICON_PATH);
    expect(fastIconPath.getAttribute("fill")).toBe("currentColor");
  });

  test("writes the shared service tier setting from the Speed submenu", async () => {
    resetStorage();
    const view = await renderComposer();

    const modelTrigger = view.getByLabelText("Select model");

    expect(Boolean(modelTrigger.querySelector('[data-fast-mode-indicator="true"]'))).toBe(false);

    await act(async () => {
      fireEvent.pointerDown(modelTrigger, { button: 0, ctrlKey: false });
      fireEvent.click(modelTrigger);
      await Promise.resolve();
    });

    const speedTrigger = view.getByLabelText("Speed Standard");

    await act(async () => {
      fireEvent.click(speedTrigger);
      await Promise.resolve();
    });

    const fastOption = view.container.ownerDocument.body.querySelectorAll(
      '[data-slot="dropdown-item"]',
    );
    const fastItem = Array.from(fastOption).find((node) => node.textContent?.includes("Fast"));
    if (!(fastItem instanceof HTMLElement)) {
      throw new Error("Expected the Fast speed option.");
    }

    await act(async () => {
      fireEvent.click(fastItem);
      await Promise.resolve();
    });

    expect(localStorageRef.getItem("nodex-codex-default-service-tier-v1")).toBe("fast");
    expect(Boolean(modelTrigger.querySelector('[data-fast-mode-indicator="true"]'))).toBe(true);
  });

  test("keeps Speed out of the add-context menu", async () => {
    resetStorage();
    const view = await renderComposer();

    const trigger = view.getByLabelText("Add files and more");

    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });

    const menuItems = Array.from(
      view.container.ownerDocument.body.querySelectorAll('[data-slot="dropdown-item"]'),
    );
    expect(menuItems.some((node) => node.textContent?.includes("Speed"))).toBe(false);
  });

  test("add-context menu groups direct actions in Codex row order", async () => {
    resetStorage();
    const selectedModes: string[] = [];
    const view = await renderComposer(
      {
        composerIntent: {
          prompt: "toggle mode",
          focusNonce: 1,
        },
      },
      {
        onCollaborationModeChange: (mode) => {
          selectedModes.push(mode);
        },
      },
    );

    const trigger = view.getByLabelText("Add files and more");

    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });

    const bodyText = view.container.ownerDocument.body.textContent ?? "";
    expect(Boolean(bodyText.includes("Add files and more"))).toBe(false);
    expect(Boolean(bodyText.includes("Files and folders"))).toBe(true);
    expect(Boolean(bodyText.includes("Plan mode"))).toBe(true);
    expect(Boolean(bodyText.includes("Speed"))).toBe(false);
    expect(Boolean(bodyText.includes("Plugins"))).toBe(false);

    const planRow = view.container.ownerDocument.body.querySelector(
      '[data-add-context-row="plan-mode"]',
    );
    if (!(planRow instanceof HTMLElement)) {
      throw new Error("Expected the Plan mode row.");
    }

    await act(async () => {
      fireEvent.click(planRow);
      await Promise.resolve();
    });

    expect(selectedModes[0]).toBe("plan");
  });

  test("captures the discovered foreground app as a structured Appshot attachment", async () => {
    resetStorage();
    const sentPromptInputs: unknown[] = [];
    const target = {
      id: "target-1",
      appName: "Safari",
      bundleIdentifier: "com.apple.Safari",
      windowTitle: "Nodex",
      iconSmallDataUrl: "data:image/png;base64,aWNvbg==",
    };
    const context = {
      id: "appshot-1",
      appName: "Safari",
      bundleIdentifier: "com.apple.Safari",
      windowTitle: "Nodex",
      axTree: "AXWindow title=Nodex",
      imageName: "Safari Appshot.png",
      imageDataUrl: "data:image/png;base64,YXBwc2hvdA==",
      appIconDataUrl: "data:image/png;base64,aWNvbg==",
    };
    const view = await renderComposer(
      undefined,
      {
        onSendPrompt: async (_prompt, options) => {
          sentPromptInputs.push(options?.promptInput ?? null);
        },
      },
      async (channel, ...args) => {
        if (channel === "codex:composer-appshot:target") {
          return { available: true, target };
        }
        if (channel === "codex:composer-appshot:capture") {
          expect(args[0]).toEqual({ targetId: "target-1" });
          return context;
        }
        return undefined;
      },
    );

    const trigger = view.getByLabelText("Add files and more");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    const appshotRow = await waitFor(() => {
      const row = view.container.querySelector('[data-add-context-row="appshot"]');
      if (!(row instanceof HTMLElement)) {
        throw new Error("Expected the foreground Appshot row.");
      }
      return row;
    });
    expect(appshotRow.textContent).toContain("Attach Safari");

    await act(async () => {
      fireEvent.click(appshotRow);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(view.container.querySelector('[data-composer-appshot="true"]')).not.toBeNull();
    });

    await submitCurrentComposerDraft(view);
    expect(sentPromptInputs).toEqual([
      {
        text: "",
        appshots: [context],
      },
    ]);
  });

  test("shift-tab toggles Plan mode and blocks focus traversal", async () => {
    resetStorage();
    const selectedModes: string[] = [];
    const view = await renderComposer(undefined, {
      onCollaborationModeChange: (mode) => {
        selectedModes.push(mode);
      },
    });

    const wasNotCanceled = await keyDownComposer(
      view,
      { key: "Tab", shiftKey: true },
      { waitForContent: false },
    );

    expect(wasNotCanceled).toBe(false);
    expect(selectedModes[0]).toBe("plan");
  });

  test("Plan mode changes the composer placeholder", async () => {
    resetStorage();
    const view = await renderComposer({
      selectedCollaborationMode: "plan",
    });

    await waitFor(() => {
      const placeholder = view.container.querySelector<HTMLElement>(
        '[data-placeholder="Describe your task to generate a plan..."]',
      );
      if (!placeholder) {
        throw new Error("Expected Plan mode placeholder.");
      }
      expect(placeholder.classList.contains("placeholder")).toBe(true);
    });
  });

  test("plan keyword suggestion can use or dismiss Plan mode", async () => {
    resetStorage();
    const selectedModes: string[] = [];
    const view = await renderComposer(
      {
        composerIntent: {
          prompt: "please plan the migration",
          focusNonce: 1,
        },
      },
      {
        onCollaborationModeChange: (mode) => {
          selectedModes.push(mode);
        },
      },
    );

    await waitFor(() => {
      const suggestion = view.container.querySelector('[data-plan-keyword-suggestion="true"]');
      if (!suggestion) {
        throw new Error("Expected plan keyword suggestion.");
      }
      expect(Boolean(suggestion.textContent?.includes("Create a plan"))).toBe(true);
    });

    const usePlanButton = view.container.querySelector(
      '[data-codex-above-composer-suggestion-action="true"]',
    );
    if (!(usePlanButton instanceof HTMLElement)) {
      throw new Error("Expected Use plan mode button.");
    }

    await act(async () => {
      fireEvent.click(usePlanButton);
      await Promise.resolve();
    });

    expect(selectedModes[0]).toBe("plan");
    expect(
      Boolean(
        view.container.querySelector('[data-codex-above-composer-suggestion="keyword-plan-mode"]'),
      ),
    ).toBe(true);
    view.unmount();

    const dismissView = await renderComposer({
      composerIntent: {
        prompt: "please plan the migration",
        focusNonce: 2,
      },
    });
    const dismissButton = await waitFor(() => {
      const button = dismissView.container.querySelector('[aria-label="Dismiss suggestion"]');
      if (!(button instanceof HTMLElement)) {
        throw new Error("Expected dismiss plan suggestion button.");
      }
      return button;
    });
    await act(async () => {
      fireEvent.click(dismissButton);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        Boolean(dismissView.container.querySelector('[data-plan-keyword-suggestion="true"]')),
      ).toBe(false);
    });
  });

  test("add-context prompt input keeps file and added sidecars, images, and plugin skills distinct", () => {
    const promptInput = __composerAddContextTestUtils.buildComposerPromptInput({
      prompt: "  Use these\n[$Computer Use](/plugins/computer-use)",
      attachments: {
        fileAttachments: [
          {
            uiId: "file_1",
            attachment: {
              label: "notes.md",
              path: "/tmp/notes.md",
              fsPath: "/tmp/notes.md",
            },
          },
        ],
        addedFiles: [
          {
            uiId: "added_1",
            attachment: {
              label: "generated.md",
              path: "/tmp/generated.md",
              fsPath: "/tmp/generated.md",
            },
          },
        ],
        imageAttachments: [
          {
            id: "image_1",
            filename: "diagram.png",
            mimeType: "image/png",
            src: "data:image/png;base64,aW1hZ2U=",
            origin: "restored",
            materialization: null,
            materializationStatus: "failed",
            uploadStatus: "idle",
            generation: 0,
          },
        ],
        appshotContexts: [],
        pastedTextAttachments: [
          {
            id: "pasted_text_1",
            status: "ready",
            preview: "Pasted requirements",
            characterCount: 19,
            attachment: {
              file: {
                label: "Pasted text.txt",
                path: "/tmp/pasted-text.txt",
                fsPath: "/tmp/pasted-text.txt",
              },
              preview: "Pasted requirements",
              characterCount: 19,
            },
          },
        ],
        commentAttachments: [],
        browserAnnotationAttachments: [],
      },
    });

    expect(JSON.stringify(promptInput)).toBe(
      '{"text":"  Use these\\n","documentItems":[{"type":"text","text":"  Use these\\n"},{"type":"skill","name":"Computer Use","path":"/plugins/computer-use"}],"images":[{"source":"data:image/png;base64,aW1hZ2U=","caption":"diagram.png"}],"textAttachments":[{"file":{"label":"Pasted text.txt","path":"/tmp/pasted-text.txt","fsPath":"/tmp/pasted-text.txt"},"preview":"Pasted requirements","characterCount":19}],"fileAttachments":[{"label":"notes.md","path":"/tmp/notes.md","fsPath":"/tmp/notes.md"}],"addedFiles":[{"label":"generated.md","path":"/tmp/generated.md","fsPath":"/tmp/generated.md"}],"skills":[{"name":"Computer Use","path":"/plugins/computer-use"}]}',
    );
    expect(
      __composerAddContextTestUtils.isComposerImageFile({
        label: "diagram.png",
        path: "/tmp/diagram.png",
      }),
    ).toBe(true);
    expect(
      __composerAddContextTestUtils.isComposerImageFile({
        label: "notes.md",
        path: "/tmp/notes.md",
      }),
    ).toBe(false);
  });

  test("compiles document-owned mentions into structured prompt input", () => {
    const promptInput = __composerAddContextTestUtils.buildComposerPromptInput({
      prompt: [
        "Use [@Browser](plugin://browser@openai-bundled)",
        "and [$plugin-management](app://plugin-management)",
        "and [$PDF](/skills/pdf/SKILL.md)",
        "with [notes.md](/tmp/notes.md)",
      ].join("\n"),
      attachments: {
        fileAttachments: [],
        addedFiles: [],
        imageAttachments: [],
        appshotContexts: [],
        pastedTextAttachments: [],
        commentAttachments: [],
        browserAnnotationAttachments: [],
      },
    });

    expect(promptInput).toEqual({
      text: "Use \nand \nand \nwith ",
      documentItems: [
        {
          type: "text",
          text: "Use ",
        },
        {
          type: "mention",
          name: "Browser",
          path: "plugin://browser@openai-bundled",
        },
        {
          type: "text",
          text: "\nand ",
        },
        {
          type: "mention",
          name: "plugin-management",
          path: "app://plugin-management",
        },
        {
          type: "text",
          text: "\nand ",
        },
        {
          type: "skill",
          name: "PDF",
          path: "/skills/pdf/SKILL.md",
        },
        {
          type: "text",
          text: "\nwith ",
        },
        {
          type: "mention",
          name: "notes.md",
          path: "/tmp/notes.md",
        },
      ],
      mentions: [
        {
          name: "Browser",
          path: "plugin://browser@openai-bundled",
        },
        {
          name: "plugin-management",
          path: "app://plugin-management",
        },
        {
          name: "notes.md",
          path: "/tmp/notes.md",
        },
      ],
      skills: [
        {
          name: "PDF",
          path: "/skills/pdf/SKILL.md",
        },
      ],
    });
  });

  test("restores all structured mentions into the persisted prompt document", () => {
    expect(
      __composerAddContextTestUtils.buildPersistedMentionPrompt({
        text: "",
        mentions: [
          {
            name: "Browser",
            path: "plugin://browser@openai-bundled",
          },
          {
            name: "Plugin Management",
            path: "app://plugin-management",
          },
          {
            name: "notes.md",
            path: "/tmp/notes.md",
          },
          {
            name: "Release notes",
            path: "sites-project://site-1",
          },
          {
            name: "Prior research",
            path: "chatgpt-conversation://conversation-1",
          },
        ],
        skills: [
          {
            name: "PDF",
            path: "/skills/pdf/SKILL.md",
          },
        ],
      }),
    ).toBe(
      "[@Browser](plugin://browser@openai-bundled) [$plugin-management](app://plugin-management) [notes.md](/tmp/notes.md) [Release notes](sites-project://site-1) [Prior research](chatgpt-conversation://conversation-1) [$PDF](/skills/pdf/SKILL.md)",
    );
  });

  test("restores an ordered prompt document without moving mentions", () => {
    expect(
      __composerAddContextTestUtils.buildPersistedPromptDocument({
        text: "Open  then ",
        documentItems: [
          {
            type: "text",
            text: "Open ",
          },
          {
            type: "mention",
            name: "notes.md",
            path: "docs/notes.md",
          },
          {
            type: "text",
            text: " then ",
          },
          {
            type: "skill",
            name: "PDF",
            path: "/skills/pdf/SKILL.md",
          },
        ],
      }),
    ).toBe("Open [notes.md](docs/notes.md) then [$PDF](/skills/pdf/SKILL.md)");
  });

  test("does not demote document mentions into footer file attachments", () => {
    const attachmentState =
      __composerAddContextTestUtils.buildComposerAttachmentStateFromPromptInput({
        text: "",
        mentions: [
          {
            name: "notes.md",
            path: "/tmp/notes.md",
          },
        ],
      });

    expect(attachmentState.fileAttachments).toEqual([]);
  });

  test("replacing structured mention input removes prior document mentions", () => {
    expect(
      __composerAddContextTestUtils.removePersistedMentionPrompt(
        [
          "Keep [notes.md](/tmp/notes.md)",
          "remove [@Browser](plugin://browser@openai-bundled)",
          "and [$PDF](/skills/pdf/SKILL.md)",
        ].join("\n"),
      ),
    ).toBe(["Keep ", "remove ", "and"].join("\n"));
  });

  test("restores pasted source metadata exactly and treats an explicit empty file channel as authoritative", () => {
    const attachmentState =
      __composerAddContextTestUtils.buildComposerAttachmentStateFromPromptInput({
        text: "",
        textAttachments: [
          {
            text: "Exact pasted bytes",
            file: {
              label: "Pasted text.txt",
              path: "/attachments/id/pasted-text.txt",
              fsPath: "/attachments/id/pasted-text.txt",
            },
            preview: "Exact pasted bytes",
            hostId: "local",
            characterCount: 18,
          },
        ],
        fileAttachments: [],
        mentions: [{ name: "legacy.md", path: "/tmp/legacy.md" }],
      });
    const roundTripped = __composerAddContextTestUtils.buildComposerPromptInput({
      prompt: "",
      attachments: attachmentState,
    });

    expect(attachmentState.fileAttachments.length).toBe(0);
    expect(JSON.stringify(roundTripped)).toBe(
      JSON.stringify({
        text: "",
        textAttachments: [
          {
            file: {
              label: "Pasted text.txt",
              path: "/attachments/id/pasted-text.txt",
              fsPath: "/attachments/id/pasted-text.txt",
            },
            preview: "Exact pasted bytes",
            hostId: "local",
            characterCount: 18,
          },
        ],
      }),
    );
  });

  test("restores explicit file channels without rewriting attachment identity fields", () => {
    const attachmentState =
      __composerAddContextTestUtils.buildComposerAttachmentStateFromPromptInput({
        text: "",
        fileAttachments: [
          {
            label: "  exact label  ",
            path: "relative/source.ts",
            fsPath: "",
            startLine: null,
            endLine: 9,
            hostId: "local",
            id: "protocol-file-id",
            appContext: { source: "exact" },
          },
          {
            label: "  exact label  ",
            path: "relative/source.ts",
            fsPath: "",
            startLine: undefined,
            endLine: 9,
            hostId: "duplicate-host-must-not-win",
            id: "duplicate-protocol-id",
            appContext: { source: "duplicate" },
          },
        ],
        addedFiles: [
          {
            label: "added.ts",
            path: "relative/added.ts",
            fsPath: "/repo/relative/added.ts",
            startLine: 3,
            endLine: 3,
            id: "protocol-added-id",
          },
          {
            label: "added.ts",
            path: "relative/added.ts",
            fsPath: "/repo/relative/added.ts",
            startLine: 3,
            endLine: 3,
          },
        ],
      });
    const roundTripped = __composerAddContextTestUtils.buildComposerPromptInput({
      prompt: "",
      attachments: attachmentState,
    });

    expect(JSON.stringify(roundTripped)).toBe(
      JSON.stringify({
        text: "",
        fileAttachments: [
          {
            label: "  exact label  ",
            path: "relative/source.ts",
            fsPath: "",
            startLine: null,
            endLine: 9,
            hostId: "local",
            id: "protocol-file-id",
            appContext: { source: "exact" },
          },
        ],
        addedFiles: [
          {
            label: "added.ts",
            path: "relative/added.ts",
            fsPath: "/repo/relative/added.ts",
            startLine: 3,
            endLine: 3,
            id: "protocol-added-id",
          },
        ],
      }),
    );
  });

  test("unified add-context menu inserts a structured plugin mention", async () => {
    resetStorage();
    const sentPromptInputs: string[] = [];
    const view = await renderComposer(
      {
        composerPlugins: [
          {
            id: "computer-use@openai-bundled",
            name: "Computer",
            displayName: "Computer",
            description: "Control Mac apps from ChatGPT",
            defaultPrompt: null,
            installed: true,
            enabled: true,
            path: "plugin://computer-use@openai-bundled",
            iconUrl: null,
            iconUrlDark: null,
            brandColor: null,
          },
        ],
      },
      {
        onSendPrompt: async (_prompt, opts) => {
          sentPromptInputs.push(JSON.stringify(opts?.promptInput ?? null));
        },
      },
    );

    const trigger = view.getByLabelText("Add files and more");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });

    const pluginItem = view.container.querySelector('[data-add-context-plugin="Computer"]');
    if (!(pluginItem instanceof HTMLElement)) {
      throw new Error("Expected the Computer plugin row.");
    }
    const editor = view.container.querySelector("[contenteditable='true']");
    if (!(editor instanceof HTMLElement)) {
      throw new Error("Expected the composer editor.");
    }
    expect(document.activeElement).toBe(editor);

    await act(async () => {
      fireEvent.keyDown(editor, { key: "ArrowUp" });
      await Promise.resolve();
    });
    expect(pluginItem.getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      fireEvent.keyDown(editor, { key: "Enter" });
      await Promise.resolve();
    });

    expect(
      editor.querySelector("[plugin-mention-path='plugin://computer-use@openai-bundled']"),
    ).not.toBeNull();
    const sendButton = view.getByLabelText("Send prompt");
    await act(async () => {
      fireEvent.click(sendButton);
      await Promise.resolve();
    });

    expect(JSON.parse(sentPromptInputs[0] ?? "null")).toMatchObject({
      mentions: [
        {
          name: "Computer",
          path: "plugin://computer-use@openai-bundled",
        },
      ],
    });
    expect(sentPromptInputs[0]).not.toContain('"skills"');
  });

  test("inserts authenticated Sites and ChatGPT conversation mentions", async () => {
    resetStorage();
    const sentPromptInputs: string[] = [];
    const view = await renderComposer(
      {
        composerSitesAvailable: true,
        composerSites: [
          {
            id: "appgprj_release",
            title: "Release notes",
            slug: "release-notes",
            currentLiveUrl: "https://release.chatgpt.site/docs",
            path: "sites-project://appgprj_release",
          },
        ],
        composerChatGptConversationsAvailable: true,
        composerChatGptConversations: [
          {
            conversationId: "conversation/research",
            title: "Prior research",
            path: "chatgpt-conversation://conversation%2Fresearch",
          },
        ],
      },
      {
        onSendPrompt: async (_prompt, opts) => {
          sentPromptInputs.push(JSON.stringify(opts?.promptInput ?? null));
        },
      },
    );
    const trigger = view.getByLabelText("Add files and more");
    const openMenu = async () => {
      await act(async () => {
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
        fireEvent.click(trigger);
        await Promise.resolve();
      });
    };

    await openMenu();
    const siteRow = view.container.querySelector('[data-add-context-row="site:appgprj_release"]');
    if (!(siteRow instanceof HTMLElement)) {
      throw new Error("Expected the Sites project row.");
    }
    expect(siteRow.textContent).toContain("release.chatgpt.site/docs");
    await act(async () => {
      fireEvent.click(siteRow);
      await Promise.resolve();
    });

    await openMenu();
    const conversationRow = view.container.querySelector(
      '[data-add-context-row="chatgpt-conversation:conversation/research"]',
    );
    if (!(conversationRow instanceof HTMLElement)) {
      throw new Error("Expected the ChatGPT conversation row.");
    }
    await act(async () => {
      fireEvent.click(conversationRow);
      await Promise.resolve();
    });

    const editor = view.container.querySelector("[contenteditable='true']");
    if (!(editor instanceof HTMLElement)) {
      throw new Error("Expected the composer editor.");
    }
    expect(
      editor.querySelector("[sites-project-mention-path='sites-project://appgprj_release']"),
    ).not.toBeNull();
    expect(
      editor.querySelector(
        "[chatgpt-conversation-mention-path='chatgpt-conversation://conversation%2Fresearch']",
      ),
    ).not.toBeNull();

    await act(async () => {
      fireEvent.click(view.getByLabelText("Send prompt"));
      await Promise.resolve();
    });
    expect(JSON.parse(sentPromptInputs[0] ?? "null")).toMatchObject({
      mentions: [
        {
          name: "Release notes",
          path: "sites-project://appgprj_release",
        },
        {
          name: "Prior research",
          path: "chatgpt-conversation://conversation%2Fresearch",
        },
      ],
    });
  });

  test("activates an install suggestion before exposing its plugin mention", async () => {
    resetStorage();
    const activationInputs: unknown[] = [];
    const view = await renderComposer(
      {
        composerPlugins: [
          {
            id: "browser@openai-bundled",
            name: "Browser",
            displayName: "Browser",
            description: "Control the in-app browser with ChatGPT",
            defaultPrompt: null,
            installed: false,
            enabled: false,
            path: "plugin://browser@openai-bundled",
            iconUrl: null,
            iconUrlDark: null,
            brandColor: null,
          },
        ],
      },
      undefined,
      async (channel, ...args) => {
        if (channel !== "codex:composer-plugins:activate") {
          return undefined;
        }
        activationInputs.push(args[0]);
        return null;
      },
    );

    const trigger = view.getByLabelText("Add files and more");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    const browserRow = view.container.querySelector('[data-add-context-plugin="Browser"]');
    if (!(browserRow instanceof HTMLElement)) {
      throw new Error("Expected the Browser plugin row.");
    }

    await act(async () => {
      fireEvent.click(browserRow);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(activationInputs).toEqual([
        {
          id: "browser@openai-bundled",
          cwds: ["/tmp/project"],
        },
      ]);
    });
    expect(
      view.container.querySelector("[plugin-mention-path='plugin://browser@openai-bundled']"),
    ).not.toBeNull();
  });

  test("Record a skill activates its plugin and prefills a new chat", async () => {
    resetStorage();
    const activationInputs: unknown[] = [];
    const newChatInputs: unknown[] = [];
    const view = await renderComposer(
      {
        composerPlugins: [
          {
            id: "record-and-replay@openai-bundled",
            name: "record-and-replay",
            displayName: "Record and Replay",
            description: "Turn a workflow into a reusable skill",
            defaultPrompt: "Record this workflow as a reusable skill.",
            installed: false,
            enabled: false,
            path: "plugin://record-and-replay@openai-bundled",
            iconUrl: null,
            iconUrlDark: null,
            brandColor: null,
          },
        ],
      },
      {
        onStartNewChatWithPrompt: async (input) => {
          newChatInputs.push(input);
        },
      },
      async (channel, ...args) => {
        if (channel !== "codex:composer-plugins:activate") {
          return undefined;
        }
        activationInputs.push(args[0]);
        return null;
      },
    );

    const trigger = view.getByLabelText("Add files and more");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    const recordRow = view.container.querySelector('[data-add-context-row="record-skill"]');
    if (!(recordRow instanceof HTMLElement)) {
      throw new Error("Expected the Record a skill action.");
    }
    expect(
      view.container.querySelector('[data-add-context-plugin="Record and Replay"]'),
    ).toBeNull();

    await act(async () => {
      fireEvent.click(recordRow);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(activationInputs).toHaveLength(1);
      expect(newChatInputs).toEqual([
        {
          projectId: "project_1",
          prompt:
            "[@Record and Replay](plugin://record-and-replay@openai-bundled) Record this workflow as a reusable skill.",
        },
      ]);
    });
  });

  test("Work in a project replaces the root suggestions with project choices", async () => {
    resetStorage();
    const selectedProjectIds: Array<string | null> = [];
    const view = await renderComposer(
      {
        conversation: null,
        isNewThreadTab: true,
        newThreadTarget: {
          projectId: "project_1",
          projectName: "Nodex",
          sessionId: "session_1",
          threadTitle: "New thread",
          runInTarget: "localProject",
        },
        newThreadProjectSelector: {
          selectedProjectId: "project_1",
          disabled: false,
          canAddProject: true,
          projects: [
            {
              id: "project_1",
              label: "Nodex",
              appearance: {
                color: "green",
                marker: { kind: "icon", icon: "plant" },
              },
              description: "/tmp/project",
              primaryWorkspaceRoot: "/tmp/project",
              searchText: "project_1 nodex /tmp/project",
            },
            {
              id: "project_2",
              label: "Devtools Codex",
              appearance: {
                color: "blue",
                marker: { kind: "icon", icon: "function" },
              },
              description: "/tmp/devtools-codex",
              primaryWorkspaceRoot: "/tmp/devtools-codex",
              searchText: "project_2 devtools codex /tmp/devtools-codex",
            },
          ],
        },
      },
      {
        onNewThreadProjectChange: (projectId) => {
          selectedProjectIds.push(projectId);
        },
      },
    );

    const trigger = view.getByLabelText("Add files and more");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    const projectAction = view.container.querySelector('[data-add-context-row="project"]');
    if (!(projectAction instanceof HTMLElement)) {
      throw new Error("Expected the Work in a project action.");
    }

    await act(async () => {
      fireEvent.click(projectAction);
      await Promise.resolve();
    });

    const projectMenu = view.getByLabelText("Work in a project");
    const projectRows = Array.from(projectMenu.querySelectorAll("[data-add-context-row]")).map(
      (row) => row.getAttribute("data-add-context-row"),
    );
    expect(projectRows).toEqual(["project:none", "project:project_1", "project:project_2"]);
    expect(
      projectMenu.querySelector(
        '[data-add-context-row="project:project_1"] [data-state="checked"]',
      ),
    ).not.toBeNull();

    const devtoolsProject = projectMenu.querySelector('[data-add-context-row="project:project_2"]');
    if (!(devtoolsProject instanceof HTMLElement)) {
      throw new Error("Expected the Devtools Codex project row.");
    }
    await act(async () => {
      fireEvent.click(devtoolsProject);
      await Promise.resolve();
    });

    expect(selectedProjectIds).toEqual(["project_2"]);
    expect(view.container.querySelector('[aria-label="Work in a project"]')).toBeNull();
  });

  test("app rows insert canonical app mentions", async () => {
    resetStorage();
    const sentPromptInputs: string[] = [];
    const view = await renderComposer(
      {
        composerApps: [
          {
            id: "plugin-management",
            name: "Plugin Management",
            description: "Manage installed plugins",
            logoUrl: null,
            logoUrlDark: null,
            iconAssets: null,
            iconDarkAssets: null,
            distributionChannel: null,
            branding: null,
            appMetadata: null,
            labels: null,
            installUrl: null,
            isAccessible: true,
            isEnabled: true,
            pluginDisplayNames: [],
          },
        ],
      },
      {
        onSendPrompt: async (_prompt, opts) => {
          sentPromptInputs.push(JSON.stringify(opts?.promptInput ?? null));
        },
      },
    );

    const trigger = view.getByLabelText("Add files and more");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });

    const appItem = view.container.querySelector('[data-add-context-app="Plugin Management"]');
    if (!(appItem instanceof HTMLElement)) {
      throw new Error("Expected the Plugin Management app row.");
    }

    await act(async () => {
      fireEvent.click(appItem);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByLabelText("Send prompt"));
      await Promise.resolve();
    });

    expect(JSON.parse(sentPromptInputs[0] ?? "null")).toMatchObject({
      mentions: [
        {
          name: "plugin-management",
          path: "app://plugin-management",
        },
      ],
    });
  });

  test("typed dollar suggestions combine skills and apps without section headers", async () => {
    resetStorage();
    const sentPromptInputs: string[] = [];
    const view = await renderComposer(
      {
        composerIntent: {
          prompt: "$plug",
          focusNonce: 1,
        },
        composerSkills: [
          {
            name: "plugin-creator",
            displayName: "Plugin Creator",
            description: "Create Codex plugins",
            iconUrl: null,
            brandColor: null,
            path: "/skills/plugin-creator/SKILL.md",
            scope: "system",
          },
        ],
        composerApps: [
          {
            id: "plugin-management",
            name: "Plugin Management",
            description: "Manage installed plugins",
            logoUrl: null,
            logoUrlDark: null,
            iconAssets: null,
            iconDarkAssets: null,
            distributionChannel: null,
            branding: null,
            appMetadata: null,
            labels: null,
            installUrl: null,
            isAccessible: true,
            isEnabled: true,
            pluginDisplayNames: [],
          },
        ],
      },
      {
        onSendPrompt: async (_prompt, opts) => {
          sentPromptInputs.push(JSON.stringify(opts?.promptInput ?? null));
        },
      },
    );

    const menu = await waitFor(() => {
      const element = view.container.querySelector('[data-skill-mention-menu="true"]');
      if (!(element instanceof HTMLElement)) {
        throw new Error("Expected the skill mention menu.");
      }
      return element;
    });
    expect(
      menu.querySelector('[data-add-context-row="skill:/skills/plugin-creator/SKILL.md"]'),
    ).not.toBeNull();
    const appItem = menu.querySelector('[data-add-context-app="Plugin Management"]');
    if (!(appItem instanceof HTMLElement)) {
      throw new Error("Expected the Plugin Management app row.");
    }

    await act(async () => {
      fireEvent.click(appItem);
      await Promise.resolve();
    });
    const editor = view.container.querySelector("[contenteditable='true']");
    expect(editor?.textContent).toContain("Plugin Management");
    expect(editor?.textContent).not.toContain("$Plugin Management");

    await act(async () => {
      fireEvent.click(view.getByLabelText("Send prompt"));
      await Promise.resolve();
    });
    expect(JSON.parse(sentPromptInputs[0] ?? "null")).toMatchObject({
      mentions: [
        {
          name: "plugin-management",
          path: "app://plugin-management",
        },
      ],
    });
  });

  test("empty plus suggestions leave skills to the dedicated dollar surface", async () => {
    resetStorage();
    const view = await renderComposer({
      composerSkills: [
        {
          name: "pdf",
          displayName: "PDF",
          description: "Read and create PDFs",
          iconUrl: null,
          brandColor: null,
          path: "/skills/pdf/SKILL.md",
          scope: "system",
        },
      ],
    });

    const trigger = view.getByLabelText("Add files and more");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });

    const menu = view.container.querySelector('[data-add-context-menu="true"]');
    expect(menu?.querySelector('[data-add-context-row="skill:/skills/pdf/SKILL.md"]')).toBeNull();
    expect(menu?.textContent).toContain("Type to search files or chats");
  });

  test("opens the Codex-style inline slash command menu above the composer", async () => {
    resetStorage();
    const view = await renderComposer({
      composerIntent: {
        prompt: "/",
        focusNonce: 1,
      },
    });

    await waitFor(() => {
      const menu = view.container.querySelector('[data-slash-command-menu="true"]');
      if (!menu) throw new Error("Expected the slash command menu.");
      expect(Boolean(menu.textContent?.includes("Compact"))).toBe(true);
      expect(Boolean(menu.textContent?.includes("Fast"))).toBe(true);
      expect(Boolean(menu.textContent?.includes("Feedback"))).toBe(true);
      expect(Boolean(menu.textContent?.includes("MCP"))).toBe(true);
      expect(Boolean(menu.textContent?.includes("Model"))).toBe(true);
      expect(Boolean(menu.textContent?.includes("No commands"))).toBe(false);
    });
  });

  test("slash Plan command toggles through the shared Plan mode action", async () => {
    resetStorage();
    const selectedModes: string[] = [];
    const view = await renderComposer(
      {
        composerIntent: {
          prompt: "/plan",
          focusNonce: 1,
        },
      },
      {
        onCollaborationModeChange: (mode) => {
          selectedModes.push(mode);
        },
      },
    );

    await waitFor(() => {
      const planRow = view.container.querySelector('[data-slash-command-row="plan-mode"]');
      if (!planRow) throw new Error("Expected Plan slash command row.");
      expect(Boolean(planRow.textContent?.includes("Switch to plan mode"))).toBe(true);
    });

    await keyDownComposer(view, { key: "Enter" });

    expect(selectedModes[0]).toBe("plan");
    view.unmount();

    const offView = await renderComposer(
      {
        selectedCollaborationMode: "plan",
        composerIntent: {
          prompt: "/plan",
          focusNonce: 2,
        },
      },
      {
        onCollaborationModeChange: (mode) => {
          selectedModes.push(mode);
        },
      },
    );

    await waitFor(() => {
      const planRow = offView.container.querySelector('[data-slash-command-row="plan-mode"]');
      if (!planRow) throw new Error("Expected Plan slash command row.");
      expect(Boolean(planRow.textContent?.includes("Switch off plan mode"))).toBe(true);
    });

    await keyDownComposer(offView, { key: "Enter" });
    await settleAsyncRender();

    expect(selectedModes[1]).toBe("default");
    offView.unmount();
  });

  test("slash Goal command activates goal mode chip and placeholder", async () => {
    resetStorage();
    const view = await renderComposer({
      composerIntent: {
        prompt: "/goal",
        focusNonce: 1,
      },
    });

    await waitFor(() => {
      const goalRow = view.container.querySelector('[data-slash-command-row="goal"]');
      if (!goalRow) throw new Error("Expected Goal slash command row.");
      expect(
        Boolean(goalRow.textContent?.includes("Set a goal that Nodex will keep working towards")),
      ).toBe(true);
    });

    await keyDownComposer(view, { key: "Enter" });

    await waitFor(() => {
      const placeholder = view.container.querySelector<HTMLElement>(
        '[data-placeholder="Describe your goal, define measurable outcomes for best results"]',
      );
      if (!placeholder) {
        throw new Error("Expected Goal mode placeholder.");
      }
      expect(placeholder.classList.contains("placeholder")).toBe(true);
    });

    const goalButton = view.getByLabelText("Clear goal");
    expect(Boolean(goalButton.textContent?.includes("Goal"))).toBe(true);

    await act(async () => {
      fireEvent.click(goalButton);
      await Promise.resolve();
    });

    expect(view.queryByLabelText("Clear goal") === null).toBe(true);
  });

  test("saved thread goal renders a footer chip that clears the persisted goal", async () => {
    resetStorage();
    const baseConversation = buildModel().conversation;
    if (!baseConversation) {
      throw new Error("Expected the base conversation fixture.");
    }

    const clearCalls: string[] = [];
    const view = await renderComposer(
      {
        conversation: {
          ...baseConversation,
          threadGoal: buildThreadGoal({
            objective: "Keep working until the thread is idle-clean.",
            status: "paused",
          }),
        },
      },
      {
        onClearThreadGoal: async (threadId) => {
          clearCalls.push(threadId);
        },
      },
    );

    await waitFor(() => {
      const placeholder = view.container.querySelector<HTMLElement>(
        '[data-placeholder="Ask for follow-up changes"]',
      );
      if (!placeholder) {
        throw new Error("Expected the normal follow-up placeholder for a saved goal.");
      }
      expect(Boolean(view.getByLabelText("Clear goal").textContent?.includes("Goal"))).toBe(true);
    });

    await act(async () => {
      fireEvent.click(view.getByLabelText("Clear goal"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(clearCalls.length).toBe(1);
    });
    expect(clearCalls[0]).toBe("thread_1");
  });

  test("slash Goal prompt submits an active thread goal instead of a normal prompt", async () => {
    resetStorage();
    const sentPrompts: string[] = [];
    const setGoalCalls: string[] = [];
    const view = await renderComposer(
      {
        composerIntent: {
          prompt: "/goal Keep refining the migration until tests pass",
          focusNonce: 1,
        },
      },
      {
        onSendPrompt: async (prompt) => {
          sentPrompts.push(prompt);
        },
        onSetThreadGoal: async (input) => {
          setGoalCalls.push(JSON.stringify(input));
          return null;
        },
      },
    );

    await submitCurrentComposerDraft(view);

    await waitFor(() => {
      expect(setGoalCalls.length).toBe(1);
    });
    expect(setGoalCalls[0]).toBe(
      '{"threadId":"thread_1","objective":"Keep refining the migration until tests pass","status":"active"}',
    );
    expect(sentPrompts.length).toBe(0);
  });

  test("slash Goal prompt starts a new thread with a thread goal draft", async () => {
    resetStorage();
    const sentPrompts: string[] = [];
    const setGoalCalls: string[] = [];
    const startThreadCalls: string[] = [];
    const view = await renderComposer(
      {
        threadId: null,
        conversation: null,
        isNewThreadTab: true,
        newThreadTarget: {
          projectId: "project_1",
          projectName: "Nodex",
          sessionId: "session_1",
          threadTitle: "New thread",
          runInTarget: "localProject",
        },
        composerIntent: {
          prompt: "/goal Keep refining the migration until tests pass",
          focusNonce: 1,
        },
      },
      {
        onSendPrompt: async (prompt) => {
          sentPrompts.push(prompt);
        },
        onSetThreadGoal: async (input) => {
          setGoalCalls.push(JSON.stringify(input));
          return null;
        },
        onStartThreadForSession: async (input) => {
          startThreadCalls.push(JSON.stringify(input));
        },
      },
    );

    await submitCurrentComposerDraft(view);

    await waitFor(() => {
      expect(startThreadCalls.length).toBe(1);
    });
    expect(startThreadCalls[0]).toBe(
      '{"projectId":"project_1","sessionId":"session_1","prompt":"Keep refining the migration until tests pass","threadGoalDraft":{"objective":"Keep refining the migration until tests pass","imageAttachments":[],"pastedTextAttachments":[]},"threadGoalMaterializedDraft":{"objective":"Keep refining the migration until tests pass","attachmentDirectory":null},"runInTarget":"localProject"}',
    );
    expect(setGoalCalls.length).toBe(0);
    expect(sentPrompts.length).toBe(0);
  });

  test("restores a failed New Chat goal admission for an explicit retry", async () => {
    resetStorage();
    let rejectStart!: (error: Error) => void;
    const firstStart = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    let startCount = 0;
    const errors: string[] = [];
    const view = await renderComposer(
      {
        threadId: null,
        conversation: null,
        isNewThreadTab: true,
        newThreadTarget: {
          projectId: "project_1",
          projectName: "Nodex",
          sessionId: "session_1",
          threadTitle: "New thread",
          runInTarget: "localProject",
        },
        composerIntent: {
          prompt: "/goal Keep retry semantics explicit",
          focusNonce: 1,
        },
      },
      {
        onStartThreadForSession: async () => {
          startCount += 1;
          if (startCount === 1) await firstStart;
        },
      },
      undefined,
      (message) => {
        if (message) errors.push(message);
      },
    );

    await submitCurrentComposerDraft(view);
    await waitFor(() => expect(readComposerText(view)).toBe(""));

    await act(async () => {
      rejectStart(new Error("Goal start failed"));
      await firstStart.catch(() => undefined);
      await Promise.resolve();
    });
    await waitFor(() => expect(readComposerText(view)).toBe("Keep retry semantics explicit"));
    expect(errors).toContain("Goal start failed");

    await submitCurrentComposerDraft(view);
    await waitFor(() => expect(startCount).toBe(2));
  });

  test("new-worktree Goal keeps pasted text and images raw until the pending worktree is ready", async () => {
    resetStorage();
    const startThreadCalls: unknown[] = [];
    const materializeCalls: unknown[] = [];
    const view = await renderComposer(
      {
        threadId: null,
        conversation: null,
        isNewThreadTab: true,
        newThreadTarget: {
          projectId: "project_1",
          projectName: "Nodex",
          sessionId: "session_1",
          threadTitle: "New thread",
          runInTarget: "newWorktree",
        },
        composerIntent: {
          prompt: "/goal Keep the worktree goal alive",
          focusNonce: 1,
          promptInput: {
            text: "/goal Keep the worktree goal alive",
            images: [
              {
                source: "data:image/png;base64,aW1hZ2U=",
                caption: "diagram.png",
              },
            ],
            textAttachments: [
              {
                file: {
                  label: "Pasted text.txt",
                  path: "/attachments/goal/pasted-text.txt",
                  fsPath: "/attachments/goal/pasted-text.txt",
                },
                preview: "Pasted requirements",
                characterCount: 19,
              },
            ],
          },
        },
      },
      {
        onStartThreadForSession: async (input) => {
          startThreadCalls.push(input);
        },
      },
      async (channel, ...args) => {
        if (channel === "codex:thread:goal:materialize-draft") {
          materializeCalls.push(args[0]);
        }
        return undefined;
      },
    );

    await submitCurrentComposerDraft(view);

    await waitFor(() => {
      expect(startThreadCalls.length).toBe(1);
    });
    const start = startThreadCalls[0] as {
      prompt?: string;
      runInTarget?: string;
      threadGoalDraft?: {
        objective?: string;
        imageAttachments?: unknown[];
        pastedTextAttachments?: unknown[];
      };
    };
    expect(materializeCalls.length).toBe(0);
    expect(start.prompt).toBe("Keep the worktree goal alive");
    expect(start.runInTarget).toBe("newWorktree");
    expect(JSON.stringify(start.threadGoalDraft)).toBe(
      JSON.stringify({
        objective: "Keep the worktree goal alive",
        imageAttachments: [
          {
            src: "data:image/png;base64,aW1hZ2U=",
            localPath: null,
            filename: "diagram.png",
          },
        ],
        pastedTextAttachments: [
          {
            file: {
              label: "Pasted text.txt",
              path: "/attachments/goal/pasted-text.txt",
              fsPath: "/attachments/goal/pasted-text.txt",
            },
            preview: "Pasted requirements",
            characterCount: 19,
          },
        ],
      }),
    );
    expect(
      Object.prototype.hasOwnProperty.call(start.threadGoalDraft ?? {}, "attachmentDirectory"),
    ).toBe(false);
  });

  test("local-project Goal still materializes pasted text and images before starting", async () => {
    resetStorage();
    const startThreadCalls: unknown[] = [];
    const materializeCalls: unknown[] = [];
    const view = await renderComposer(
      {
        threadId: null,
        conversation: null,
        isNewThreadTab: true,
        newThreadTarget: {
          projectId: "project_1",
          projectName: "Nodex",
          sessionId: "session_1",
          threadTitle: "New thread",
          runInTarget: "localProject",
        },
        composerIntent: {
          prompt: "/goal Keep the local goal alive",
          focusNonce: 1,
          promptInput: {
            text: "/goal Keep the local goal alive",
            images: [
              {
                source: "data:image/png;base64,aW1hZ2U=",
                caption: "diagram.png",
              },
            ],
            textAttachments: [
              {
                file: {
                  label: "Pasted text.txt",
                  path: "/attachments/goal/pasted-text.txt",
                  fsPath: "/attachments/goal/pasted-text.txt",
                },
                preview: "Pasted requirements",
                characterCount: 19,
              },
            ],
          },
        },
      },
      {
        onStartThreadForSession: async (input) => {
          startThreadCalls.push(input);
        },
      },
      async (channel, ...args) => {
        if (channel !== "codex:thread:goal:materialize-draft") return undefined;
        materializeCalls.push(args[0]);
        return {
          objective: "Materialized local objective",
          attachmentDirectory: "/tmp/materialized-goal",
        };
      },
    );

    await submitCurrentComposerDraft(view);

    await waitFor(() => {
      expect(startThreadCalls.length).toBe(1);
    });
    const start = startThreadCalls[0] as {
      prompt?: string;
      threadGoalDraft?: unknown;
      threadGoalMaterializedDraft?: unknown;
    };
    expect(materializeCalls.length).toBe(1);
    expect(JSON.stringify(materializeCalls[0])).toBe(
      JSON.stringify({
        objective: "Keep the local goal alive",
        imageAttachments: [
          {
            src: "data:image/png;base64,aW1hZ2U=",
            localPath: null,
            filename: "diagram.png",
          },
        ],
        pastedTextAttachments: [
          {
            file: {
              label: "Pasted text.txt",
              path: "/attachments/goal/pasted-text.txt",
              fsPath: "/attachments/goal/pasted-text.txt",
            },
            preview: "Pasted requirements",
            characterCount: 19,
          },
        ],
      }),
    );
    expect(start.prompt).toBe("Materialized local objective");
    expect(JSON.stringify(start.threadGoalDraft)).toBe(
      JSON.stringify({
        objective: "Keep the local goal alive",
        imageAttachments: [
          {
            src: "data:image/png;base64,aW1hZ2U=",
            localPath: null,
            filename: "diagram.png",
          },
        ],
        pastedTextAttachments: [
          {
            file: {
              label: "Pasted text.txt",
              path: "/attachments/goal/pasted-text.txt",
              fsPath: "/attachments/goal/pasted-text.txt",
            },
            preview: "Pasted requirements",
            characterCount: 19,
          },
        ],
      }),
    );
    expect(JSON.stringify(start.threadGoalMaterializedDraft)).toBe(
      JSON.stringify({
        objective: "Materialized local objective",
        attachmentDirectory: "/tmp/materialized-goal",
      }),
    );
  });

  test("empty goal mode submit clears goal mode without sending a prompt", async () => {
    resetStorage();
    const sentPrompts: string[] = [];
    const setGoalCalls: string[] = [];
    const view = await renderComposer(
      {
        composerIntent: {
          prompt: "/goal",
          focusNonce: 1,
        },
      },
      {
        onSendPrompt: async (prompt) => {
          sentPrompts.push(prompt);
        },
        onSetThreadGoal: async (input) => {
          setGoalCalls.push(JSON.stringify(input));
          return null;
        },
      },
    );

    await waitFor(() => {
      const goalRow = view.container.querySelector('[data-slash-command-row="goal"]');
      if (!goalRow) throw new Error("Expected Goal slash command row.");
      expect(
        Boolean(goalRow.textContent?.includes("Set a goal that Nodex will keep working towards")),
      ).toBe(true);
    });

    await keyDownComposer(view, { key: "Enter" });

    await waitFor(() => {
      expect(view.queryByLabelText("Clear goal") !== null).toBe(true);
    });

    await keyDownComposer(view, { key: "Enter" }, { waitForContent: false });

    await waitFor(() => {
      expect(view.queryByLabelText("Clear goal") === null).toBe(true);
    });
    expect(setGoalCalls.length).toBe(0);
    expect(sentPrompts.length).toBe(0);
  });

  test("different saved goal opens replacement confirmation before setting", async () => {
    resetStorage();
    const baseConversation = buildModel().conversation;
    if (!baseConversation) {
      throw new Error("Expected the base conversation fixture.");
    }

    const setGoalCalls: string[] = [];
    const view = await renderComposer(
      {
        conversation: {
          ...baseConversation,
          threadGoal: buildThreadGoal({ objective: "Keep the old goal" }),
        },
        composerIntent: {
          prompt: "/goal Replace with the current composer objective",
          focusNonce: 1,
        },
      },
      {
        onSetThreadGoal: async (input) => {
          setGoalCalls.push(JSON.stringify(input));
          return null;
        },
      },
    );

    await submitCurrentComposerDraft(view);

    await waitFor(() => {
      expect(Boolean(view.getByText("Replace current goal?"))).toBe(true);
    });
    expect(Boolean(view.getByText("Replace with the current composer objective"))).toBe(true);
    expect(setGoalCalls.length).toBe(0);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Cancel" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.queryByText("Replace current goal?") === null).toBe(true);
    });
    expect(setGoalCalls.length).toBe(0);
  });

  test("replacement confirmation submit replaces the saved goal", async () => {
    resetStorage();
    const baseConversation = buildModel().conversation;
    if (!baseConversation) {
      throw new Error("Expected the base conversation fixture.");
    }

    const sentPrompts: string[] = [];
    const setGoalCalls: string[] = [];
    const actions = buildActions({
      onSendPrompt: async (prompt) => {
        sentPrompts.push(prompt);
      },
      onSetThreadGoal: async (input) => {
        setGoalCalls.push(JSON.stringify(input));
        return null;
      },
    });
    const conversation = {
      ...baseConversation,
      threadGoal: buildThreadGoal({ objective: "Keep the old goal" }),
    };
    const view = await renderComposer(
      {
        conversation,
        composerIntent: {
          prompt: "/goal Replace with the current composer objective",
          focusNonce: 1,
        },
      },
      actions,
    );

    await submitCurrentComposerDraft(view);

    await waitFor(() => {
      expect(Boolean(view.getByText("Replace current goal?"))).toBe(true);
    });

    await act(async () => {
      view.rerender(
        <AppProviders>
          <TestComposerScopePath>
            <ThreadComposer
              model={buildModel({
                conversation,
                composerIntent: {
                  prompt: "/goal A newer draft that must not replace the captured confirmation",
                  focusNonce: 2,
                },
              })}
              actions={actions}
              errorMessage={null}
              onErrorMessage={() => {}}
            />
          </TestComposerScopePath>
        </AppProviders>,
      );
      await Promise.resolve();
    });
    await settleComposerFrame();
    expect(readComposerText(view)).toBe(
      "/goal A newer draft that must not replace the captured confirmation",
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Replace goal" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(setGoalCalls.length).toBe(1);
    });
    expect(setGoalCalls[0]).toBe(
      '{"threadId":"thread_1","objective":"Replace with the current composer objective","status":"active"}',
    );
    expect(sentPrompts.length).toBe(0);
    await waitFor(() => {
      expect(view.queryByText("Replace current goal?") === null).toBe(true);
    });
    await waitFor(() => expect(readComposerText(view)).toBe(""));
  });

  test("keeps slash menu scroll position stable across hover and item recompute", async () => {
    resetStorage();
    const elementPrototype = HTMLElement.prototype as unknown as {
      scrollIntoView?: (options?: unknown) => void;
    };
    const originalScrollIntoView = elementPrototype.scrollIntoView;
    let scrollIntoViewCalls = 0;

    elementPrototype.scrollIntoView = function scrollIntoViewMock(this: HTMLElement) {
      scrollIntoViewCalls += 1;
      const list = this.parentElement?.parentElement;
      if (list instanceof HTMLElement) {
        list.scrollTop = 0;
      }
    };

    try {
      const initialModel = buildModel({
        composerIntent: {
          prompt: "/",
          focusNonce: 1,
        },
      });
      const view = await renderComposer(initialModel);
      const modelRow = await waitFor(() => {
        const row = view.container.querySelector('[data-slash-command-row="model"]');
        if (!(row instanceof HTMLElement)) throw new Error("Expected Model slash command row.");
        return row;
      });
      const compactRow = view.container.querySelector('[data-slash-command-row="compact"]');
      const list = modelRow.parentElement?.parentElement;
      if (!(compactRow instanceof HTMLElement) || !(list instanceof HTMLElement)) {
        throw new Error("Expected slash command list rows.");
      }

      scrollIntoViewCalls = 0;
      list.scrollTop = 180;
      await act(async () => {
        fireEvent.mouseMove(modelRow);
        await Promise.resolve();
      });

      expect(scrollIntoViewCalls).toBe(0);
      expect(list.scrollTop).toBe(180);
      expect(modelRow.getAttribute("aria-selected")).toBe("true");

      scrollIntoViewCalls = 0;
      list.scrollTop = 180;
      await act(async () => {
        view.rerender(
          <AppProviders>
            <TestComposerScopePath>
              <ThreadComposer
                model={buildModel({
                  composerIntent: {
                    prompt: "/",
                    focusNonce: 1,
                  },
                  selectedModel: "gpt-5.5",
                })}
                actions={buildActions()}
                errorMessage={null}
                onErrorMessage={() => {}}
              />
            </TestComposerScopePath>
          </AppProviders>,
        );
        await Promise.resolve();
      });
      await settleComposerFrame();

      const nextModelRow = view.container.querySelector('[data-slash-command-row="model"]');
      const nextCompactRow = view.container.querySelector('[data-slash-command-row="compact"]');
      if (!(nextModelRow instanceof HTMLElement) || !(nextCompactRow instanceof HTMLElement)) {
        throw new Error("Expected slash command rows after rerender.");
      }

      expect(scrollIntoViewCalls).toBe(0);
      expect(list.scrollTop).toBe(180);
      expect(nextModelRow.getAttribute("aria-selected")).toBe("true");
      expect(nextCompactRow.getAttribute("aria-selected")).toBe("false");
    } finally {
      if (originalScrollIntoView) {
        elementPrototype.scrollIntoView = originalScrollIntoView;
      } else {
        delete elementPrototype.scrollIntoView;
      }
    }
  });

  test("filters slash commands and selects Fast from the inline menu", async () => {
    resetStorage();
    const view = await renderComposer({
      composerIntent: {
        prompt: "/fa",
        focusNonce: 1,
      },
    });

    await waitFor(() => {
      const fastRow = view.container.querySelector('[data-slash-command-row="service-tier:fast"]');
      if (!(fastRow instanceof HTMLElement)) throw new Error("Expected Fast slash command row.");
      expect(Boolean(view.container.textContent?.includes("Compact"))).toBe(false);
    });

    const fastRow = view.container.querySelector('[data-slash-command-row="service-tier:fast"]');
    if (!(fastRow instanceof HTMLElement)) {
      throw new Error("Expected Fast slash command row.");
    }

    await act(async () => {
      fireEvent.click(fastRow);
      await Promise.resolve();
    });

    expect(localStorageRef.getItem("nodex-codex-default-service-tier-v1")).toBe("fast");
    expect(view.container.querySelector('[data-slash-command-menu="true"]') === null).toBe(true);
  });

  test("runs the Compact slash command through the thread action boundary", async () => {
    resetStorage();
    const compactedThreadIds: string[] = [];
    const view = await renderComposer(
      {
        composerIntent: {
          prompt: "/compact",
          focusNonce: 1,
        },
      },
      {
        onCompactThread: async (threadId) => {
          compactedThreadIds.push(threadId);
        },
      },
    );

    const compactRow = await waitFor(() => {
      const row = view.container.querySelector('[data-slash-command-row="compact"]');
      if (!(row instanceof HTMLElement)) throw new Error("Expected Compact slash command row.");
      return row;
    });

    await act(async () => {
      fireEvent.click(compactRow);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(compactedThreadIds[0]).toBe("thread_1");
    });
  });

  test("opens nested Model content and selects a model from the slash menu", async () => {
    resetStorage();
    const selectedModels: string[] = [];
    const view = await renderComposer(
      {
        composerIntent: {
          prompt: "/model",
          focusNonce: 1,
        },
      },
      {
        onModelChange: (model) => {
          selectedModels.push(model);
        },
      },
    );

    const modelRow = await waitFor(() => {
      const row = view.container.querySelector('[data-slash-command-row="model"]');
      if (!(row instanceof HTMLElement)) throw new Error("Expected Model slash command row.");
      return row;
    });

    await act(async () => {
      fireEvent.click(modelRow);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(Boolean(view.container.textContent?.includes("GPT-5.5"))).toBe(true);
    });

    const nextModelButton = Array.from(view.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("GPT-5.5"),
    );
    if (!(nextModelButton instanceof HTMLElement)) {
      throw new Error("Expected GPT-5.5 model option.");
    }

    await act(async () => {
      fireEvent.click(nextModelButton);
      await Promise.resolve();
    });

    expect(selectedModels[0]).toBe("gpt-5.5");
  });

  test("places permissions and context inside the existing-thread composer footer without a lower status row", async () => {
    resetStorage();
    const invokedChannels: string[] = [];
    const view = await renderComposer(undefined, undefined, async (channel) => {
      invokedChannels.push(channel);
      return undefined;
    });

    const permissionTrigger = view.getByLabelText("Change permissions");
    const contextTrigger = view.getByLabelText(/Context window/);
    const lowerStatusRow = view.container.querySelector('[data-composer-lower-status-row="true"]');
    const formFooter = view.container.querySelector('[data-composer-form-footer="true"]');

    expect(formFooter !== null).toBe(true);
    expect(lowerStatusRow === null).toBe(true);
    expect(formFooter?.contains(permissionTrigger)).toBe(true);
    expect(formFooter?.contains(contextTrigger)).toBe(true);
    expect(invokedChannels.some((channel) => channel.startsWith("git:branch:"))).toBe(false);
  });

  test("places the new-chat project selector in the lower status row before run target", async () => {
    resetStorage();
    const view = await renderComposer(
      {
        conversation: null,
        isNewThreadTab: true,
        newThreadTarget: {
          projectId: "project_1",
          projectName: "Nodex",
          sessionId: "session_1",
          threadTitle: "New thread",
          runInTarget: "localProject",
        },
        newThreadProjectSelector: {
          selectedProjectId: "project_1",
          disabled: false,
          canAddProject: true,
          projects: [
            {
              id: "project_1",
              label: "Nodex",
              appearance: { color: "green", marker: { kind: "icon", icon: "plant" } },
              description: "/tmp/project",
              primaryWorkspaceRoot: "/tmp/project",
              searchText: "project_1 nodex /tmp/project",
            },
            {
              id: "project_2",
              label: "Devtools Codex",
              appearance: { color: "blue", marker: { kind: "icon", icon: "function" } },
              description: "/tmp/devtools-codex",
              primaryWorkspaceRoot: "/tmp/devtools-codex",
              searchText: "project_2 devtools codex /tmp/devtools-codex",
            },
          ],
        },
      },
      {
        onNewThreadProjectChange: () => {},
        onRequestNewChatProjectCreate: () => {},
      },
    );

    const projectSelector = view.getByLabelText("Select project");
    const lowerStatusRow = view.container.querySelector<HTMLElement>(
      '[data-composer-lower-status-row="true"]',
    );
    const externalFooterSlot = view.container.querySelector<HTMLElement>(
      '[data-composer-external-footer-slot="true"]',
    );
    const formFooter = view.container.querySelector<HTMLElement>(
      '[data-composer-form-footer="true"]',
    );
    const composerSurface = view.container.querySelector<HTMLElement>(".composer-surface-chrome");
    const composerFrame = composerSurface?.parentElement;
    const lowerText = lowerStatusRow?.textContent ?? "";

    expect(lowerStatusRow !== null).toBe(true);
    expect(externalFooterSlot !== null).toBe(true);
    expect(formFooter !== null).toBe(true);
    expect(externalFooterSlot?.contains(lowerStatusRow)).toBe(true);
    expect(composerFrame?.previousElementSibling === externalFooterSlot).toBe(true);
    expect(lowerStatusRow?.contains(projectSelector)).toBe(true);
    expect(formFooter?.contains(projectSelector)).toBe(false);
    expect(lowerText.indexOf("Nodex") >= 0).toBe(true);
    expect(lowerText.indexOf("Work locally") >= 0).toBe(true);
    expect(lowerText.indexOf("Nodex") < lowerText.indexOf("Work locally")).toBe(true);
  });

  test("hides the lower status row after a new-chat tab materializes a conversation", async () => {
    resetStorage();
    const view = await renderComposer({
      isNewThreadTab: true,
      newThreadTarget: {
        projectId: "project_1",
        projectName: "Nodex",
        sessionId: "session_1",
        threadTitle: "New thread",
        runInTarget: "localProject",
      },
    });

    const lowerStatusRow = view.container.querySelector('[data-composer-lower-status-row="true"]');
    const externalFooterSlot = view.container.querySelector(
      '[data-composer-external-footer-slot="true"]',
    );
    const formFooter = view.container.querySelector('[data-composer-form-footer="true"]');

    expect(formFooter !== null).toBe(true);
    expect(lowerStatusRow === null).toBe(true);
    expect(externalFooterSlot === null).toBe(true);
  });

  test("keeps prompt scrolling owned by the ProseMirror prompt editor", async () => {
    resetStorage();
    const longPrompt = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
    const view = await renderComposer({
      composerIntent: {
        prompt: longPrompt,
        focusNonce: 1,
      },
    });
    const composer = view.container.querySelector<HTMLElement>('[data-codex-composer="true"]');
    const composerSurface = view.container.querySelector<HTMLElement>(".composer-surface-chrome");
    const promptFrame = view.container.querySelector<HTMLElement>(
      '[data-composer-prompt-frame="true"]',
    );
    const editorScrollContainer = composer?.parentElement;
    const attachmentStrip = view.container.querySelector<HTMLElement>(
      '[data-composer-attachments="true"]',
    );
    const formFooter = view.container.querySelector<HTMLElement>(
      '[data-composer-form-footer="true"]',
    );
    const inputSlot = formFooter?.querySelector<HTMLElement>('[data-composer-input-slot="true"]');
    const leadingSlot = formFooter?.querySelector<HTMLElement>(
      '[data-composer-footer-leading="true"]',
    );
    const trailingSlot = formFooter?.querySelector<HTMLElement>(
      '[data-composer-footer-trailing="true"]',
    );

    expect(composer !== null).toBe(true);
    expect(composer?.classList.contains("ProseMirror") ?? false).toBe(true);
    expect(composer?.getAttribute("contenteditable")).toBe("true");
    expect(composer?.getAttribute("data-virtualkeyboard")).toBe("true");
    expect(composer?.getAttribute("translate")).toBe("no");
    expect(composer?.getAttribute("spellcheck")).toBe("true");
    expect(Boolean(composer?.getAttribute("style")?.includes("min-height: 2.75rem"))).toBe(true);
    expect(promptFrame !== null).toBe(true);
    expect(promptFrame?.contains(composer)).toBe(true);
    expect(promptFrame?.classList.contains("text-size-chat") ?? false).toBe(true);
    expect(promptFrame?.classList.contains("text-base") ?? false).toBe(true);
    expect(composerSurface !== null).toBe(true);
    expect(composerSurface?.tagName).toBe("DIV");
    expect(composerSurface?.classList.contains("_multilineSurface_1u8sk_2") ?? false).toBe(true);
    expect(attachmentStrip?.classList.contains("_attachmentsDefault_1u8sk_2") ?? false).toBe(true);
    expect(attachmentStrip?.classList.contains("empty:hidden") ?? true).toBe(false);
    expect(formFooter?.classList.contains("_footer_1u8sk_2") ?? false).toBe(true);
    expect(formFooter?.getAttribute("data-composer-layout")).toBe("multiline");
    expect(inputSlot?.getAttribute("data-composer-footer-row")).toBe("prompt");
    expect(inputSlot?.contains(promptFrame ?? null)).toBe(true);
    expect(leadingSlot?.getAttribute("data-composer-footer-row")).toBe("controls");
    expect(trailingSlot?.getAttribute("data-composer-footer-row")).toBe("controls");
    expect(editorScrollContainer).toBe(promptFrame);
    expect(promptFrame?.contains(leadingSlot ?? null)).toBe(false);
    expect(promptFrame?.contains(trailingSlot ?? null)).toBe(false);
  });

  test("renders the Codex new-chat placeholder inside the ProseMirror document", async () => {
    resetStorage();
    const view = await renderComposer({
      threadId: null,
      conversation: null,
      isNewThreadTab: true,
      newThreadTarget: {
        projectId: "project_1",
        projectName: "Nodex",
        sessionId: "session_1",
        threadTitle: "New thread",
        runInTarget: "localProject",
      },
      body: {
        threadId: null,
        turnCount: 0,
        isThreadRunning: false,
        activeTurnId: null,
        latestTurnId: null,
        emptyState: { type: "newThread", title: "Start a new thread", description: "" },
        showThreadStartProgressPanel: false,
      },
    });
    const composer = view.container.querySelector<HTMLElement>('[data-codex-composer="true"]');

    expect(composer !== null).toBe(true);
    await waitFor(() => {
      const placeholder = view.container.querySelector<HTMLElement>(
        '[data-placeholder="Do anything"]',
      );
      if (!placeholder) {
        throw new Error("Expected Codex placeholder.");
      }
      expect(placeholder.classList.contains("placeholder")).toBe(true);
    });
  });

  test("keeps the selector anchored while controlled thread intelligence updates", async () => {
    resetStorage();
    const view = await renderControlledThreadIntelligenceComposer();
    const trigger = view.getByLabelText("Select model");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByLabelText("Model GPT-5.5"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(within(view.container.ownerDocument.body).getByText("GPT-5.3 Codex"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(trigger.textContent?.includes("5.3")).toBe(true);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });
    const visibleModelLabels = Array.from(
      view.container.ownerDocument.body.querySelectorAll<HTMLElement>(
        '[data-slot="dropdown-item"]',
      ),
    )
      .map((item) => item.textContent?.trim())
      .filter((label) => label === "GPT-5.5" || label === "GPT-5.3 Codex");
    expect(visibleModelLabels).toEqual(["GPT-5.3 Codex", "GPT-5.5"]);

    await act(async () => {
      fireEvent.click(view.getByLabelText("Effort High"));
      await Promise.resolve();
    });
    await act(async () => {
      const mediumOption = within(view.container.ownerDocument.body)
        .getAllByText("Medium")
        .map((node) => node.closest<HTMLElement>('[role="menuitem"]'))
        .find((node): node is HTMLElement => node !== null);
      if (!mediumOption) throw new Error("Expected the Medium effort option.");
      fireEvent.click(mediumOption);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(trigger.textContent?.includes("Medium")).toBe(true);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });
  });

  test("model selector preserves model and effort submenus", async () => {
    resetStorage();
    const selectedModels: string[] = [];
    const selectedReasoning: string[] = [];
    const modelView = await renderComposer(undefined, {
      onModelChange: (model) => {
        selectedModels.push(model);
      },
    });

    const trigger = modelView.getByLabelText("Select model");
    expect(Boolean(trigger.textContent?.includes("5.3"))).toBe(true);
    expect(Boolean(trigger.textContent?.includes("High"))).toBe(true);

    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });

    expect(modelView.getByLabelText("Model GPT-5.3 Codex")).toBeTruthy();
    expect(modelView.getByLabelText("Effort High")).toBeTruthy();
    expect(modelView.getByLabelText("Speed Standard")).toBeTruthy();

    const modelTrigger = modelView.getByLabelText("Model GPT-5.3 Codex");

    await act(async () => {
      fireEvent.click(modelTrigger);
      await Promise.resolve();
    });

    const modelItem = Array.from(
      modelView.container.ownerDocument.body.querySelectorAll('[data-slot="dropdown-item"]'),
    ).find((node) => node.textContent?.includes("GPT-5.5"));
    if (!(modelItem instanceof HTMLElement)) {
      throw new Error("Expected the Model flyout to include GPT-5.5.");
    }

    await act(async () => {
      fireEvent.click(modelItem);
      await Promise.resolve();
    });

    expect(selectedModels[0]).toBe("gpt-5.5");
    modelView.unmount();

    const reasoningView = await renderComposer(undefined, {
      onReasoningEffortChange: (reasoningEffort) => {
        selectedReasoning.push(reasoningEffort);
      },
    });
    const reasoningTrigger = reasoningView.getByLabelText("Select model");

    await act(async () => {
      fireEvent.pointerDown(reasoningTrigger, { button: 0, ctrlKey: false });
      fireEvent.click(reasoningTrigger);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(reasoningView.getByLabelText("Effort High"));
      await Promise.resolve();
    });

    const nextMenuItems = Array.from(
      reasoningView.container.ownerDocument.body.querySelectorAll('[data-slot="dropdown-item"]'),
    );
    const reasoningItem = nextMenuItems.find((node) => node.textContent?.includes("Medium"));
    if (!(reasoningItem instanceof HTMLElement)) {
      throw new Error("Expected the Effort submenu to include Medium reasoning.");
    }

    await act(async () => {
      fireEvent.click(reasoningItem);
      await Promise.resolve();
    });

    expect(selectedReasoning[0]).toBe("medium");
  });

  test("uses one provider-neutral selector for heterogeneous model catalogs", async () => {
    resetStorage();
    const reasoningEfforts = ["low", "medium", "high", "xhigh", "ultra"] as const;
    const view = await renderComposer({
      selectedModel: "gpt-5.6-sol",
      selectedReasoningEffort: "high",
      availableModels: [
        {
          id: "gpt-5.6-terra",
          model: "gpt-5.6-terra",
          displayName: "GPT-5.6 Terra",
          description: "Efficient reasoning for everyday work.",
          hidden: false,
          isDefault: false,
          defaultReasoningEffort: "low",
          inputModalities: ["text", "image"],
          multiAgentVersion: "v2",
          serviceTiers: [],
          defaultServiceTier: null,
          supportedReasoningEfforts: reasoningEfforts.slice(0, 4).map((reasoningEffort) => ({
            reasoningEffort,
            description: "",
          })),
        },
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          description: "Frontier reasoning for demanding work.",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "low",
          inputModalities: ["text", "image"],
          multiAgentVersion: "v2",
          serviceTiers: [],
          defaultServiceTier: null,
          supportedReasoningEfforts: reasoningEfforts.map((reasoningEffort) => ({
            reasoningEffort,
            description: "",
          })),
        },
      ],
    });

    const trigger = view.getByLabelText("Select model");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });

    expect(view.getByLabelText("Model GPT-5.6 Sol")).toBeTruthy();
    expect(view.getByLabelText("Effort High")).toBeTruthy();
    expect(view.getByLabelText("Speed Standard")).toBeTruthy();
  });

  test("selecting a model coerces unsupported reasoning to that model's supported default", async () => {
    resetStorage();
    const selectedModels: string[] = [];
    const selectedReasoning: string[] = [];
    const view = await renderComposer(
      {
        selectedReasoningEffort: "medium",
      },
      {
        onModelChange: (model) => {
          selectedModels.push(model);
        },
        onReasoningEffortChange: (reasoningEffort) => {
          selectedReasoning.push(reasoningEffort);
        },
      },
    );

    const trigger = view.getByLabelText("Select model");

    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });

    const modelTrigger = Array.from(
      view.container.ownerDocument.body.querySelectorAll('[data-slot="dropdown-submenu-trigger"]'),
    ).find((node) => node.textContent?.includes("GPT-5.3 Codex"));
    if (!(modelTrigger instanceof HTMLElement)) {
      throw new Error("Expected the model selector to include the current model row.");
    }

    await act(async () => {
      fireEvent.click(modelTrigger);
      await Promise.resolve();
    });

    const modelItem = Array.from(
      view.container.ownerDocument.body.querySelectorAll('[data-slot="dropdown-item"]'),
    ).find((node) => node.textContent?.includes("GPT-5.5"));
    if (!(modelItem instanceof HTMLElement)) {
      throw new Error("Expected the Model flyout to include GPT-5.5.");
    }

    await act(async () => {
      fireEvent.click(modelItem);
      await Promise.resolve();
    });

    expect(selectedModels[0]).toBe("gpt-5.5");
    expect(selectedReasoning[0]).toBe("high");
  });

  test("model flyout keeps every model in one concise searchable list", async () => {
    resetStorage();
    const view = await renderComposer({
      selectedModel: "gpt-5.4",
      availableModels: [
        {
          id: "gpt-5.5",
          model: "gpt-5.5",
          displayName: "GPT-5.5",
          description: "Latest Codex model.",
          hidden: false,
          isDefault: false,
          defaultReasoningEffort: "high",
          inputModalities: ["text", "image"],
          multiAgentVersion: null,
          serviceTiers: [],
          defaultServiceTier: null,
          supportedReasoningEfforts: [
            { reasoningEffort: "high", description: "Spend more time reasoning before answering." },
          ],
        },
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          displayName: "GPT-5.3 Codex",
          description: "Previous stable Codex model.",
          hidden: false,
          isDefault: false,
          defaultReasoningEffort: "high",
          inputModalities: ["text", "image"],
          multiAgentVersion: null,
          serviceTiers: [],
          defaultServiceTier: null,
          supportedReasoningEfforts: [
            { reasoningEffort: "high", description: "Spend more time reasoning before answering." },
          ],
        },
        {
          id: "gpt-5.4-mini",
          model: "gpt-5.4-mini",
          displayName: "GPT-5.3 Codex-Mini",
          description: "Small fast Codex model.",
          hidden: false,
          isDefault: false,
          defaultReasoningEffort: "medium",
          inputModalities: ["text", "image"],
          multiAgentVersion: null,
          serviceTiers: [],
          defaultServiceTier: null,
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Balance speed and deeper reasoning." },
          ],
        },
        {
          id: "gpt-5.3-codex-spark",
          model: "gpt-5.3-codex-spark",
          displayName: "GPT-5.3-Codex-Spark",
          description: "Ultra fast Codex model.",
          hidden: false,
          isDefault: false,
          defaultReasoningEffort: "medium",
          inputModalities: ["text", "image"],
          multiAgentVersion: null,
          serviceTiers: [],
          defaultServiceTier: null,
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Balance speed and deeper reasoning." },
          ],
        },
      ],
    });

    const trigger = view.getByLabelText("Select model");

    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });

    const modelTrigger = view.getByLabelText("Model GPT-5.3 Codex");

    await act(async () => {
      fireEvent.click(modelTrigger);
      await Promise.resolve();
    });

    const modelMenu = Array.from(
      view.container.ownerDocument.body.querySelectorAll<HTMLElement>(
        '[data-slot="dropdown-submenu-content"]',
      ),
    ).find((content) => content.textContent?.includes("GPT-5.3 Codex-Mini"));
    if (!modelMenu) throw new Error("Expected the Model flyout content.");
    const modelMenuText = modelMenu.textContent ?? "";
    expect(Boolean(modelMenuText.includes("GPT-5.3 Codex-Mini"))).toBe(true);
    expect(Boolean(modelMenuText.includes("GPT-5.3-Codex-Spark"))).toBe(true);
    expect(Boolean(modelMenuText.includes("Other models"))).toBe(false);
    expect(Boolean(modelMenuText.includes("Latest Codex model"))).toBe(false);
    expect(Boolean(modelMenuText.includes("Previous stable Codex model"))).toBe(false);
    const visibleModelLabels = Array.from(
      modelMenu.querySelectorAll<HTMLElement>('[data-slot="dropdown-item"]'),
    )
      .map((item) => item.textContent?.trim())
      .filter(
        (label) =>
          label === "GPT-5.5" ||
          label === "GPT-5.3 Codex" ||
          label === "GPT-5.3 Codex-Mini" ||
          label === "GPT-5.3-Codex-Spark",
      );
    expect(visibleModelLabels).toEqual([
      "GPT-5.5",
      "GPT-5.3 Codex",
      "GPT-5.3 Codex-Mini",
      "GPT-5.3-Codex-Spark",
    ]);
  });

  test("renders active Plan mode as a direct toggle chip", async () => {
    resetStorage();
    const selectedModes: string[] = [];
    const view = await renderComposer(
      { selectedCollaborationMode: "plan" },
      {
        onCollaborationModeChange: (mode) => {
          selectedModes.push(mode);
        },
      },
    );

    const formFooter = view.container.querySelector('[data-composer-form-footer="true"]');
    const addContextButton = view.getByLabelText("Add files and more");
    const permissionTrigger = view.getByLabelText("Change permissions");
    const planButton = view.getByLabelText("Plan");
    const planAccessoryDivider = formFooter?.querySelector(
      '[data-composer-footer-accessory-divider="true"]',
    );

    expect(formFooter !== null).toBe(true);
    expect(formFooter?.contains(addContextButton)).toBe(true);
    expect(formFooter?.contains(permissionTrigger)).toBe(true);
    expect(formFooter?.contains(planButton)).toBe(true);
    expect(planButton.hasAttribute("aria-haspopup")).toBe(false);
    expect(planButton.getAttribute("data-slot") === "dropdown-trigger").toBe(false);
    expect(planAccessoryDivider !== null).toBe(true);
    expect(
      Boolean(
        addContextButton.compareDocumentPosition(permissionTrigger) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(
      Boolean(
        permissionTrigger.compareDocumentPosition(planButton) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(permissionTrigger.nextElementSibling === planAccessoryDivider).toBe(true);
    expect(planAccessoryDivider?.nextElementSibling === planButton).toBe(true);

    await act(async () => {
      fireEvent.click(planButton);
      await Promise.resolve();
    });

    expect(selectedModes[0]).toBe("default");
  });

  test("keeps an interrupted queue intact until a fresh idle message succeeds", async () => {
    resetStorage();
    let releaseStart!: () => void;
    const heldStart = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startCalls = 0;
    const resolutions: Array<{ revision: number; resolution: "resume" | "clear" }> = [];
    const view = await renderComposer(
      {
        composerIntent: { prompt: "Fresh message", focusNonce: 1 },
        composerShell: {
          ...buildModel().composerShell,
          queuedFollowUpStatus: "ready",
          queuedFollowUpLedgerRevision: 9,
          hasInterruptedQueuedFollowUps: true,
          queuedFollowUpRows: [
            {
              followUpId: "follow-up-paused",
              threadId: "thread_1",
              prompt: "Old queued message",
              promptInput: { text: "Old queued message" },
              displayText: "Old queued message",
              pauseKind: "interrupted",
              pausedReason: "Interrupted before the steer was accepted.",
            },
          ],
        },
      },
      {
        onSendPrompt: async () => {
          startCalls += 1;
          await heldStart;
        },
        onResolveQueuedFollowUpsAfterFreshStart: async (_threadId, revision, resolution) => {
          resolutions.push({ revision, resolution });
          return true;
        },
      },
    );

    await submitCurrentComposerDraft(view);
    expect(view.getByRole("heading", { name: "Send message?" })).not.toBeNull();
    expect(startCalls).toBe(0);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send message" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(startCalls).toBe(1));
    expect(resolutions).toEqual([]);

    await act(async () => {
      releaseStart();
      await heldStart;
      await Promise.resolve();
    });
    await waitFor(() => expect(resolutions).toEqual([{ revision: 9, resolution: "resume" }]));
  });

  test("does not clear a paused queue when the fresh idle request fails", async () => {
    resetStorage();
    const resolutions: string[] = [];
    const view = await renderComposer(
      {
        composerIntent: { prompt: "Fresh message", focusNonce: 1 },
        composerShell: {
          ...buildModel().composerShell,
          queuedFollowUpStatus: "ready",
          queuedFollowUpLedgerRevision: 4,
          hasInterruptedQueuedFollowUps: true,
          queuedFollowUpRows: [
            {
              followUpId: "follow-up-paused",
              threadId: "thread_1",
              prompt: "Old queued message",
              promptInput: { text: "Old queued message" },
              displayText: "Old queued message",
              pauseKind: "interrupted",
              pausedReason: "Interrupted before the steer was accepted.",
            },
          ],
        },
      },
      {
        onSendPrompt: async () => {
          throw new Error("start rejected");
        },
        onResolveQueuedFollowUpsAfterFreshStart: async (_threadId, _revision, resolution) => {
          resolutions.push(resolution);
          return true;
        },
      },
    );

    await submitCurrentComposerDraft(view);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Clear queue" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(readComposerText(view)).toBe("Fresh message"));
    expect(resolutions).toEqual([]);
  });
});
