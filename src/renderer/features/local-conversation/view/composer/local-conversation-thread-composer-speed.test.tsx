import {
  clearBrowserImageDragState,
  publishBrowserImageDragState,
} from "../../../browser-sidebar/browser-image-drag-state";
import { browserImageDragType } from "../../../../../shared/browser/browser-image-drag";
import { deliverBrowserAnnotations } from "../../../browser-sidebar/browser-annotation-delivery";
import { composerDraftIntents, useComposerDraftIntent } from "@/lib/composer-draft-intents";
import { catalogModel } from "@/lib/agent-model-catalog.test-fixtures";
import { buildComposerActions as buildActions } from "@/test/composer-actions-fixture";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { useLayoutEffect, useState } from "react";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { AppProviders } from "@/app-providers";
import {
  __getNodexToastSnapshotForTests,
  __resetNodexToastStoreForTests,
} from "@/components/ui/toast";
import { render, settleAsyncRender } from "@/test/dom";
import { installAsyncRequestAnimationFrame, installWindowApi } from "@/test/browser-globals";
import { clearPersistedAtomStoreForTests } from "@/lib/persisted-atom-store";
import { requestImageEditComposerSubmit } from "@/lib/image-edit-composer-channel";
import { buildRemoveSubmissionIntent } from "@/features/user-attachment-image-editor/model/image-edit-submission";
import {
  consumeBrowserImageAttachments,
  getBrowserImageAttachmentsSnapshot,
  publishBrowserImageAttachment,
} from "@/features/browser-sidebar/browser-image-attachments";
import { NodexModalHost } from "@/lib/modal-registry";
import type { ThreadGoal } from "@nodex/codex-app-server-protocol/v2";
import type {
  ThreadComposerShellBackgroundAgentRowModel,
  ThreadFooterModel,
  ThreadStageActions,
} from "../../thread-stage-types";
import {
  ThreadComposer,
  __composerAddContextTestUtils,
} from "./local-conversation-thread-composer";
import { TestComposerScopePath, TestThreadRouteScopePath } from "@/test/maitai-scope-harness";
import type { CodexAppModelContextAttachment } from "../../../../../shared/codex-untrusted-app-input";
import { appScope, ScopeProvider, useScopeHandle, type ScopeHandle } from "@/lib/maitai";
import { ComposerScope } from "@/lib/workbench-ui-scopes";
import {
  composerGoalModeActiveAtom,
  composerImageAttachmentsAtom,
  composerPastedTextAttachmentsAtom,
  publishComposerDraftTransfer,
  useComposerPromptDraft,
  type ComposerImageAttachment,
  type ComposerPromptDocument,
} from "./composer-draft-state";
import {
  acquireComposerDraftCapture,
  type ComposerDraftCaptureLease,
} from "./composer-draft-capture";
import {
  ComposerAppModelContextProvider,
  restoreComposerAppModelContextSnapshot,
  useComposerAppModelContextRecipient,
  type ComposerAppModelContextRecipient,
} from "./composer-app-model-context";
import { McpAppHostDispatcher } from "@/lib/mcp-app/mcp-app-host-dispatcher";
import { createCommandKeymapState } from "../../../../../shared/command-keybindings";
import { useThreadTextSelectionDraft } from "../../thread-text-selection-draft";

const RESTORED_APP_CONTEXT = {
  id: "queued-context-original",
  kind: "context",
  sourceName: "Fixture app",
  title: "Queued context",
  untrusted: true,
  content: [{ type: "text", text: "Exact queued app content" }],
} satisfies CodexAppModelContextAttachment;
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
  __resetNodexToastStoreForTests();
}

/** The failures the composer reported, as "title: reason". */
function failureToasts(): string[] {
  return __getNodexToastSnapshotForTests().flatMap((record) =>
    record.level === "danger"
      ? [[record.title, record.description].filter(Boolean).map(String).join(": ")]
      : [],
  );
}

type TestInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

