import { describe, expect, test, vi } from "vite-plus/test";
import { automationNotificationDecision } from "../../shared/automation-notification-policy";
import type {
  DesktopNotificationActionInvocation,
  DesktopNotificationActionPayload,
  DesktopNotificationHideSelector,
  DesktopNotificationPayload,
  ThreadNotificationSettings,
  CodexApprovalRequest,
  CodexCanonicalConversationState,
  CodexThreadDetail,
} from "../../shared/types";
import {
  buildCodexRequestNotificationOccurrenceId,
  type CodexNotificationConversationFacts,
  type CodexThreadNotificationEvent,
} from "../../shared/codex-thread-notification";
import { makeCodexThreadNotificationHandler } from "./codex-thread-notification-handler";
import { buildCodexConversationSnapshot } from "./codex-conversation-snapshot";
import { z } from "zod";
import { DynamicToolRegistry, DynamicToolRegistryError } from "./dynamic-tool-registry";
import {
  CODEX_APP_TOOL_NAMESPACE,
  CODEX_APP_TOOLSET_REVISION,
} from "../../shared/codex-dynamic-tool-identity";
import {
  NODEX_APP_TOOL_NAMESPACE,
  NODEX_APP_TOOLSET_REVISION,
  NODEX_APP_V6_TOOLS,
  NODEX_APP_V6_TOOLSET_REVISION,
} from "../../shared/nodex-agent-tools";
import { resolveDynamicToolCatalogBindings } from "./codex-dynamic-tool-catalog-bindings";
import {
  NODEX_MARKDOWN_COMPACT_HINT,
  NODEX_MARKDOWN_AGENT_GUIDE,
} from "../../shared/nodex-markdown/agent-guide";
import {
  createNodexV3DynamicToolRegistry,
  type NodexAgentV3ToolHandlers,
  buildNodexAgentV3DynamicToolCatalog,
} from "./nodex-dynamic-tool-registry";
import { NODEX_AGENT_V3_CATALOG_BUDGETS } from "../../shared/nodex-agent-tools/budgets";
import {
  formatDynamicToolCatalogMetrics,
  measureDynamicToolCatalog,
} from "./dynamic-tool-catalog-metrics";
import {
  buildCodexAppDynamicToolFailure,
  buildCodexAppDynamicToolSuccess,
  buildCodexAppMetaThreadToolSpecs,
} from "./codex-app-meta-thread-tools";

