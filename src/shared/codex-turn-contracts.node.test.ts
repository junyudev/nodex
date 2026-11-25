import { describe, expect, test, it } from "vite-plus/test";
import {
  formatCodexContextCompactionLabel,
  resolveCodexContextCompactionStatus,
} from "./codex-context-compaction-presentation";
import {
  parseCodexReasoningSummary,
  resolveCodexReasoningSummary,
} from "./codex-reasoning-summary-policy";
import { normalizeSteerTurnError, parseSteerTurnMismatchActualTurnId } from "./codex-steer-errors";
import {
  hasCodexPendingContinuation,
  isCodexConversationDesktopNotificationEligible,
  parseCodexHeartbeatAssistantMessage,
} from "./codex-turn-notification";
import type { CodexConversationSnapshot } from "./types";
import {
  insertOrderedStringIdsAfter,
  removeOrderedStringIds,
  upsertOrderedStringIds,
} from "./codex-turn-order";
import { buildCodexUserAttachmentsFromContent } from "./codex-user-attachment-projection";
import {
  canEditCodexConversationUserTurns,
  resolveEditableUserTurnIds,
  type EditableUserTurnCandidate,
} from "./codex-user-turn-edit";

describe("resolveCodexContextCompactionStatus", () => {
  test.each([
    { completed: false, turnStatus: "inProgress", expected: "inProgress" },
    { completed: false, turnStatus: "interrupted", expected: "interrupted" },
    { completed: false, turnStatus: "failed", expected: "interrupted" },
    { completed: false, turnStatus: "completed", expected: "completed" },
    { completed: true, turnStatus: "inProgress", expected: "completed" },
    { completed: true, turnStatus: "interrupted", expected: "completed" },
    { completed: undefined, turnStatus: "inProgress", expected: "completed" },
  ] as const)(
    "completed=$completed in a $turnStatus Turn is $expected",
    ({ completed, turnStatus, expected }) => {
      expect(resolveCodexContextCompactionStatus({ completed, turnStatus })).toBe(expected);
    },
  );
});

describe("formatCodexContextCompactionLabel", () => {
  test.each([
    [{ status: "inProgress", source: "automatic" }, "Compacting context"],
    [{ status: "inProgress", source: "manual" }, "Compacting context"],
    [
      { status: "inProgress", source: "automatic", showDelayNotice: true },
      "Compacting context · This can take a few minutes",
    ],
    [{ status: "interrupted", source: "automatic" }, "Compaction interrupted"],
    [{ status: "completed", source: "automatic" }, "Context automatically compacted"],
    [{ status: "completed", source: "manual" }, "Context compacted"],
    [
      { status: "inProgress", source: "automatic", proseSteps: true },
      "Optimizing the conversation",
    ],
    [
      { status: "inProgress", source: "automatic", proseSteps: true, showDelayNotice: true },
      "Optimizing the conversation · This can take a few minutes",
    ],
    [{ status: "interrupted", source: "manual", proseSteps: true }, "Optimization interrupted"],
    [{ status: "completed", source: "automatic", proseSteps: true }, "Optimized the conversation"],
    [{ status: "completed", source: "manual", proseSteps: true }, "Context compacted"],
  ] as const)("%j reads %s", (input, expected) => {
    expect(formatCodexContextCompactionLabel(input)).toBe(expected);
  });
});