function installComposerWindowApi(testInvoke?: TestInvoke): void {
  installWindowApi({
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === "browser-sidebar-runtime-snapshot")
        return {
          annotations: [],
          state: { tabs: [] },
          browserUseState: { tabs: [], cursors: [], activeBrowserTabIdsByConversationScope: {} },
          presentationRequests: [],
        };
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
    account: {
      status: "ready",
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
        serviceTiers: [
          { id: "priority", name: "Fast", description: "1.5x speed, increased usage" },
        ],
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
        serviceTiers: [
          { id: "priority", name: "Fast", description: "1.5x speed, increased usage" },
        ],
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

async function settleComposerFrame(): Promise<void> {
  await settleAsyncRender();
  await settleAsyncRender();
}

async function renderComposer(
  overrides?: Partial<ThreadFooterModel>,
  actionOverrides?: Partial<ThreadStageActions>,
  testInvoke?: TestInvoke,
  backgroundAgentRows?: readonly ThreadComposerShellBackgroundAgentRowModel[],
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
            backgroundAgentRows={backgroundAgentRows}
            actions={buildActions(actionOverrides)}
          />
          <NodexModalHost />
        </TestComposerScopePath>
      </AppProviders>,
    );
  });
  await settleComposerFrame();

  return view;
}

test("keeps an off Nodex model visible in its own Composer and offers another choice", async () => {
  resetStorage();
  const model = catalogModel("gpt-6-luna", "GPT-6 Luna");
  const binding = { driver: "codex", instanceId: `nodex_codex_${"a".repeat(32)}` } as const;
  const selected = { binding, model: model.id };
  const title = "GPT-6 Luna on Nodex is off";
  const message = `${title} in Settings → Agents. Choose another model.`;
  const view = await renderComposer({
    selectedModel: model.id,
    availableModels: [model],
    provider: {
      kind: binding.driver,
      label: "Nodex",
      selection: binding.instanceId,
      commands: [],
      modelCatalog: {
        selected,
        entries: [
          {
            binding,
            model,
            label: "Nodex",
            selection: selected,
            unavailableReason: message,
            unavailableLabel: "Off",
            spendsCredit: true,
          },
        ],
        currentModelOff: { code: "model_off", title, message },
        loading: false,
        choose: () => {},
      },
    },
  });
  expect(view.getByText(title)).toBeDefined();
  expect(
    within(view.getByRole("button", { name: "Select model" })).getByText("GPT-6 Luna"),
  ).toBeDefined();
  expect(view.queryByRole("button", { name: "Turn on" })).toBeNull();
  const chooseModel = view.getByRole("button", { name: /^Choose model$/u });
  await act(async () => {
    fireEvent.click(chooseModel);
    await Promise.resolve();
  });
  await view.findByRole("combobox", { name: "Search models" });
  const option = await view.findByRole("option", { name: /GPT-6 Luna.*Off/u });
  expect(option.matches(":disabled")).toBe(true);
});

test("restored app context sends through the active queue instead of a steer request", async () => {
  resetStorage();
  const enqueue = vi.fn<ThreadStageActions["onEnqueueQueuedFollowUp"]>(async () => {});
  const steer = vi.fn<ThreadStageActions["onSteerPrompt"]>(async () => {});
  const view = await renderComposer(
    buildRunningComposerModel({
      isQueueingEnabled: true,
      composerIntent: {
        prompt: "Keep this input",
        focusNonce: 813,
        promptInput: {
          text: "Keep this input",
          mcpAppModelContextAttachments: [RESTORED_APP_CONTEXT],
        },
      },
    }),
    { onEnqueueQueuedFollowUp: enqueue, onSteerPrompt: steer },
  );
  expect(await view.findByRole("button", { name: "Remove Fixture app context" })).toBeTruthy();
  await keyDownComposer(view, { key: "Enter", metaKey: true });
  await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
  expect(steer).not.toHaveBeenCalled();
  const captured = enqueue.mock.calls[0]![2]?.promptInput?.mcpAppModelContextAttachments;
  expect(captured).toEqual([
    expect.objectContaining({
      kind: "message",
      sourceName: "Fixture app",
      content: RESTORED_APP_CONTEXT.content,
    }),
  ]);
  expect(captured?.[0]?.id).not.toBe(RESTORED_APP_CONTEXT.id);
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Remove Fixture app context" })).toBeNull(),
  );
});