describe("codex-thread-notification-handler", () => {
  function conversation(
    overrides: Partial<CodexNotificationConversationFacts> = {},
  ): CodexNotificationConversationFacts {
    return {
      conversationId: "thread-1",
      title: "Notification parity",
      threadSource: null,
      parentThreadId: null,
      source: null,
      sideConversationParentNavigationPath: null,
      ...overrides,
    };
  }

  class FakeSource {
    eventListener: ((event: CodexThreadNotificationEvent) => void) | null = null;
    presentedListener: ((conversationId: string) => void) | null = null;

    addThreadNotificationListener(listener: (event: CodexThreadNotificationEvent) => void) {
      this.eventListener = listener;
      return () => {
        if (this.eventListener === listener) this.eventListener = null;
      };
    }

    addRendererConversationPresentedInForegroundListener(
      listener: (conversationId: string) => void,
    ) {
      this.presentedListener = listener;
      return () => {
        if (this.presentedListener === listener) this.presentedListener = null;
      };
    }
  }

  function setup(
    settings: ThreadNotificationSettings = {
      turnMode: "unseen",
      questionsEnabled: true,
      readbackEnabled: true,
    },
  ) {
    const source = new FakeSource();
    const shown: DesktopNotificationPayload[] = [];
    const actions: Array<(action: DesktopNotificationActionPayload) => void> = [];
    const dismissed: DesktopNotificationHideSelector[] = [];
    const dispatched: DesktopNotificationActionInvocation[] = [];
    let foregrounded = false;
    let presented = false;
    const focusTargetClient = vi.fn();
    const handle = makeCodexThreadNotificationHandler({
      getSettings: () => settings,
      isAppForegrounded: () => foregrounded,
      isConversationSeen: () => presented,
      resolveTargetClientId: () => "renderer-1",
      showNotification: (notification, _targetClientId, onAction) => {
        shown.push(notification);
        actions.push(onAction);
      },
      dismissNotification: (selector) => dismissed.push(selector),
      dispatchAction: (_targetClientId, action) => {
        dispatched.push(action);
        return true;
      },
      focusTargetClient,
    });
    source.eventListener = handle;
    source.presentedListener = (conversationId) => dismissed.push({ conversationId });
    return {
      handle,
      actions,
      dismissed,
      dispatched,
      focusTargetClient,
      setForegrounded: (value: boolean) => {
        foregrounded = value;
      },
      setPresented: (value: boolean) => {
        presented = value;
      },
      shown,
      source,
    };
  }

  describe("Codex thread notification handler", () => {
    test("approval requests show their action, navigate to their Session and dismiss independently of questions", () => {
      const runtime = setup({ turnMode: "off", questionsEnabled: true, readbackEnabled: true });
      const facts = conversation({ runtimeSessionId: "session-1" });
      runtime.source.eventListener?.({
        type: "approval-requested",
        hostId: "local",
        conversation: facts,
        requestId: 73,
        turnId: "turn-1",
        prompt: "git push origin main",
      });
      runtime.source.eventListener?.({
        type: "user-input-requested",
        hostId: "local",
        conversation: facts,
        requestId: 73,
        turnId: "turn-1",
        questionCount: 1,
      });
      expect(runtime.shown).toHaveLength(2);
      const approval = runtime.shown[0]!;
      expect(approval).toMatchObject({
        id: "approval-local-73",
        title: "Notification parity needs approval",
        body: "git push origin main",
        navigationPath: "session:session-1/thread:thread-1",
        requestId: 73,
      });
      expect(approval.actions).toBeUndefined();
      expect(approval.replyPlaceholder).toBeUndefined();
      expect(approval.occurrenceId).not.toBe(runtime.shown[1]?.occurrenceId);
      runtime.actions[0]?.({ notificationId: approval.id, actionType: "open", actionId: null });
      expect(runtime.focusTargetClient).toHaveBeenCalledWith("renderer-1");
      expect(runtime.dispatched[0]).toMatchObject({
        actionType: "open",
        hostId: "local",
        conversationId: "thread-1",
        navigationPath: "session:session-1/thread:thread-1",
        requestId: 73,
      });
      runtime.source.eventListener?.({
        type: "request-resolved",
        hostId: "local",
        conversationId: "thread-1",
        requestId: 73,
        family: "approval",
      });
      expect(runtime.dismissed).toEqual([{ occurrenceId: approval.occurrenceId }]);
    });

    test("approval requests share request preferences and foreground suppression", () => {
      const event = {
        type: "approval-requested",
        hostId: "local",
        conversation: conversation(),
        requestId: "approval-1",
        turnId: "turn-1",
        prompt: null,
      } as const;
      const disabled = setup({
        turnMode: "always",
        questionsEnabled: false,
        readbackEnabled: true,
      });
      disabled.source.eventListener?.(event);
      expect(disabled.shown).toEqual([]);
      const visible = setup();
      visible.setPresented(true);
      visible.source.eventListener?.(event);
      expect(visible.shown).toEqual([]);
      const background = setup();
      background.source.eventListener?.(event);
      expect(background.shown[0]?.body).toBe("Approve the requested action to proceed.");
    });

    test("muted automations notify on failure while respecting global notification settings", () => {
      const runtime = setup();
      const emit = (target: ReturnType<typeof setup>, status: "completed" | "failed") =>
        target.source.eventListener?.({
          type: "turn-completed",
          hostId: "local",
          conversation: conversation(),
          turnId: status,
          status,
          lastAgentMessage: "Run finished",
          heartbeatAssistantMessage: {
            decision: "DONT_NOTIFY",
            visibleText: null,
            notificationMessage: null,
          },
          automationNotificationDecision: automationNotificationDecision(
            "failed_runs_only",
            status,
          ),
          hasPendingContinuation: false,
        });
      emit(runtime, "completed");
      expect(runtime.shown).toHaveLength(0);
      emit(runtime, "failed");
      expect(runtime.shown).toHaveLength(1);
      const disabled = setup({ turnMode: "off", questionsEnabled: true, readbackEnabled: true });
      emit(disabled, "failed");
      expect(disabled.shown).toHaveLength(0);
    });

    test("shapes root turns and stays quiet while Nodex or the chat itself is in front of the person", () => {
      const turn = (turnId: string, status: "completed" | "interrupted" = "completed") => ({
        type: "turn-completed" as const,
        hostId: "local",
        conversation: conversation(),
        turnId,
        status,
        lastAgentMessage: status === "interrupted" ? "Stopped safely" : "Hidden",
        heartbeatAssistantMessage: null,
        automationNotificationDecision: null,
        hasPendingContinuation: false,
      });
      const runtime = setup();
      runtime.source.eventListener?.(turn("turn-1", "interrupted"));
      expect(runtime.shown).toMatchObject([
        {
          id: "turn-turn-1",
          title: "Notification parity",
          body: "Stopped safely",
          navigationPath: "thread:thread-1",
          replyPlaceholder: "Reply to Nodex",
        },
      ]);

      // Only the chat in front of the person stays quiet; another chat's completion still tells them.
      runtime.setPresented(true);
      runtime.source.eventListener?.(turn("turn-2"));
      expect(runtime.shown).toHaveLength(1);
      runtime.setPresented(false);
      runtime.source.eventListener?.(turn("turn-3"));
      expect(runtime.shown).toHaveLength(2);

      const quieter = setup({
        turnMode: "background",
        questionsEnabled: true,
        readbackEnabled: true,
      });
      quieter.setForegrounded(true);
      quieter.source.eventListener?.(turn("turn-5"));
      expect(quieter.shown).toHaveLength(0);
      quieter.setForegrounded(false);
      quieter.source.eventListener?.(turn("turn-6"));
      expect(quieter.shown).toHaveLength(1);

      const always = setup({ turnMode: "always", questionsEnabled: true, readbackEnabled: true });
      always.setPresented(true);
      always.source.eventListener?.(turn("turn-4"));
      expect(always.shown).toHaveLength(1);
    });

    test("suppresses child question notifications", () => {
      const runtime = setup();
      runtime.source.eventListener?.({
        type: "user-input-requested",
        hostId: "local",
        conversation: conversation({ parentThreadId: "parent" }),
        requestId: "child-question",
        turnId: "turn-child",
        questionCount: 1,
      });
      expect(runtime.shown).toHaveLength(0);
    });

    test("suppresses foreground-presented requests and precisely dismisses resolved IDs", () => {
      const runtime = setup();
      runtime.setPresented(true);
      runtime.source.eventListener?.({
        type: "user-input-requested",
        hostId: "local",
        conversation: conversation(),
        requestId: "q-1",
        turnId: "turn-1",
        questionCount: 2,
      });
      expect(runtime.shown).toHaveLength(0);

      runtime.source.eventListener?.({
        type: "request-resolved",
        hostId: "local",
        conversationId: "thread-1",
        requestId: "q-1",
      });
      expect(runtime.dismissed).toEqual([
        {
          occurrenceId: buildCodexRequestNotificationOccurrenceId(
            "question",
            "local",
            "thread-1",
            "q-1",
          ),
        },
      ]);
      runtime.source.presentedListener?.("thread-1");
      expect(runtime.dismissed.at(-1)).toEqual({ conversationId: "thread-1" });
    });

    test("routes side actions with navigation first contract and focuses open only", () => {
      const runtime = setup();
      runtime.source.eventListener?.({
        type: "user-input-requested",
        hostId: "local",
        conversation: conversation({
          conversationId: "side-1",
          sideConversationParentNavigationPath: "project:p/session:s/thread:parent",
        }),
        requestId: "q-side",
        turnId: "turn-side",
        questionCount: 0,
      });
      runtime.actions[0]?.({
        notificationId: "question-default-q-side",
        actionId: null,
        actionType: "open",
      });
      expect(runtime.focusTargetClient).toHaveBeenCalledWith("renderer-1");
      expect(runtime.dispatched[0]).toMatchObject({
        conversationId: "side-1",
        navigationPath: "project:p/session:s/thread:parent",
        activateTabId: "sidechat:side-1",
        requestId: "q-side",
      });
    });

    test("opens a Runtime side-chat completion in its source Session tab", () => {
      const runtime = setup();
      runtime.source.eventListener?.({
        type: "turn-completed",
        hostId: "local",
        conversation: conversation({
          conversationId: "thread:side",
          runtimeSessionId: "session:side",
          sideConversationParentNavigationPath: "session:session%3Asource/thread:thread%3Asource",
        }),
        turnId: "run-side",
        status: "completed",
        lastAgentMessage: "Side chat finished",
        heartbeatAssistantMessage: null,
        automationNotificationDecision: null,
        hasPendingContinuation: false,
      });
      expect(runtime.shown).toHaveLength(1);
      expect(runtime.shown[0]).toMatchObject({
        conversationId: "thread:side",
        navigationPath: "session:session%3Asource/thread:thread%3Asource",
        activateTabId: "sidechat-session:session:side",
      });
      runtime.actions[0]?.({
        notificationId: runtime.shown[0]!.id,
        actionId: null,
        actionType: "open",
      });
      expect(runtime.dispatched[0]).toMatchObject({
        conversationId: "thread:side",
        navigationPath: "session:session%3Asource/thread:thread%3Asource",
        activateTabId: "sidechat-session:session:side",
      });
      expect(runtime.focusTargetClient).toHaveBeenCalledWith("renderer-1");
    });

    test("opens an async question without a blocking request or reply action, then dismisses the same occurrence", () => {
      const runtime = setup();
      runtime.source.eventListener?.({
        type: "async-question-requested",
        hostId: "local",
        conversation: conversation(),
        turnId: "turn",
        questionId: "question",
      });
      expect(runtime.shown[0]).toMatchObject({
        kind: "question",
        body: "Nodex has a question",
        asyncQuestion: { turnId: "turn", questionId: "question" },
      });
      expect(runtime.shown[0]?.replyPlaceholder).toBeUndefined();
      runtime.actions[0]?.({
        notificationId: runtime.shown[0]!.id,
        actionId: null,
        actionType: "open",
      });
      expect(runtime.dispatched[0]).toMatchObject({
        requestId: null,
        asyncQuestion: { turnId: "turn", questionId: "question" },
      });
      runtime.source.eventListener?.({
        type: "async-question-resolved",
        hostId: "local",
        conversationId: "thread-1",
        turnId: "turn",
        questionId: "question",
      });
      expect(runtime.dismissed).toContainEqual({ notificationId: runtime.shown[0]!.id });
    });

    test("routes a Runtime conversation through its product Session", () => {
      const runtime = setup();
      runtime.source.eventListener?.({
        type: "turn-completed",
        hostId: "local",
        conversation: conversation({
          conversationId: "nodex:thread:root",
          runtimeSessionId: "session:a/b",
        }),
        turnId: "run-1",
        status: "completed",
        lastAgentMessage: "Delegated result is ready",
        heartbeatAssistantMessage: null,
        automationNotificationDecision: null,
        hasPendingContinuation: false,
      });
      expect(runtime.shown).toMatchObject([
        {
          conversationId: "nodex:thread:root",
          navigationPath: "session:session%3Aa%2Fb/thread:nodex%3Athread%3Aroot",
          activateTabId: null,
        },
      ]);
    });
  });

  test("chat snoozes respect settings and presentation and open their exact Session", () => {
    const runtime = setup({ turnMode: "always", questionsEnabled: true, readbackEnabled: true });
    const event = {
      type: "session-snooze" as const,
      hostId: "local",
      snoozedUntil: "2026-11-02T09:00:00.000Z",
      memberId: "member",
      conversation: conversation({ title: "Return here", runtimeSessionId: "chat" }),
    };
    runtime.source.eventListener!(event);
    expect(runtime.shown[0]).toMatchObject({
      kind: "chat-snooze",
      title: "Return here",
      body: "You asked to come back to this chat.",
      navigationPath: "session:chat/thread:thread-1",
    });
    runtime.actions[0]!({
      notificationId: runtime.shown[0]!.id,
      actionId: null,
      actionType: "open",
    });
    expect(runtime.dispatched[0]?.navigationPath).toBe("session:chat/thread:thread-1");
    runtime.setPresented(true);
    runtime.source.eventListener!(event);
    expect(runtime.shown).toHaveLength(1);
    const disabled = setup({ turnMode: "off", questionsEnabled: true, readbackEnabled: true });
    disabled.source.eventListener!(event);
    expect(disabled.shown).toHaveLength(0);
  });

  test("managed chat completion stays quiet while questions and approvals keep notifying", () => {
    const runtime = setup({ turnMode: "always", questionsEnabled: true, readbackEnabled: true });
    const event = {
      type: "turn-completed" as const,
      hostId: "local",
      conversation: conversation(),
      turnId: "managed:turn",
      status: "completed" as const,
      lastAgentMessage: "Done",
      heartbeatAssistantMessage: null,
      automationNotificationDecision: null,
      hasPendingContinuation: false,
    };
    runtime.handle(event, { managed: true });
    expect(runtime.shown).toHaveLength(0);
    runtime.handle(event, { managed: false });
    expect(runtime.shown.map((n) => n.kind)).toEqual(["turn-complete"]);
    runtime.handle(
      {
        type: "user-input-requested",
        hostId: "local",
        conversation: conversation(),
        turnId: "managed:turn",
        requestId: "question",
        questionCount: 1,
      },
      { managed: true },
    );
    runtime.handle(
      {
        type: "approval-requested",
        hostId: "local",
        conversation: conversation(),
        turnId: "managed:turn",
        requestId: "approval",
        prompt: "Push?",
      },
      { managed: true },
    );
    expect(runtime.shown.map((n) => n.kind)).toEqual(["turn-complete", "question", "question"]);
    expect(runtime.shown[2]?.id).toBe("approval-local-approval");
  });
});

