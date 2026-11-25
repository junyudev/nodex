import { describe, expect, it, test } from "vite-plus/test";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalConversationState,
  type CodexCanonicalItem,
  type CodexCanonicalTurnState,
} from "./codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import {
  hasPendingConversationTurnStart,
  latestConversationTurn,
  latestResidentConversationTurn,
} from "./codex-conversation-state/codex-turn-selectors";
import type { CodexHistoryBoundary } from "./codex-conversation-state/codex-history-topology";
import {
  canAutomaticallySendQueuedMessage,
  resumeInterruptedQueuedMessage,
} from "./codex-queued-message-policy";
import { CODEX_INTERRUPTED_STEER_REASON } from "./codex-queued-follow-up-state";
import {
  queuedMessagePromptInput,
  captureCodexQueuedMessage,
  createCodexQueuedMessageDeliveryReceipt,
  readCodexQueuedMessageDeliveryReceipt,
  type CodexQueuedMessage,
} from "./codex-queued-message";

describe("codex queued message policy", () => {
  const base = createCodexCanonicalHydratedConversationState(
    {
      ...buildAgentActivityV2CorpusThread([]),
      turns: [
        {
          rootTurnId: null,
          id: "turn",
          status: "completed",
          items: [],
          itemsView: "full",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      ],
    },
    {
      hostId: "local",
      model: "model",
      reasoningEffort: null,
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace"],
    },
  );
  const turn = (patch: Partial<CodexCanonicalTurnState> = {}): CodexCanonicalTurnState => ({
    ...base.turns[0]!,
    ...patch,
  });
  const assistant: CodexCanonicalItem = {
    type: "agentMessage",
    moderation: null,
    id: "answer",
    text: "done",
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  const user: CodexCanonicalItem = { type: "userMessage", id: "user", clientId: null, content: [] };
  const state = (turns: readonly CodexCanonicalTurnState[]): CodexCanonicalConversationState => ({
    ...base,
    resumeState: "resumed",
    turns,
  });
  const admit = (conversation: CodexCanonicalConversationState | null) =>
    canAutomaticallySendQueuedMessage({ conversation, role: { role: "owner" }, message: {} });

  describe("queued message admission", () => {
    it.each([
      ["failed", "failed", [assistant], false],
      ["interrupted", "interrupted", [assistant], false],
      ["active", "inProgress", [assistant], false],
      ["empty completion", "completed", [], false],
      ["user-only completion", "completed", [user], false],
      ["assistant completion", "completed", [assistant], true],
      [
        "manual compaction",
        "completed",
        [{ type: "contextCompaction", id: "compact", source: "manual" }],
        true,
      ],
      [
        "automatic compaction",
        "completed",
        [{ type: "contextCompaction", id: "compact", source: "automatic" }],
        false,
      ],
      [
        "unknown compaction source",
        "completed",
        [{ type: "contextCompaction", id: "compact" }],
        false,
      ],
    ] satisfies [string, CodexCanonicalTurnState["status"], CodexCanonicalItem[], boolean][])(
      "%s ending has the required execution evidence",
      (_label, status, items, allowed) => {
        expect(admit(state([turn({ status, items })]))).toBe(allowed);
      },
    );

    it("permits empty or resumable history, but never a missing conversation, follower, pause or running turn", () => {
      expect(admit(null)).toBe(false);
      expect(admit(state([]))).toBe(true);
      const interrupted = state([turn({ status: "interrupted" })]);
      expect(admit({ ...interrupted, resumeState: "needs_resume" })).toBe(true);
      expect(
        canAutomaticallySendQueuedMessage({ conversation: interrupted, message: {}, role: null }),
      ).toBe(true);
      const resumable = {
        ...state([turn({ status: "inProgress" })]),
        resumeState: "needs_resume" as const,
      };
      expect(admit(resumable)).toBe(false);
      expect(
        canAutomaticallySendQueuedMessage({
          conversation: state([]),
          message: {},
          role: { role: "follower", ownerClientId: "owner" },
        }),
      ).toBe(false);
      expect(
        canAutomaticallySendQueuedMessage({
          conversation: state([]),
          message: { pausedReason: "failed" },
          role: { role: "owner" },
        }),
      ).toBe(false);
    });

    it("clears only interruption pauses and preserves unrelated failure identity", () => {
      const failed = { id: "failed", pausedReason: "Connection failed" };
      const ready = { id: "ready" };
      expect(resumeInterruptedQueuedMessage(failed)).toBe(failed);
      expect(resumeInterruptedQueuedMessage(ready)).toBe(ready);
      expect(
        resumeInterruptedQueuedMessage({
          id: "stopped",
          pausedReason: CODEX_INTERRUPTED_STEER_REASON,
        }),
      ).toEqual({ id: "stopped" });
    });
  });

  describe("latest execution turn", () => {
    it("skips completed synthetic markers but preserves unbound running starts", () => {
      const previous = turn({ items: [assistant] });
      const marker = turn({ turnId: null, items: [user] });
      expect(latestConversationTurn(state([previous, marker]))).toBe(previous);
      expect(latestResidentConversationTurn(state([previous, marker]))).toBe(marker);
      expect(admit(state([previous, marker]))).toBe(true);
      const pending = turn({ turnId: null, status: "inProgress" });
      expect(latestConversationTurn(state([previous, pending, marker]))).toBe(pending);
      expect(hasPendingConversationTurnStart(state([previous, pending, marker]))).toBe(true);
      expect(admit(state([previous, pending, marker]))).toBe(false);
    });

    it.each(["exhausted", "opaque"] as const)(
      "uses resident history across a %s tail without adopting display overlays",
      (status) => {
        const previous = turn({ turnId: "resident", items: [assistant] });
        const marker = turn({ turnId: null });
        const boundary: CodexHistoryBoundary = { status, boundaryId: "newer" };
        const conversation: CodexCanonicalConversationState = {
          ...state([turn({ turnId: "overlay", status: "inProgress" })]),
          turnHistory: {
            kind: "canonical",
            history: {
              generation: 1,
              isComplete: false,
              entitiesByKey: { previous, marker },
              islands: [
                {
                  id: "older",
                  entries: [{ key: "previous", value: "previous" }],
                  olderBoundary: { status: "exhausted", boundaryId: "start" },
                  newerBoundary: { status: "opaque", boundaryId: "gap" },
                },
                {
                  id: "tail",
                  entries: [{ key: "marker", value: "marker" }],
                  olderBoundary: { status: "opaque", boundaryId: "gap" },
                  newerBoundary: boundary,
                },
              ],
            },
          },
        };
        expect(latestConversationTurn(conversation)).toBe(previous);
        expect(hasPendingConversationTurnStart(conversation)).toBe(false);
        expect(admit(conversation)).toBe(true);
      },
    );

    it("treats an unconfirmed native submission as a pending start even without a running turn", () => {
      expect(hasPendingConversationTurnStart(null)).toBe(false);
      expect(hasPendingConversationTurnStart(state([]))).toBe(false);
      expect(
        hasPendingConversationTurnStart({
          ...state([]),
          unconfirmedTurnSubmissions: [
            {
              requestId: "request",
              method: "turn/start",
              stage: "outcome-unknown",
              clientUserMessageId: "message",
            },
          ],
        }),
      ).toBe(true);
    });
  });
});

describe("codex queued message", () => {
  function captured(untrustedAppMessage?: unknown): CodexQueuedMessage {
    return {
      id: "captured-message",
      cwd: "/workspace",
      context: {
        prompt: "Inspect selection",
        fileAttachments: [],
        addedFiles: [],
        commentAttachments: [],
        imageAttachments: [],
        ...(untrustedAppMessage === undefined ? {} : { untrustedAppMessage }),
      },
    };
  }

  test("unknown delivery retains the complete captured execution intent across JSON restoration", () => {
    const message = {
      ...captured(),
      createdAt: 42,
      submissionOptions: { serviceTier: "fast" as const },
      writingBlockAdditionalContext: {
        draft: { value: "Captured draft context", kind: "untrusted" as const },
      },
      pausedReason: "Old operational pause",
    };
    const input = [{ type: "text" as const, text: "Actual dispatched input", text_elements: [] }];
    const receipt = createCodexQueuedMessageDeliveryReceipt("remote-a", message, input, {
      stage: "outcome-unknown",
      requestId: "physical-steer",
      method: "turn/steer",
    });
    const restored = JSON.parse(
      JSON.stringify({ ...message, pausedReason: "Actual delivery unknown", submission: receipt }),
    ) as CodexQueuedMessage;
    expect(readCodexQueuedMessageDeliveryReceipt(restored)).toEqual({
      ...receipt,
      captured: captureCodexQueuedMessage(message),
    });
    expect(readCodexQueuedMessageDeliveryReceipt(restored)?.captured).toMatchObject({
      createdAt: 42,
      submissionOptions: { serviceTier: "fast" },
      writingBlockAdditionalContext: {
        draft: { value: "Captured draft context", kind: "untrusted" },
      },
    });
    expect(readCodexQueuedMessageDeliveryReceipt(restored)?.captured.pausedReason).toBeUndefined();
  });

  test.each([
    { method: "thread/resume" },
    { requestId: Number.NaN },
    { status: "queued" },
    { captured: { ...captured(), submission: { status: "outcome-unknown" } } },
  ])("restored queue dispatch evidence rejects an invalid boundary field %j", (invalid) => {
    const receipt = createCodexQueuedMessageDeliveryReceipt("local", captured(), [], {
      stage: "outcome-unknown",
      requestId: 7,
      method: "turn/start",
    });
    expect(
      readCodexQueuedMessageDeliveryReceipt({
        ...captured(),
        submission: { ...receipt, ...invalid },
      }),
    ).toBeNull();
  });

  test("decodes persisted app provenance into editable typed input without retaining unrecognized fields", () => {
    const message: unknown = {
      source: "visualization",
      sourceId: "widget-a",
      text: "Inspect selection",
      structuredContent: { selected: [1, 3] },
      extra: "not a prompt field",
    };
    const restored = JSON.parse(JSON.stringify(captured(message))) as CodexQueuedMessage;
    const input = queuedMessagePromptInput(restored);
    expect(input.text).toBe("Inspect selection");
    expect(input.untrustedAppMessage).toEqual({
      source: "visualization",
      sourceId: "widget-a",
      text: "Inspect selection",
      structuredContent: { selected: [1, 3] },
    });
    expect(restored.context.untrustedAppMessage).toEqual(message);
  });

  test.each([undefined, null])(
    "omits absent app provenance in ordinary queued input: %s",
    (value) => {
      expect(queuedMessagePromptInput(captured(value)).untrustedAppMessage).toBeUndefined();
    },
  );

  test.each([
    "untrusted text",
    { source: "trusted_user", sourceId: "widget-a", text: "Inspect selection" },
    {
      source: "visualization",
      sourceId: "widget-a",
      text: "Inspect selection",
      structuredContent: [],
    },
  ])("rejects malformed persisted app provenance at the typed prompt boundary: %j", (value) => {
    expect(() => queuedMessagePromptInput(captured(value))).toThrow("app");
  });

  test("restores validated model context from both authored controls and captured app cards", () => {
    const attachments: unknown = [
      {
        id: "file-widget",
        kind: "context",
        sourceName: "Visualization changes",
        text: null,
        structuredContent: {
          edits: [{ target: "panel", changes: [{ label: "Size", value: 11 }] }],
        },
        imageAttachments: [],
        untrusted: false,
        extra: "not a prompt field",
      },
      {
        id: "app-card",
        title: "Map selection",
        text: "Selected one location",
        imageAttachments: [{ src: "data:image/png;base64,YQ==" }],
        composerAttachmentLayout: "pill",
        composerIcon: { alt: "Map", logoUrl: null },
        untrusted: true,
      },
    ];
    const message = captured();
    const restored = queuedMessagePromptInput({
      ...message,
      context: { ...message.context, mcpAppModelContextAttachments: attachments },
    }).mcpAppModelContextAttachments;
    expect(restored).toEqual([
      {
        id: "file-widget",
        kind: "context",
        sourceName: "Visualization changes",
        title: "Visualization changes",
        text: null,
        structuredContent: {
          edits: [{ target: "panel", changes: [{ label: "Size", value: 11 }] }],
        },
        imageAttachments: [],
        untrusted: true,
      },
      {
        id: "app-card",
        title: "Map selection",
        text: "Selected one location",
        imageAttachments: [{ src: "data:image/png;base64,YQ==" }],
        composerAttachmentLayout: "pill",
        composerIcon: { alt: "Map", logoUrl: null },
        untrusted: true,
      },
    ]);
    expect(attachments).not.toEqual(restored);
  });

  test.each([
    "context",
    [
      {
        id: "file-widget",
        sourceName: "Changes",
        text: null,
        imageAttachments: [],
        structuredContent: [],
      },
    ],
    [
      {
        id: "file-widget",
        title: "Changes",
        text: null,
        imageAttachments: [{ src: "https://example.com/image.png" }],
      },
    ],
    [
      {
        id: "file-widget",
        title: "Changes",
        text: null,
        imageAttachments: [],
        composerAttachmentLayout: "panel",
      },
    ],
  ])(
    "rejects malformed restored model context before editable prompt consumers: %j",
    (attachments) => {
      const message = captured();
      expect(() =>
        queuedMessagePromptInput({
          ...message,
          context: { ...message.context, mcpAppModelContextAttachments: attachments },
        }),
      ).toThrow(/app/i);
    },
  );
});