test.each(["queue", "replace"] as const)(
  "%s rejection preserves restored context and the draft for an accepted retry",
  async (kind) => {
    resetStorage();
    const enqueue = vi
      .fn<ThreadStageActions["onEnqueueQueuedFollowUp"]>()
      .mockRejectedValueOnce(new Error("Not accepted"))
      .mockResolvedValue(undefined);
    const replace = vi
      .fn<NonNullable<ThreadStageActions["onReplaceQueuedFollowUp"]>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const view = await renderComposer(
      buildRunningComposerModel({
        isQueueingEnabled: true,
        composerIntent: {
          prompt: "Keep this input",
          focusNonce: kind === "queue" ? 814 : 815,
          ...(kind === "replace"
            ? { queuedFollowUpEdit: { followUpId: "editing-row", ledgerRevision: 3 } }
            : {}),
          promptInput: {
            text: "Keep this input",
            mcpAppModelContextAttachments: [RESTORED_APP_CONTEXT],
          },
        },
      }),
      { onEnqueueQueuedFollowUp: enqueue, onReplaceQueuedFollowUp: replace },
    );
    await view.findByRole("button", { name: "Remove Fixture app context" });
    await keyDownComposer(view, { key: "Enter" });
    await waitFor(() => expect(failureToasts()).toHaveLength(1));
    expect(view.getByRole("button", { name: "Remove Fixture app context" })).toBeTruthy();
    expect(view.container.querySelector('[data-codex-composer="true"]')?.textContent).toBe(
      "Keep this input",
    );
    await keyDownComposer(view, { key: "Enter" });
    await waitFor(() => expect(kind === "queue" ? enqueue : replace).toHaveBeenCalledTimes(2));
    const captured =
      kind === "queue"
        ? enqueue.mock.calls.map((call) => call[2]?.promptInput?.mcpAppModelContextAttachments)
        : replace.mock.calls.map((call) => call[4]?.promptInput?.mcpAppModelContextAttachments);
    expect(captured[0]).toEqual(captured[1]);
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "Remove Fixture app context" })).toBeNull(),
    );
  },
);