describe("codex-conversation-snapshot", () => {
  function buildThreadDetail(overrides?: Partial<CodexThreadDetail>): CodexThreadDetail {
    return {
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
      linkedAt: "2026-03-22T00:00:00.000Z",
      turns: [
        {
          threadId: "thread_1",
          turnId: "turn_1",
          status: "completed",
          itemIds: ["assistant_1", "user_1"],
        },
      ],
      transcript: [
        {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "assistant_1",
          type: "assistant_message",
          kind: "assistantMessage",
          semanticKind: "assistantMessage",
          role: "assistant",
          sequence: 2,
          markdownText: "Answer",
          createdAt: 2,
          updatedAt: 2,
        },
        {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "user_1",
          type: "user_message",
          kind: "userMessage",
          semanticKind: "userMessage",
          role: "user",
          sequence: 1,
          markdownText: "Question",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      ...overrides,
      hasUnreadTurn: overrides?.hasUnreadTurn ?? false,
    };
  }

  describe("buildCodexConversationSnapshot", () => {
    test("carries the lossless canonical document without reconstructing it from view turns", () => {
      const canonicalState = {
        ...{ id: "thread_1" },
        turns: [{ turnId: "turn_1", items: [{ id: "hidden-1" }] }],
        requests: [{ id: 7 }],
        hasUnreadTurn: true,
      } as unknown as CodexCanonicalConversationState;
      const snapshot = buildCodexConversationSnapshot({
        detail: buildThreadDetail(),
        resumeState: "resumed",
        requests: [],
        canonicalState,
        capabilityFlags: {
          canEditUserTurns: true,
          canForkFromTurn: true,
          canSearch: true,
          canCollapseTurns: true,
        },
      });

      expect(snapshot.canonicalState === canonicalState).toBe(true);
      expect(snapshot.canonicalState?.turns[0]?.items[0]?.id).toBe("hidden-1");
      expect(snapshot.canonicalState?.requests[0]?.id).toBe(7);
    });

    test("orders turn items by the canonical turn itemIds instead of transcript sequence", () => {
      const request: CodexApprovalRequest = {
        type: "approval",
        requestId: "approval_1",
        kind: "command",
        projectId: "project_1",
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "assistant_1",
        createdAt: 5,
      };

      const snapshot = buildCodexConversationSnapshot({
        detail: buildThreadDetail(),
        resumeState: "resumed",
        requests: [request],
        capabilityFlags: {
          canEditUserTurns: true,
          canForkFromTurn: true,
          canSearch: true,
          canCollapseTurns: true,
        },
      });

      expect(snapshot.turns.length).toBe(1);
      expect(snapshot.turns[0]?.items[0]?.itemId).toBe("assistant_1");
      expect(snapshot.turns[0]?.items[1]?.itemId).toBe("user_1");
      expect(snapshot.requests[0]?.requestId).toBe("approval_1");
      expect(snapshot.capabilityFlags.canSearch).toBe(true);
      expect(snapshot.turnPagination?.hasLoadedOldest ?? false).toBe(true);
      expect(snapshot.turnPagination?.loadedTurnCount ?? 0).toBe(1);
    });

    test("keeps app-local null-id goal turns separate by projected item identity", () => {
      const nullTurnId = null as unknown as string;
      const detail = buildThreadDetail({
        turns: [
          {
            threadId: "thread_1",
            turnId: nullTurnId,
            status: "completed",
            itemIds: ["goal_1"],
          },
          {
            threadId: "thread_1",
            turnId: nullTurnId,
            status: "completed",
            itemIds: ["goal_2"],
          },
        ],
        transcript: [
          {
            threadId: "thread_1",
            turnId: nullTurnId,
            itemId: "goal_1",
            type: "user_message",
            kind: "userMessage",
            semanticKind: "userMessage",
            role: "user",
            sequence: 1,
            markdownText: "First goal",
            goal: true,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            threadId: "thread_1",
            turnId: nullTurnId,
            itemId: "goal_2",
            type: "user_message",
            kind: "userMessage",
            semanticKind: "userMessage",
            role: "user",
            sequence: 2,
            markdownText: "Second goal",
            goal: true,
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      });
      const snapshot = buildCodexConversationSnapshot({
        detail,
        resumeState: "resumed",
        requests: [],
        capabilityFlags: {
          canEditUserTurns: true,
          canForkFromTurn: true,
          canSearch: true,
          canCollapseTurns: true,
        },
      });

      expect(snapshot.turns[0]?.items[0]?.markdownText).toBe("First goal");
      expect(snapshot.turns[1]?.items[0]?.markdownText).toBe("Second goal");
      expect(String(snapshot.turns[0]?.items.length ?? -1)).toBe("1");
      expect(String(snapshot.turns[1]?.items.length ?? -1)).toBe("1");
    });

    test("preserves protocol-backed turn pagination metadata", () => {
      const snapshot = buildCodexConversationSnapshot({
        detail: buildThreadDetail(),
        resumeState: "resumed",
        requests: [],
        capabilityFlags: {
          canEditUserTurns: true,
          canForkFromTurn: true,
          canSearch: true,
          canCollapseTurns: true,
        },
        turnPagination: {
          olderCursor: "cursor-older",
          backwardsCursor: "cursor-newer",
          oldestLoadedTurnId: "turn_older",
          isLoadingOlder: false,
          hasLoadedOldest: false,
          loadedTurnCount: 50,
          itemsView: "full",
        },
      });

      expect(snapshot.turnPagination?.olderCursor ?? null).toBe("cursor-older");
      expect(snapshot.turnPagination?.backwardsCursor ?? null).toBe("cursor-newer");
      expect(snapshot.turnPagination?.oldestLoadedTurnId ?? null).toBe("turn_older");
      expect(snapshot.turnPagination?.hasLoadedOldest ?? true).toBe(false);
      expect(snapshot.turnPagination?.itemsView ?? "summary").toBe("full");
    });

    test("appends unknown turn entries after known itemIds using transcript fallback order", () => {
      const snapshot = buildCodexConversationSnapshot({
        detail: buildThreadDetail({
          turns: [
            {
              threadId: "thread_1",
              turnId: "turn_1",
              status: "completed",
              itemIds: ["assistant_1", "user_1"],
            },
          ],
          transcript: [
            ...buildThreadDetail().transcript,
            {
              threadId: "thread_1",
              turnId: "turn_1",
              itemId: "tool_1",
              type: "function_call",
              kind: "toolCall",
              semanticKind: "toolCall",
              sequence: 0,
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        }),
        resumeState: "resumed",
        requests: [],
        capabilityFlags: {
          canEditUserTurns: true,
          canForkFromTurn: true,
          canSearch: true,
          canCollapseTurns: true,
        },
      });

      expect(snapshot.turns[0]?.items.length).toBe(3);
      expect(snapshot.turns[0]?.items[0]?.itemId).toBe("assistant_1");
      expect(snapshot.turns[0]?.items[1]?.itemId).toBe("user_1");
      expect(snapshot.turns[0]?.items[2]?.itemId).toBe("tool_1");
    });

    test("keeps the params input before canonical raw items", () => {
      const detail = buildThreadDetail({
        turns: [
          {
            threadId: "thread_1",
            turnId: "turn_1",
            status: "completed",
            itemIds: ["tool_1", "assistant_1"],
          },
        ],
        transcript: [
          {
            threadId: "thread_1",
            turnId: "turn_1",
            itemId: "tool_1",
            type: "commandExecution",
            kind: "commandExecution",
            semanticKind: "exec",
            sequence: 1,
            createdAt: 2,
            updatedAt: 2,
          },
          {
            threadId: "thread_1",
            turnId: "turn_1",
            itemId: "assistant_1",
            type: "agentMessage",
            kind: "assistantMessage",
            semanticKind: "assistantMessage",
            sequence: 2,
            createdAt: 3,
            updatedAt: 3,
          },
          {
            threadId: "thread_1",
            turnId: "turn_1",
            itemId: "turn_1:input",
            type: "userMessage",
            kind: "userMessage",
            semanticKind: "userMessage",
            sequence: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      });
      const snapshot = buildCodexConversationSnapshot({
        detail,
        resumeState: "resumed",
        requests: [],
        capabilityFlags: {
          canEditUserTurns: true,
          canForkFromTurn: true,
          canSearch: true,
          canCollapseTurns: true,
        },
      });

      expect(snapshot.turns[0]?.items.map((item) => item.itemId)).toEqual([
        "turn_1:input",
        "tool_1",
        "assistant_1",
      ]);
    });

    test("orders synthetic steer entries with canonical turn item ids", () => {
      const snapshot = buildCodexConversationSnapshot({
        detail: buildThreadDetail({
          turns: [
            {
              threadId: "thread_1",
              turnId: "turn_1",
              status: "completed",
              itemIds: ["assistant_before", "steer_1", "user_msg_1:steered", "assistant_after"],
            },
          ],
          transcript: [
            {
              threadId: "thread_1",
              turnId: "turn_1",
              itemId: "assistant_after",
              type: "agentMessage",
              kind: "assistantMessage",
              semanticKind: "assistantMessage",
              role: "assistant",
              sequence: 4,
              markdownText: "Answer after steering",
              createdAt: 4,
              updatedAt: 4,
            },
            {
              threadId: "thread_1",
              turnId: "turn_1",
              itemId: "steer_1",
              type: "steeringUserMessage",
              kind: "userMessage",
              semanticKind: "userMessage",
              role: "user",
              steeringStatus: "accepted",
              sequence: 2,
              markdownText: "who are you",
              createdAt: 2,
              updatedAt: 2,
            },
            {
              threadId: "thread_1",
              turnId: "turn_1",
              itemId: "assistant_before",
              type: "agentMessage",
              kind: "assistantMessage",
              semanticKind: "assistantMessage",
              role: "assistant",
              sequence: 1,
              markdownText: "Answer before steering",
              createdAt: 1,
              updatedAt: 1,
            },
            {
              threadId: "thread_1",
              turnId: "turn_1",
              itemId: "user_msg_1:steered",
              type: "steered",
              kind: "systemEvent",
              semanticKind: "steered",
              sequence: 3,
              markdownText: "Steered conversation",
              createdAt: 3,
              updatedAt: 3,
            },
          ],
        }),
        resumeState: "resumed",
        requests: [],
        capabilityFlags: {
          canEditUserTurns: true,
          canForkFromTurn: true,
          canSearch: true,
          canCollapseTurns: true,
        },
      });

      expect(snapshot.turns[0]?.items.map((item) => item.itemId).join(",")).toBe(
        "assistant_before,steer_1,user_msg_1:steered,assistant_after",
      );
    });
  });
});

describe("dynamic-tool-registry", () => {
  describe("dynamic-tool-registry", () => {
    interface TestContext {
      readonly trace: string[];
    }

    function registerEcho(
      registry: DynamicToolRegistry<TestContext>,
      namespace: string,
      toolsetRevision: number,
      marker: string,
    ): void {
      registry.register({
        namespace,
        namespaceDescription: `${namespace} tools`,
        toolsetRevision,
        tool: "echo",
        description: `Echo through ${namespace}`,
        inputSchema: z.strictObject({ value: z.string().min(1) }),
        outputSchema: z.strictObject({ echoed: z.string() }),
        deferLoading: false,
        classifyEffect: () => "read",
        execute: ({ input, context }) => {
          context.trace.push(marker);
          return { echoed: `${marker}:${input.value}` };
        },
      });
    }

    describe("DynamicToolRegistry", () => {
      test("dispatches the same tool name independently by namespace and revision", async () => {
        const registry = new DynamicToolRegistry<TestContext>();
        registerEcho(registry, "codex_app", 1, "codex");
        registerEcho(registry, "nodex_app", 1, "nodex-v1");
        registerEcho(registry, "nodex_app", 2, "nodex-v2");
        const context: TestContext = { trace: [] };

        const codex = await registry.execute(
          {
            namespace: "codex_app",
            toolsetRevision: 1,
            tool: "echo",
          },
          { value: "one" },
          context,
        );
        const nodex = await registry.execute(
          {
            namespace: "nodex_app",
            toolsetRevision: 2,
            tool: "echo",
          },
          { value: "two" },
          context,
        );

        expect(codex).toEqual({ effect: "read", output: { echoed: "codex:one" } });
        expect(nodex).toEqual({ effect: "read", output: { echoed: "nodex-v2:two" } });
        expect(context.trace).toEqual(["codex", "nodex-v2"]);
      });

      test("generates strict app-server JSON Schema from the registered Zod schema", () => {
        const registry = new DynamicToolRegistry<TestContext>();
        registerEcho(registry, "nodex_app", 1, "nodex");

        const catalog = registry.buildCatalog([
          {
            namespace: "nodex_app",
            toolsetRevision: 1,
          },
        ]);
        const namespace = catalog[0];
        expect(namespace?.type).toBe("namespace");
        if (!namespace || namespace.type !== "namespace") return;
        const schema = namespace.tools[0]?.inputSchema as Record<string, unknown>;

        expect(namespace.name).toBe("nodex_app");
        expect(namespace.tools[0]?.name).toBe("echo");
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required).toEqual(["value"]);
      });

      test("rejects unknown keys before execution", async () => {
        const registry = new DynamicToolRegistry<TestContext>();
        registerEcho(registry, "nodex_app", 1, "nodex");
        const context: TestContext = { trace: [] };

        await expect(
          registry.execute(
            {
              namespace: "nodex_app",
              toolsetRevision: 1,
              tool: "echo",
            },
            { value: "hello", projectId: "forged" },
            context,
          ),
        ).rejects.toMatchObject({
          code: "invalid_arguments",
        });
        expect(context.trace).toEqual([]);
      });

      test("distinguishes stale catalogs from unknown tools", async () => {
        const registry = new DynamicToolRegistry<TestContext>();
        registerEcho(registry, "nodex_app", 1, "nodex");
        const context: TestContext = { trace: [] };

        await expect(
          registry.execute(
            {
              namespace: "nodex_app",
              toolsetRevision: 99,
              tool: "echo",
            },
            { value: "hello" },
            context,
          ),
        ).rejects.toMatchObject({
          code: "tool_catalog_stale",
        });
        await expect(
          registry.execute(
            {
              namespace: "nodex_app",
              toolsetRevision: 1,
              tool: "missing",
            },
            { value: "hello" },
            context,
          ),
        ).rejects.toMatchObject({
          code: "tool_not_found",
        });
      });

      test("rejects duplicate registrations and invalid executor output", async () => {
        const registry = new DynamicToolRegistry<TestContext>();
        registerEcho(registry, "nodex_app", 1, "nodex");
        expect(() => registerEcho(registry, "nodex_app", 1, "duplicate")).toThrow(
          DynamicToolRegistryError,
        );

        registry.register({
          namespace: "nodex_app",
          namespaceDescription: "nodex_app tools",
          toolsetRevision: 1,
          tool: "broken",
          description: "Returns the wrong output for the test",
          inputSchema: z.strictObject({}),
          outputSchema: z.strictObject({ ok: z.literal(true) }),
          classifyEffect: () => "write",
          execute: () => ({ ok: false }) as unknown as { ok: true },
        });

        await expect(
          registry.execute(
            {
              namespace: "nodex_app",
              toolsetRevision: 1,
              tool: "broken",
            },
            {},
            { trace: [] },
          ),
        ).rejects.toMatchObject({ code: "invalid_output" });
      });
    });
  });

  describe("codex-dynamic-tool-catalog-bindings", () => {
    describe("resolveDynamicToolCatalogBindings", () => {
      test("binds every injected namespace to its host-owned current revision", () => {
        expect(
          resolveDynamicToolCatalogBindings([
            {
              type: "namespace",
              name: CODEX_APP_TOOL_NAMESPACE,
              description: "Codex app tools",
              tools: [],
            },
            {
              type: "namespace",
              name: NODEX_APP_TOOL_NAMESPACE,
              description: "Nodex content tools",
              tools: [],
            },
          ]),
        ).toEqual([
          {
            namespace: CODEX_APP_TOOL_NAMESPACE,
            toolsetRevision: CODEX_APP_TOOLSET_REVISION,
          },
          {
            namespace: NODEX_APP_TOOL_NAMESPACE,
            toolsetRevision: NODEX_APP_TOOLSET_REVISION,
          },
        ]);
      });

      test("rejects unnamespaced, duplicate, and unversioned catalogs", () => {
        expect(() =>
          resolveDynamicToolCatalogBindings([
            {
              type: "function",
              name: "loose",
              description: "Loose tool",
              inputSchema: {},
            },
          ]),
        ).toThrow("every dynamic tool to belong to a namespace");

        expect(() =>
          resolveDynamicToolCatalogBindings([
            { type: "namespace", name: "codex_app", description: "First", tools: [] },
            { type: "namespace", name: "codex_app", description: "Second", tools: [] },
          ]),
        ).toThrow("Duplicate dynamic-tool namespace");

        expect(() =>
          resolveDynamicToolCatalogBindings([
            {
              type: "namespace",
              name: "foreign_app",
              description: "Foreign tools",
              tools: [],
            },
          ]),
        ).toThrow("No toolset revision is registered");
      });
    });
  });

  describe("nodex-dynamic-tool-registry", () => {
    function unimplemented(): never {
      throw new Error("Executor is not used by this catalog test");
    }

    describe("createNodexV3DynamicToolRegistry", () => {
      test("publishes the compact-identity catalog with only common reads eager", () => {
        const handlers = Object.fromEntries(
          NODEX_APP_V6_TOOLS.map((tool) => [tool, unimplemented]),
        ) as unknown as NodexAgentV3ToolHandlers<null>;
        const registry = createNodexV3DynamicToolRegistry(handlers);
        const catalog = registry.buildCatalog([
          {
            namespace: NODEX_APP_TOOL_NAMESPACE,
            toolsetRevision: NODEX_APP_V6_TOOLSET_REVISION,
          },
        ]);
        const namespace = catalog[0];
        expect(namespace?.type).toBe("namespace");
        if (!namespace || namespace.type !== "namespace") return;

        expect(namespace.description).toContain(NODEX_MARKDOWN_COMPACT_HINT);
        expect(namespace.description).not.toMatch(/\bNFM\b|Nested Markdown/u);
        expect(namespace.tools.map((tool) => tool.name).sort()).toEqual(
          [...NODEX_APP_V6_TOOLS].sort(),
        );
        expect(
          namespace.tools
            .filter((tool) => tool.deferLoading === false)
            .map((tool) => tool.name)
            .sort(),
        ).toEqual(["fetch", "get_context", "search"]);
      });
    });
  });

  describe("dynamic-tool-catalog-metrics", () => {
    describe("Nodex Agent catalog metrics", () => {
      test("renders one deterministic table with all cost centers", () => {
        const metrics = measureDynamicToolCatalog(buildNodexAgentV3DynamicToolCatalog());
        const first = formatDynamicToolCatalogMetrics(metrics);
        const second = formatDynamicToolCatalogMetrics(metrics);

        expect(first).toBe(second);
        expect(first.split("\n").filter((line) => line.includes("complete catalog"))).toHaveLength(
          1,
        );
        for (const tool of metrics.tools) {
          expect(first.split("\n").filter((line) => line.startsWith(tool.name))).toHaveLength(1);
        }
      });

      test("rejects an absent or ambiguous namespace", () => {
        expect(() => measureDynamicToolCatalog([])).toThrow("exactly one dynamic-tool namespace");
        const catalog = buildNodexAgentV3DynamicToolCatalog();
        expect(() => measureDynamicToolCatalog([...catalog, ...catalog])).toThrow(
          "exactly one dynamic-tool namespace",
        );
      });

      test("keeps v3 within common-path and intent-tool budgets", () => {
        const catalog = buildNodexAgentV3DynamicToolCatalog();
        const metrics = measureDynamicToolCatalog(catalog);

        expect(metrics.eagerBytes).toBeLessThanOrEqual(NODEX_AGENT_V3_CATALOG_BUDGETS.eagerBytes);
        expect(metrics.completeBytes).toBeLessThanOrEqual(
          NODEX_AGENT_V3_CATALOG_BUDGETS.completeBytes,
        );
        for (const tool of metrics.tools) {
          const budget =
            NODEX_AGENT_V3_CATALOG_BUDGETS.tools[
              tool.name as keyof typeof NODEX_AGENT_V3_CATALOG_BUDGETS.tools
            ];
          if (budget === undefined) continue;
          expect(tool.totalBytes, tool.name).toBeLessThanOrEqual(budget);
        }

        const namespace = catalog[0];
        expect(namespace?.type).toBe("namespace");
        if (!namespace || namespace.type !== "namespace") return;
        expect(namespace.description.split(NODEX_MARKDOWN_COMPACT_HINT)).toHaveLength(2);
        expect(Buffer.byteLength(NODEX_MARKDOWN_COMPACT_HINT, "utf8")).toBeLessThanOrEqual(
          NODEX_AGENT_V3_CATALOG_BUDGETS.namespaceHintBytes,
        );
        const serialized = JSON.stringify(catalog);
        expect(serialized).not.toContain(NODEX_MARKDOWN_AGENT_GUIDE.instructions);
        // The eager catalog names the one language and no retired format.
        expect(serialized).not.toMatch(/\bNFM\b|Nested Markdown|\bgfm\b/u);
        expect(
          namespace.tools.filter((tool) => tool.deferLoading !== true).map((tool) => tool.name),
        ).toEqual(["fetch", "get_context", "search"]);
      });
    });
  });
});

describe("codex app meta thread tool specs", () => {
  test("advertises the Codex app meta thread tools in the codex_app namespace", () => {
    const specs = buildCodexAppMetaThreadToolSpecs({ handoffEnabled: true });
    const namespace = specs[0];
    const tools = namespace?.type === "namespace" ? namespace.tools : [];
    const toolNames = tools.map((spec) => spec.name).sort();

    expect(specs.length).toBe(1);
    expect(namespace?.type).toBe("namespace");
    expect(namespace?.name).toBe("codex_app");
    expect(JSON.stringify(toolNames)).toBe(
      JSON.stringify(
        [
          "automations_update",
          "create_sidebar_section",
          "create_thread",
          "delete_sidebar_section",
          "fork_thread",
          "get_handoff_status",
          "handoff_thread",
          "list_projects",
          "list_threads",
          "move_project_to_sidebar_section",
          "move_thread_to_sidebar_section",
          "read_thread",
          "read_thread_terminal",
          "rename_sidebar_section",
          "reorder_section",
          "reorder_sidebar_projects",
          "reorder_sidebar_sections",
          "send_message_to_thread",
          "set_thread_archived",
          "set_thread_pinned",
          "set_thread_title",
          "wait_threads",
        ].sort(),
      ),
    );
    expect(tools.every((spec) => spec.type === "function")).toBe(true);

    const createThread = tools.find((spec) => spec.name === "create_thread");
    const forkThread = tools.find((spec) => spec.name === "fork_thread");
    const readThread = tools.find((spec) => spec.name === "read_thread");
    const sendMessage = tools.find((spec) => spec.name === "send_message_to_thread");
    const automationUpdate = tools.find((spec) => spec.name === "automations_update");
    const listThreads = tools.find((spec) => spec.name === "list_threads");
    const moveTask = tools.find((spec) => spec.name === "move_thread_to_sidebar_section");

    expect(JSON.stringify((createThread?.inputSchema as Record<string, unknown>).required)).toBe(
      JSON.stringify(["prompt", "target"]),
    );
    const createTarget = (
      createThread?.inputSchema as {
        properties?: { target?: { anyOf?: Array<{ properties?: Record<string, unknown> }> } };
      }
    ).properties?.target;
    const projectTarget = createTarget?.anyOf?.find(
      (branch) => branch.properties?.environment !== undefined,
    );
    const projectEnvironment = projectTarget?.properties?.environment as
      | {
          description?: string;
        }
      | undefined;
    expect(projectEnvironment?.description).toBe(
      "Where the project thread should run: directly in the saved project or in a new worktree.",
    );
    const forkEnvironment = (
      forkThread?.inputSchema as {
        properties?: { environment?: { anyOf?: Array<{ properties?: Record<string, unknown> }> } };
      }
    ).properties?.environment;
    const forkWorktree = forkEnvironment?.anyOf?.find((branch) => {
      const type = branch.properties?.type as { enum?: string[] } | undefined;
      return type?.enum?.[0] === "worktree";
    });
    expect(
      Object.prototype.hasOwnProperty.call(forkWorktree?.properties ?? {}, "startingState"),
    ).toBe(false);
    expect(
      JSON.stringify(
        (readThread?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      ).includes("maxOutputCharsPerItem"),
    ).toBe(true);
    expect(JSON.stringify((sendMessage?.inputSchema as Record<string, unknown>).required)).toBe(
      JSON.stringify(["threadId", "prompt"]),
    );
    expect(listThreads?.description).toContain("user-controlled data");
    expect(JSON.stringify((moveTask?.inputSchema as Record<string, unknown>).required)).toBe(
      JSON.stringify(["threadId", "sectionId"]),
    );
    // One object for every provider: operations and kinds are enums, not top-level branches.
    const automationSchema = automationUpdate?.inputSchema as {
      readonly type?: string;
      readonly properties?: Record<string, { readonly enum?: readonly string[] }>;
    };
    expect(automationSchema.type).toBe("object");
    expect([...(automationSchema.properties?.operation?.enum ?? [])].sort()).toEqual(
      ["create", "delete", "list", "suggested_create", "suggested_update", "update", "view"].sort(),
    );
    expect(automationSchema.properties?.kind?.enum).toContain("heartbeat");
    expect(automationSchema.properties).toHaveProperty("localEnvironmentConfigPath");
  });

  test("does not advertise handoff before the transaction capability is ready", () => {
    const namespace = buildCodexAppMetaThreadToolSpecs()[0];
    const tools = namespace?.type === "namespace" ? namespace.tools : [];
    expect(tools.some((tool) => tool.name === "handoff_thread")).toBe(false);
    expect(tools.some((tool) => tool.name === "get_handoff_status")).toBe(false);
  });

  test("exposes only capability-checked cross-host destinations", () => {
    const namespace = buildCodexAppMetaThreadToolSpecs({
      handoffEnabled: true,
      crossHostHandoffEnabled: true,
      availableHandoffHosts: [
        { id: "local", displayName: "Local" },
        { id: "ssh:build", displayName: "Build Mac" },
      ],
    })[0];
    const handoff =
      namespace?.type === "namespace"
        ? namespace.tools.find((tool) => tool.name === "handoff_thread")
        : undefined;
    const destination = (
      handoff?.inputSchema as {
        properties?: { destinationHostId?: { enum?: string[]; description?: string } };
      }
    ).properties?.destinationHostId;

    expect(destination?.enum).toEqual(["local", "ssh:build"]);
    expect(destination?.description).toContain("Build Mac (ssh:build)");
  });

  test("wraps dynamic tool responses in app-server content items", () => {
    const success = buildCodexAppDynamicToolSuccess({ threadId: "thread-1" });
    const failure = buildCodexAppDynamicToolFailure("No Codex thread found");
    const successText =
      success.contentItems[0]?.type === "inputText" ? success.contentItems[0].text : null;
    const failureText =
      failure.contentItems[0]?.type === "inputText" ? failure.contentItems[0].text : null;

    expect(success.success).toBe(true);
    expect(success.contentItems[0]?.type).toBe("inputText");
    expect(successText).toBe('{"threadId":"thread-1"}');
    expect(failure.success).toBe(false);
    expect(failureText).toBe("No Codex thread found");
  });

  test("describes the live model and reasoning matrix in thread tool schemas", () => {
    const namespace = buildCodexAppMetaThreadToolSpecs({
      availableModels: [
        {
          model: "gpt-live",
          description: "Live model",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
        },
      ],
    })[0];
    const tools = namespace?.type === "namespace" ? namespace.tools : [];
    const createThread = tools.find((tool) => tool.name === "create_thread");
    const properties = (
      createThread?.inputSchema as
        | {
            properties?: Record<string, { description?: string }>;
          }
        | undefined
    )?.properties;
    const description = properties?.model?.description ?? "";

    expect(
      description.includes("gpt-live (Live model; supported reasoning efforts: medium, high)"),
    ).toBe(true);
    expect(
      description.includes("omit thinking unless its supported reasoning efforts are listed here"),
    ).toBe(true);
  });
});