describe("codex reasoning summary policy", () => {
  it("enables detailed summaries by default", () => {
    expect(resolveCodexReasoningSummary()).toBe("detailed");
    expect(resolveCodexReasoningSummary({ configuredSummary: "none" })).toBe("detailed");
  });

  it("preserves a configured mode when the capability is disabled", () => {
    expect(
      resolveCodexReasoningSummary({
        configuredSummary: "concise",
        concurrentReasoningSummaries: false,
      }),
    ).toBe("concise");
  });

  it("lets an explicit per-turn mode win over the feature default", () => {
    expect(resolveCodexReasoningSummary({ explicitSummary: "none" })).toBe("none");
    expect(resolveCodexReasoningSummary({ explicitSummary: "auto" })).toBe("auto");
    expect(resolveCodexReasoningSummary({ explicitSummary: null })).toBeNull();
  });

  it("rejects malformed protocol values at the boundary", () => {
    expect(parseCodexReasoningSummary("detailed")).toBe("detailed");
    expect(parseCodexReasoningSummary(null)).toBeNull();
    expect(parseCodexReasoningSummary("verbose")).toBeUndefined();
    expect(parseCodexReasoningSummary({})).toBeUndefined();
  });

  it("inherits an assigned Turn only when next settings leave summary absent", () => {
    expect(
      resolveCodexReasoningSummary({
        inheritedSummary: "auto",
        concurrentReasoningSummaries: false,
      }),
    ).toBe("auto");
    expect(
      resolveCodexReasoningSummary({
        inheritedSummary: "auto",
        configuredSummary: null,
        concurrentReasoningSummaries: false,
      }),
    ).toBeNull();
    expect(
      resolveCodexReasoningSummary({
        inheritedSummary: "auto",
        configuredSummary: "concise",
        concurrentReasoningSummaries: false,
      }),
    ).toBe("concise");
  });
});

describe("codex steer errors", () => {
  test.each([
    ["expected active turn id old but found new", "new"],
    ["expected active turn id `old` but found `new`", "new"],
    ['ExpectedTurnMismatch { expected: "old", actual: "new" }', "new"],
    ["expected active turn id 'old' but found 'new'", "'new'"],
    ["Expected active turn id old but found new", null],
    ["expected active turn id old but found", null],
    ["no active turn to steer", null],
  ])("decodes the native steering mismatch %s", (message, expected) => {
    const native = new Error(message);
    expect(parseSteerTurnMismatchActualTurnId(native)).toBe(expected);
    expect(
      parseSteerTurnMismatchActualTurnId(new Error("Peer action failed", { cause: native })),
    ).toBe(expected);
  });

  test("normalizes an ended native Turn while preserving other error identities", () => {
    const native = new Error("no active turn to steer");
    expect(
      normalizeSteerTurnError(new Error("Request failed", { cause: native }), "thread-a"),
    ).toMatchObject({
      name: "SteerTurnInactiveError",
      message: "Cannot steer conversation thread-a because its active turn already ended",
    });
    const denied = new Error("steering denied");
    expect(normalizeSteerTurnError(denied, "thread-a")).toBe(denied);
  });
});