test("saving a mounted Claude side draft freezes input and restores its complete draft without sending", async () => {
  resetStorage();
  installAsyncRequestAnimationFrame();
  document.documentElement.dataset.codexWindowType = "electron";
  const copiedPastedFile = {
    label: "notes.txt",
    path: "/attachments/copied/notes.txt",
    fsPath: "/attachments/copied/notes.txt",
    hostId: "local",
  };
  const removePasted = vi.fn();
  installComposerWindowApi(async (channel, ...args) => {
    if (channel === "codex:pasted-text:read") return "notes";
    if (channel === "codex:pasted-text:create")
      return { file: copiedPastedFile, preview: "notes", characterCount: 5 };
    if (channel === "codex:pasted-text:remove") {
      removePasted(args[0]);
      return null;
    }
    return undefined;
  });
  const sourceIdentity = "side-chat-session:capture-test";
  const sourceTarget = { threadId: "thread_1", composerScopeIdentity: sourceIdentity };
  const destinationTarget = {
    threadId: "thread_saved",
    composerScopeIdentity: "thread:thread_saved",
  };
  const richDocument: ComposerPromptDocument = {
    text: "Review docs with @skill",
    links: [{ from: 7, to: 11, href: "https://example.com/docs" }],
    mentions: [
      {
        from: 17,
        to: 23,
        kind: "skill",
        id: "skill:review",
        label: "skill",
        path: "/skills/review",
      },
    ],
  };
  const image: ComposerImageAttachment = {
    id: "draft-image",
    filename: "context.png",
    mimeType: "image/png",
    src: "nodex://assets/context.png",
    origin: "browser",
    materialization: {
      hostId: "local",
      managedSource: "nodex://assets/context.png",
      localPath: null,
    },
    materializationStatus: "ready",
    uploadStatus: "idle",
    generation: 1,
  };
  const pasted = {
    id: "draft-pasted",
    status: "ready" as const,
    preview: "notes",
    characterCount: 5,
    attachment: {
      preview: "notes",
      characterCount: 5,
      file: { label: "notes.txt", path: "notes.txt", fsPath: "/work/notes.txt" },
    },
  };
  const send = vi.fn<ThreadStageActions["onSendPrompt"]>(async () => {});
  const setGoal = vi.fn<NonNullable<ThreadStageActions["onSetThreadGoal"]>>(async () => null);
  let mounted: {
    scope: ScopeHandle;
    app: ScopeHandle;
    writeDocument: (value: ComposerPromptDocument) => Promise<void>;
    selection: ReturnType<typeof useThreadTextSelectionDraft>;
  } | null = null;
  let openSaved: (() => void) | null = null;
  function Probe({ threadId }: { threadId: string }) {
    const scope = useScopeHandle(ComposerScope);
    const app = useScopeHandle(appScope);
    const draft = useComposerPromptDraft(threadId);
    const selection = useThreadTextSelectionDraft("local", threadId);
    useLayoutEffect(() => {
      mounted = { scope, app, writeDocument: draft.setDocument, selection };
    }, [app, draft.setDocument, scope, selection]);
    return null;
  }
  function Harness() {
    const [saved, setSaved] = useState(false);
    const target = saved ? destinationTarget : sourceTarget;
    useLayoutEffect(() => {
      openSaved = () => setSaved(true);
    }, []);
    const base = buildModel();
    return (
      <ScopeProvider
        key={target.composerScopeIdentity}
        scope={ComposerScope}
        descriptor={{ identity: target.composerScopeIdentity, focusComposerNonce: null }}
      >
        <Probe threadId={target.threadId} />
        <ThreadComposer
          model={buildModel({
            threadId: target.threadId,
            composerScopeIdentity: target.composerScopeIdentity,
            conversation: { ...base.conversation!, threadId: target.threadId },
            provider: {
              kind: "claudeAgent",
              label: "Claude",
              selection: "claudeAgent",
              commands: [],
              controls: { images: true, goals: true },
            },
          })}
          actions={buildActions({ onSendPrompt: send, onSetThreadGoal: setGoal })}
        />
      </ScopeProvider>
    );
  }
  const view = render(
    <AppProviders>
      <TestThreadRouteScopePath>
        <Harness />
      </TestThreadRouteScopePath>
    </AppProviders>,
  );
  await settleComposerFrame();
  const current = () => {
    if (!mounted) throw new Error("Expected a mounted Composer");
    return mounted;
  };
  await act(async () => {
    await current().writeDocument(richDocument);
    current().scope.set(composerImageAttachmentsAtom, [image]);
    current().scope.set(composerGoalModeActiveAtom, true);
    restoreComposerAppModelContextSnapshot(current().scope, [RESTORED_APP_CONTEXT]);
    current().selection.addAnnotation({
      id: "unfinished-annotation",
      text: "The selected reply",
      source: {
        threadId: "thread_1",
        messageId: "message_1",
        startOffset: 0,
        endOffset: 18,
        rangeText: "The selected reply",
      },
    });
    current().selection.updateAnnotation("unfinished-annotation", "An unfinished annotation note");
    current().scope.set(composerPastedTextAttachmentsAtom, [
      { id: pasted.id, status: "pending", generation: 1, preview: "notes", characterCount: 5 },
    ]);
  });
  expect(acquireComposerDraftCapture(sourceTarget)).toMatchObject({
    status: "blocked",
    reason: "pending-attachments",
  });
  await act(async () => {
    current().scope.set(composerPastedTextAttachmentsAtom, [
      {
        id: pasted.id,
        status: "failed",
        generation: 1,
        preview: "notes",
        characterCount: 5,
        error: "Upload failed",
      },
    ]);
  });
  expect(acquireComposerDraftCapture(sourceTarget)).toMatchObject({
    status: "blocked",
    reason: "attachment-error",
  });
  await act(async () => {
    current().scope.set(composerPastedTextAttachmentsAtom, [pasted]);
  });
  let lease: ComposerDraftCaptureLease | undefined;
  try {
    await act(async () => {
      const acquired = acquireComposerDraftCapture(sourceTarget);
      if (acquired.status !== "ready") throw new Error(acquired.message);
      lease = acquired.lease;
    });
    expect(lease!.capture()).toMatchObject({
      status: "ready",
      snapshot: {
        promptDocument: richDocument,
        imageAttachments: [image],
        pastedTextAttachments: [pasted],
        appModelContextAttachments: [RESTORED_APP_CONTEXT],
        goalModeActive: true,
        activeAnnotationId: "unfinished-annotation",
        annotationMode: "create",
        annotationDraft: "An unfinished annotation note",
      },
    });
    expect(
      view.container.querySelector('[data-codex-composer="true"]')?.getAttribute("contenteditable"),
    ).toBe("false");
    await keyDownComposer(view, { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
    expect(setGoal).not.toHaveBeenCalled();
    await act(async () => {
      const transfer = await lease!.persistTransfer(destinationTarget.threadId);
      publishComposerDraftTransfer(current().app, transfer);
      lease!.commitTransfer(transfer);
      if (!openSaved) throw new Error("Expected navigation to saved chat");
      openSaved();
    });
    await waitFor(() => expect(readComposerText(view)).toBe(richDocument.text));
    await view.findByRole("button", { name: "context.png" });
    let destination: ComposerDraftCaptureLease | undefined;
    await act(async () => {
      const acquired = acquireComposerDraftCapture(destinationTarget);
      if (acquired.status !== "ready") throw new Error(acquired.message);
      destination = acquired.lease;
    });
    try {
      expect(destination!.capture()).toMatchObject({
        status: "ready",
        snapshot: {
          promptDocument: richDocument,
          imageAttachments: [expect.objectContaining({ id: image.id })],
          pastedTextAttachments: [
            { ...pasted, attachment: { ...pasted.attachment, file: copiedPastedFile } },
          ],
          appModelContextAttachments: [RESTORED_APP_CONTEXT],
          goalModeActive: true,
          activeAnnotationId: "unfinished-annotation",
          annotationMode: "create",
          annotationDraft: "An unfinished annotation note",
        },
      });
      expect(send).not.toHaveBeenCalled();
      expect(setGoal).not.toHaveBeenCalled();
    } finally {
      await act(async () => destination?.release());
    }
  } finally {
    await act(async () => lease?.release());
  }
  expect(removePasted).not.toHaveBeenCalled();
});

test("hidden app context alone cannot send a blank prompt but accompanies actual prose", async () => {
  resetStorage();
  installAsyncRequestAnimationFrame();
  document.documentElement.dataset.codexWindowType = "electron";
  installComposerWindowApi();
  let readRecipient: (() => ComposerAppModelContextRecipient | null) | undefined;
  let writePrompt: ((text: string) => Promise<void>) | undefined;
  function Producer() {
    const current = useComposerAppModelContextRecipient({
      hostId: "local",
      threadId: "thread_1",
    });
    const draft = useComposerPromptDraft("thread_1");
    useLayoutEffect(() => {
      readRecipient = current;
      writePrompt = draft.setPrompt;
    }, [current, draft.setPrompt]);
    return null;
  }
  const currentRecipient = () => {
    const recipient = readRecipient?.();
    if (!recipient) throw new Error("Expected the actual Composer recipient");
    return recipient;
  };
  const setDraft = (text: string) => {
    if (!writePrompt) throw new Error("Expected the actual Composer draft");
    return writePrompt(text);
  };
  const send = vi.fn<ThreadStageActions["onSendPrompt"]>(async () => {});
  const view = render(
    <AppProviders>
      <TestComposerScopePath>
        <ComposerAppModelContextProvider>
          <Producer />
          <ThreadComposer
            model={buildModel({ composerIntent: null })}
            actions={buildActions({ onSendPrompt: send })}
          />
        </ComposerAppModelContextProvider>
      </TestComposerScopePath>
    </AppProviders>,
  );
  await waitFor(() => expect(currentRecipient().isCurrent()).toBe(true));
  const dispatcher = new McpAppHostDispatcher({
    scope: {
      allowedTools: new Map(),
      codexAppsToolScope: null,
      originResourceUri: "ui://hidden-context",
      resourceTemplates: [],
      resources: [],
      server: "fixture-app",
      threadId: "thread_1",
    },
    updateModelContext: (update) =>
      currentRecipient().publish(
        { id: "hidden-context", server: "fixture-app", sourceName: "Hidden app" },
        update,
      ),
  });
  await act(async () => {
    await dispatcher.handlers().callMcp({
      method: "ui/update-model-context",
      params: {
        content: [
          {
            type: "text",
            text: "Keep this hidden payload",
            annotations: { audience: ["assistant"] },
          },
        ],
      },
    });
  });
  const button = view.getByRole("button", { name: "Send prompt" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await keyDownComposer(view, { key: "Enter" }, { waitForContent: false });
  expect(send).not.toHaveBeenCalled();
  expect(view.queryByRole("button", { name: "Remove Hidden app context" })).toBeNull();
  await act(async () => {
    await setDraft("Use this context");
  });
  await waitFor(() => expect(readComposerText(view)).toBe("Use this context"));
  expect(button.disabled).toBe(false);
  await submitCurrentComposerDraft(view);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0]![1]?.promptInput?.mcpAppModelContextAttachments).toMatchObject([
    {
      kind: "context",
      id: "hidden-context",
      content: [{ text: "Keep this hidden payload", annotations: { audience: ["assistant"] } }],
    },
  ]);
});

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
      expect(failureToasts()).toEqual([]);
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

  test("matches a Browser image drag without intercepting an operating-system drop", async () => {
    resetStorage();
    const savedImages: unknown[] = [];
    const browserCommands: unknown[] = [];
    const dragToken = "1".repeat(32);
    const browserTab = {
      browserConversationId: "session-1",
      browserViewScopeId: "window-1",
      browserTabId: "tab-1",
    };
    const view = await renderComposer(undefined, undefined, async (channel, ...args) => {
      if (channel === "asset:image:save") {
        savedImages.push(args[0]);
        return { source: "nodex://assets/dropped.png" };
      }
      if (
        channel === "browser-sidebar-command" &&
        (args[0] as { type?: string } | undefined)?.type === "attach-dragged-image"
      ) {
        browserCommands.push(args[0]);
        return {
          ok: true,
          imageAttachment: {
            id: "browser-image",
            fileName: "browser.png",
            source: "nodex://assets/browser.png",
          },
        };
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

    const browserDropActive = () => dropTarget.getAttribute("data-browser-image-drop-active");

    try {
      await act(async () => {
        publishBrowserImageDragState("thread_1", { ...browserTab, dragToken, isActive: true });
      });
      expect(browserDropActive()).toBe("false");

      const staleTransfer = {
        types: [browserImageDragType("2".repeat(32))],
        files: [],
        items: [],
        getData: () => "",
        dropEffect: "none",
      };
      await act(async () => {
        fireEvent.dragEnter(dropTarget, { dataTransfer: staleTransfer });
        fireEvent.dragOver(dropTarget, { dataTransfer: staleTransfer });
      });
      expect(browserDropActive()).toBe("false");
      await act(async () => {
        fireEvent.drop(dropTarget, { dataTransfer: staleTransfer });
        fireEvent.dragEnter(dropTarget, { dataTransfer });
      });
      expect(browserDropActive()).toBe("false");
      expect(dropTarget.getAttribute("data-file-drop-active")).toBe("true");

      await act(async () => {
        fireEvent.drop(dropTarget, { dataTransfer });
      });
      const thumbnail = await view.findByRole("button", { name: "dropped.png" });
      expect(thumbnail.getAttribute("data-composer-image-attachment-size")).toBe("80");
      await waitFor(() => expect(savedImages).toHaveLength(1));
      expect(dataTransfer.dropEffect).toBe("copy");
      expect(browserCommands).toEqual([]);

      const browserTransfer = { ...staleTransfer, types: [browserImageDragType(dragToken)] };
      await act(async () => {
        fireEvent.dragEnter(dropTarget, { dataTransfer: browserTransfer });
        fireEvent.dragOver(dropTarget, { dataTransfer: browserTransfer });
      });
      expect(browserDropActive()).toBe("true");
      expect(browserTransfer.dropEffect).toBe("copy");

      await act(async () => {
        fireEvent.drop(dropTarget, { dataTransfer: browserTransfer });
      });
      expect(browserDropActive()).toBe("false");
      expect(await view.findByRole("button", { name: "browser.png" })).toBeDefined();
      expect(browserCommands).toEqual([{ ...browserTab, type: "attach-dragged-image", dragToken }]);
    } finally {
      await act(async () => clearBrowserImageDragState(dragToken));
    }
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

  test("blocks a restored local-only image when its execution host changes", async () => {
    resetStorage();
    const sent: unknown[] = [];
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
    );

    const thumbnail = await view.findByRole("button", { name: "local-only.png" });
    expect(thumbnail.querySelector("img")?.getAttribute("src")).toBe(
      "app://fs/@fs/managed/local-only.png",
    );
    await submitCurrentComposerDraft(view);

    expect(sent).toEqual([]);
    expect(failureToasts()).toContain(
      "Message not sent: One or more images aren’t available where this chat runs. Remove them or add them again.",
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

  test("restores a failed New Chat submission for an explicit retry", async () => {
    resetStorage();
    let rejectStart!: (error: Error) => void;
    const firstStart = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    let startCount = 0;
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
    expect(failureToasts()).toContain("Message not sent: Thread start failed");

    await submitCurrentComposerDraft(view);
    await waitFor(() => expect(startCount).toBe(2));
    await waitFor(() => expect(readComposerText(view)).toBe(""));
  });

  test("keeps the original queued row and draft when an edit loses its revision race", async () => {
    resetStorage();
    const removed: string[] = [];
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
    );

    await keyDownComposer(view, { key: "Enter" });

    await waitFor(() =>
      expect(failureToasts().at(-1)).toBe(
        "Message not sent: The queued message changed before it could be edited",
      ),
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

  test("treats ordinary empty intent text as no-op and clearText as explicit deletion", async () => {
    resetStorage();
    installComposerWindowApi(async (channel) =>
      channel === "codex-command-keymap-state"
        ? createCommandKeymapState({}, "windows")
        : undefined,
    );
    const actions = buildActions();
    const renderTree = (intent: NonNullable<ThreadFooterModel["composerIntent"]>) => (
      <AppProviders>
        <TestComposerScopePath>
          <ThreadComposer model={buildModel({ composerIntent: intent })} actions={actions} />
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
    installComposerWindowApi(async (channel) =>
      channel === "codex-command-keymap-state"
        ? createCommandKeymapState({}, "windows")
        : undefined,
    );
    const actions = buildActions();
    const renderTree = (intent: NonNullable<ThreadFooterModel["composerIntent"]>) => (
      <AppProviders>
        <TestComposerScopePath>
          <ThreadComposer model={buildModel({ composerIntent: intent })} actions={actions} />
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
          hostId: "local",
          id: "browser@openai-bundled",
          cwds: ["/tmp/project"],
        },
      ]);
    });
    expect(
      view.container.querySelector("[plugin-mention-path='plugin://browser@openai-bundled']"),
    ).not.toBeNull();
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
      '{"projectId":"project_1","sessionId":"session_1","prompt":"Keep refining the migration until tests pass","threadGoalDraft":{"objective":"Keep refining the migration until tests pass","imageAttachments":[],"pastedTextAttachments":[]},"threadGoalMaterializedDraft":{"objective":"Keep refining the migration until tests pass","attachmentDirectory":null},"threadGoalMaterializedHostId":"local","runInTarget":"localProject"}',
    );
    expect(setGoalCalls.length).toBe(0);
    expect(sentPrompts.length).toBe(0);
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
        expect(args[0]).toBe("local");
        materializeCalls.push(args[1]);
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
});

test("selected text can send without prose and remains intact after a rejected send", async () => {
  resetStorage();
  const annotation = {
    id: "annotation",
    text: "Selected response",
    annotation: "Explain this",
    source: {
      threadId: "thread_1",
      messageId: "assistant_1",
      startOffset: 0,
      endOffset: 17,
      rangeText: "Selected response",
    },
  };
  const send = vi
    .fn<ThreadStageActions["onSendPrompt"]>()
    .mockRejectedValueOnce(new Error("Not accepted"))
    .mockResolvedValue(undefined);
  const view = await renderComposer(
    {
      composerIntent: {
        prompt: "",
        focusNonce: 990,
        promptInput: { text: "", responseTextAnnotations: [annotation] },
      },
    },
    { onSendPrompt: send },
  );
  await view.findByRole("button", { name: "1 annotation" });
  await submitCurrentComposerDraft(view);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0]?.[1]?.promptInput?.responseTextAnnotations).toEqual([annotation]);
  expect(readComposerText(view)).toBe("");
  await view.findByRole("button", { name: "1 annotation" });
  await submitCurrentComposerDraft(view);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[1]?.[1]?.promptInput?.responseTextAnnotations).toEqual([annotation]);
  await waitFor(() => expect(view.queryByRole("button", { name: "1 annotation" })).toBeNull());
});

test("chat intent delivery survives first-thread attachment and preserves append and replace behavior", async () => {
  resetStorage();
  installAsyncRequestAnimationFrame();
  installComposerWindowApi();
  const chat = { kind: "session", sessionId: "draft-intent-promotion" } as const;
  function ChatComposer({ started }: { started: boolean }) {
    const composerIntent = useComposerDraftIntent(chat);
    return (
      <ThreadComposer
        model={buildModel({
          threadId: started ? "nodex:thread:promoted" : null,
          isNewThreadTab: !started,
          newThreadTarget: started
            ? null
            : { projectId: "project_1", projectName: "Project", sessionId: chat.sessionId },
          composerChatKey: chat,
          composerIntent,
        })}
        actions={buildActions()}
      />
    );
  }
  const tree = (started: boolean) => (
    <AppProviders>
      <TestComposerScopePath>
        <ChatComposer started={started} />
      </TestComposerScopePath>
    </AppProviders>
  );
  composerDraftIntents.set(chat, { prompt: "Keep my draft", focusNonce: 9101 });
  const view = render(tree(false));
  try {
    await waitFor(() => expect(readComposerText(view)).toBe("Keep my draft"));
    expect(composerDraftIntents.read(chat)).toBeNull();
    await act(async () => {
      composerDraftIntents.set(chat, {
        prompt: "",
        attachmentMode: "append",
        focusNonce: 9102,
        promptInput: {
          text: "",
          documentItems: [{ type: "text", text: "Page context\n\n" }],
          addedFiles: [
            {
              label: "context.ts",
              path: "/repo/context.ts",
              fsPath: "/repo/context.ts",
              hostId: "local",
            },
          ],
        },
      });
      view.rerender(tree(true));
      await Promise.resolve();
    });
    await waitFor(() => expect(readComposerText(view)).toBe("Keep my draft\n\nPage context\n\n"));
    await view.findByText("context.ts");
    expect(composerDraftIntents.read(chat)).toBeNull();
    await act(async () => {
      composerDraftIntents.set(chat, {
        prompt: "Replacement",
        attachmentMode: "replace",
        focusNonce: 9103,
        queuedFollowUpEdit: { followUpId: "queue-edit", ledgerRevision: 7 },
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(readComposerText(view)).toBe("Replacement"));
    expect(view.queryByText("context.ts")).toBeNull();
    expect(composerDraftIntents.read(chat)).toBeNull();
  } finally {
    await act(async () => view.unmount());
  }
});

test.each([true, false])(
  "direct Browser notes use the running chat's queue=%s path without consuming its draft",
  async (isQueueingEnabled) => {
    resetStorage();
    const notes = [
      {
        schemaVersion: 1 as const,
        id: "browser-note",
        browserTabId: "tab",
        createdAt: 1,
        note: "Make it clearer",
        pageTitle: "Example",
        pageUrl: "https://example.com",
        anchors: [
          {
            id: "target",
            kind: "element" as const,
            pageUrl: "https://example.com",
            selector: "#target",
            rect: { x: 0, y: 0, width: 20, height: 20 },
          },
        ],
      },
    ];
    const admitted: Array<{ mode: string; prompt: string; input: unknown }> = [];
    const draft = isQueueingEnabled ? "" : "Keep the typed draft";
    const view = await renderComposer(
      buildRunningComposerModel({
        isQueueingEnabled,
        composerChatKey: { kind: "session", sessionId: "annotation-chat" },
        composerIntent: { prompt: draft, focusNonce: 9913 },
      }),
      {
        onEnqueueQueuedFollowUp: async (_threadId, prompt, options) => {
          admitted.push({ mode: "queue", prompt, input: options?.promptInput });
        },
        onSteerPrompt: async (request) => {
          admitted.push({ mode: "steer", prompt: request.prompt, input: request.promptInput });
        },
      },
    );
    await act(async () => {
      const result = await deliverBrowserAnnotations({
        destination: "session:annotation-chat",
        annotations: notes,
        consume: async () => {},
      });
      expect(result.admitted).toBe(true);
    });
    expect(admitted).toEqual([
      {
        mode: isQueueingEnabled ? "queue" : "steer",
        prompt: "",
        input: expect.objectContaining({ browserAnnotationAttachments: notes }),
      },
    ]);
    expect(readComposerText(view)).toBe(draft);
  },
);