describe("codex turn notification", () => {
  function baseConversation(
    overrides: Partial<CodexConversationSnapshot> = {},
  ): CodexConversationSnapshot {
    return {
      threadId: "thread-1",
      projectId: "project-1",
      source: null,
      ephemeral: false,
      threadSource: null,
      threadName: null,
      threadPreview: "",
      modelProvider: "openai",
      cwd: "/tmp/project",
      statusType: "idle",
      statusActiveFlags: [],
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      linkedAt: new Date(0).toISOString(),
      latestCollaborationMode: {
        mode: "default",
        settings: {
          model: "",
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
      latestThreadSettings: null,
      latestTokenUsageInfo: null,
      threadGoal: null,
      completedThreadGoal: null,
      threadGoalResumeConfirmation: null,
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
        canEditUserTurns: false,
        canForkFromTurn: false,
        canSearch: true,
        canCollapseTurns: true,
      },
      ...overrides,
      hasUnreadTurn: overrides.hasUnreadTurn ?? false,
    };
  }

  describe("codex-turn-notification helpers", () => {
    test("parses heartbeat notification decisions and removes heartbeat from visible text", () => {
      const heartbeat = parseCodexHeartbeatAssistantMessage(
        [
          "Visible summary.",
          "<heartbeat>",
          "<decision>NOTIFY</decision>",
          "<message>Review this now</message>",
          "</heartbeat>",
        ].join("\n"),
      );

      expect(heartbeat?.decision).toBe("NOTIFY");
      expect(heartbeat?.notificationMessage).toBe("Review this now");
      expect(heartbeat?.visibleText).toBe("Visible summary.");

      const suppressed = parseCodexHeartbeatAssistantMessage(
        ["No user-visible alert.", "<heartbeat><decision>DONT_NOTIFY</decision></heartbeat>"].join(
          "\n",
        ),
      );
      expect(suppressed?.decision).toBe("DONT_NOTIFY");
    });

    test("only excludes conversations with real parent provenance", () => {
      expect(isCodexConversationDesktopNotificationEligible(baseConversation())).toBe(true);
      expect(
        isCodexConversationDesktopNotificationEligible(baseConversation({ ephemeral: true })),
      ).toBe(true);
      expect(
        isCodexConversationDesktopNotificationEligible(
          baseConversation({ threadSource: "system" }),
        ),
      ).toBe(true);
      expect(
        isCodexConversationDesktopNotificationEligible(
          baseConversation({
            source: { parentThreadId: "parent", sideConversation: true },
          }),
        ),
      ).toBe(false);
      expect(
        isCodexConversationDesktopNotificationEligible(
          baseConversation({
            source: { parentThreadId: null, sideConversation: true },
          }),
        ),
      ).toBe(true);
    });

    test("matches exact terminal continuation semantics", () => {
      const facts = {
        terminalStatus: "completed" as const,
        queuedResourceLoading: false,
        queuedHeadPausedReason: undefined,
        threadGoalStatus: null,
        latestMergedTurnStatus: "completed" as const,
        hasRunningCollabAgent: false,
        hasActiveDescendant: false,
      };
      expect(hasCodexPendingContinuation(facts)).toBe(false);
      expect(
        hasCodexPendingContinuation({
          ...facts,
          queuedHeadPausedReason: null,
        }),
      ).toBe(true);
      expect(
        hasCodexPendingContinuation({
          ...facts,
          terminalStatus: "interrupted",
          queuedHeadPausedReason: null,
        }),
      ).toBe(false);
      expect(
        hasCodexPendingContinuation({
          ...facts,
          threadGoalStatus: "active",
        }),
      ).toBe(true);
      expect(
        hasCodexPendingContinuation({
          ...facts,
          terminalStatus: "failed",
          threadGoalStatus: "active",
        }),
      ).toBe(false);
      expect(
        hasCodexPendingContinuation({
          ...facts,
          terminalStatus: "interrupted",
          latestMergedTurnStatus: "inProgress",
        }),
      ).toBe(true);
      expect(
        hasCodexPendingContinuation({
          ...facts,
          hasRunningCollabAgent: true,
        }),
      ).toBe(true);
      expect(
        hasCodexPendingContinuation({
          ...facts,
          hasActiveDescendant: true,
        }),
      ).toBe(true);
    });
  });
});

describe("codex turn order helpers", () => {
  test("appends missing ids without duplicating existing order entries", () => {
    const result = upsertOrderedStringIds(["user_1", "exec_1"], ["exec_1", "steer_1", "steer_1"]);

    expect(result.join(",")).toBe("user_1,exec_1,steer_1");
  });

  test("inserts ids after an anchor while preserving surrounding order", () => {
    const result = insertOrderedStringIdsAfter(["user_1", "steer_1", "assistant_1"], "steer_1", [
      "steered_1",
    ]);

    expect(result.join(",")).toBe("user_1,steer_1,steered_1,assistant_1");
  });

  test("moves existing ids to the requested anchor position", () => {
    const result = insertOrderedStringIdsAfter(
      ["user_1", "steered_1", "steer_1", "assistant_1"],
      "steer_1",
      ["steered_1"],
    );

    expect(result.join(",")).toBe("user_1,steer_1,steered_1,assistant_1");
  });

  test("appends inserted ids when the anchor is missing", () => {
    const result = insertOrderedStringIdsAfter(["user_1"], "missing", ["steer_1", "steered_1"]);

    expect(result.join(",")).toBe("user_1,steer_1,steered_1");
  });

  test("removes all requested ids", () => {
    const result = removeOrderedStringIds(
      ["user_1", "steer_1", "steered_1"],
      ["steer_1", "missing"],
    );

    expect(result.join(",")).toBe("user_1,steered_1");
  });
});

describe("buildCodexUserAttachmentsFromContent", () => {
  test("preserves inline, local, and remote-pointer image source semantics", () => {
    expect(
      buildCodexUserAttachmentsFromContent(
        [
          { type: "image", url: "data:image/png;base64,aW1hZ2U=" },
          { type: "localImage", path: "/workspace/screenshot.png" },
          { type: "image_asset_pointer", asset_pointer: "file-service://asset-1" },
          { type: "image", fileId: "asset-2", detail: "original" },
        ],
        "user-1",
      ),
    ).toEqual([
      {
        type: "image",
        id: "user-1:attachment:image:0",
        source: "data:image/png;base64,aW1hZ2U=",
        sourceKind: "inline-image",
        caption: undefined,
      },
      {
        type: "image",
        id: "user-1:attachment:local-image:1",
        source: "/workspace/screenshot.png",
        sourceKind: "local-image",
        caption: undefined,
      },
      {
        type: "image",
        id: "user-1:attachment:remote-image:2",
        source: "file-service://asset-1",
        sourceKind: "remote-pointer",
        caption: undefined,
      },
      {
        type: "image",
        id: "user-1:attachment:image:3",
        source: "file-service://asset-2",
        sourceKind: "remote-pointer",
        caption: undefined,
      },
    ]);
  });
});

describe("codex user turn edit", () => {
  const settled = (turnId: string | null, hasUserMessage = true): EditableUserTurnCandidate => ({
    turnId,
    status: "completed",
    hasUserMessage,
  });

  describe("resolveEditableUserTurnIds", () => {
    test("offers every settled user message, not only the latest", () => {
      expect([
        ...resolveEditableUserTurnIds([
          settled("first"),
          { turnId: "interrupted", status: "interrupted", hasUserMessage: true },
          settled("latest"),
        ]),
      ]).toEqual(["first", "interrupted", "latest"]);
    });

    test("skips Turns without a user message or a Turn identity", () => {
      expect([
        ...resolveEditableUserTurnIds([settled("goal", false), settled(null), settled("asked")]),
      ]).toEqual(["asked"]);
    });

    test("offers nothing while any Turn runs, because the edit discards every later Turn", () => {
      expect(
        resolveEditableUserTurnIds([
          settled("first"),
          { turnId: "running", status: "inProgress", hasUserMessage: true },
        ]).size,
      ).toBe(0);
    });
  });

  describe("canEditCodexConversationUserTurns", () => {
    const conversation = (
      overrides: Partial<Parameters<typeof canEditCodexConversationUserTurns>[0]> = {},
    ): Parameters<typeof canEditCodexConversationUserTurns>[0] => ({
      archived: false,
      statusType: "idle",
      source: null,
      canonicalState: { historyMode: "paginated", ephemeral: false } as never,
      turns: [
        { turnId: "first", status: "completed", items: [{ kind: "userMessage" }] },
        { turnId: "second", status: "completed", items: [{ kind: "userMessage" }] },
      ] as never,
      ...overrides,
    });

    test("allows editing a persistent, idle conversation with sent messages", () => {
      expect(canEditCodexConversationUserTurns(conversation(), [])).toBe(true);
    });

    test.each([
      ["a pending request", conversation(), [{ requestId: 1 }]],
      [
        "a running Turn",
        conversation({
          turns: [{ turnId: "t", status: "inProgress", items: [{ kind: "userMessage" }] }] as never,
        }),
        [],
      ],
      [
        "no sent message",
        conversation({ turns: [{ turnId: "t", status: "completed", items: [] }] as never }),
        [],
      ],
      [
        "legacy history",
        conversation({ canonicalState: { historyMode: "legacy", ephemeral: false } as never }),
        [],
      ],
      [
        "ephemeral history",
        conversation({ canonicalState: { historyMode: "paginated", ephemeral: true } as never }),
        [],
      ],
      ["a side conversation", conversation({ source: { sideConversation: true } as never }), []],
      ["an archived conversation", conversation({ archived: true }), []],
    ])("refuses with %s", (_label, input, requests) => {
      expect(canEditCodexConversationUserTurns(input, requests)).toBe(false);
    });
  });
});
