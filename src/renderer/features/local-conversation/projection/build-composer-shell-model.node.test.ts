import { describe, expect, test } from "vite-plus/test";
import type {
  CodexConversationChildMembership,
  CodexConversationSnapshot,
} from "../../../lib/types";
import { buildComposerShellModel } from "./build-composer-shell-model";

type AgentStatus =
  | "pendingInit"
  | "running"
  | "interrupted"
  | "shutdown"
  | "completed"
  | "errored"
  | "notFound";
type AgentTool = "spawnAgent" | "sendInput" | "resumeAgent" | "closeAgent" | "wait";

function buildConversationSnapshot(
  overrides?: Partial<CodexConversationSnapshot>,
): CodexConversationSnapshot {
  return {
    threadId: "thread_1",
    projectId: "project_1",
    source: overrides?.source ?? null,
    threadName: "Thread",
    threadPreview: "Preview",
    modelProvider: "openai",
    cwd: "/tmp/project",
    statusType: "active",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    linkedAt: "2026-03-22T00:00:00.000Z",
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
    ...overrides,
  };
}

function buildAgentTurn({
  turnId,
  turnStatus = "inProgress",
  tool = "spawnAgent",
  itemStatus = "inProgress",
  agentStatus = "running",
  nickname = "@Scout",
  agentRole = "explorer",
  model = "gpt-5.3-codex",
  createdAt = 100,
}: {
  turnId: string;
  turnStatus?: "completed" | "inProgress";
  tool?: AgentTool;
  itemStatus?: "completed" | "inProgress" | "failed";
  agentStatus?: AgentStatus | null;
  nickname?: string | null;
  agentRole?: string | null;
  model?: string | null;
  createdAt?: number;
}): CodexConversationSnapshot["turns"][number] {
  return {
    threadId: "thread_1",
    turnId,
    status: turnStatus,
    turnStartedAtMs: createdAt,
    itemIds: [`${turnId}_agent`],
    items: [
      {
        entryId: `${turnId}_agent`,
        itemId: `${turnId}_agent`,
        threadId: "thread_1",
        turnId,
        type: "collabAgentToolCall",
        kind: "toolCall",
        semanticKind: "multiAgentAction",
        status: itemStatus,
        rawItem: {
          type: "collabAgentToolCall",
          tool,
          status: itemStatus,
          receiverThreadIds: ["thread_child"],
          receiverThreads: [
            {
              threadId: "thread_child",
              thread: {
                nickname,
                model,
                agentRole,
              },
            },
          ],
          agentsStates: agentStatus
            ? {
                thread_child: {
                  status: agentStatus,
                  message: null,
                },
              }
            : {},
          model,
        },
        createdAt,
        updatedAt: createdAt,
      },
    ],
  };
}

function buildModelWithChild({
  parentTurns,
  child,
  membershipOverrides = {},
}: {
  parentTurns?: CodexConversationSnapshot["turns"];
  child?: Partial<CodexConversationSnapshot>;
  membershipOverrides?: Partial<CodexConversationChildMembership>;
}) {
  return buildComposerShellModel({
    conversation: buildConversationSnapshot({
      turns: parentTurns ?? [],
    }),
    childMemberships: [
      {
        threadId: "thread_child",
        parentThreadId: "thread_1",
        role: "backgroundChild",
        actorName: "Fallback worker",
        ...membershipOverrides,
      },
    ],
    knownConversationsById: child
      ? {
          thread_child: buildConversationSnapshot({
            threadId: "thread_child",
            ...child,
          }),
        }
      : {},
  });
}

describe("buildComposerShellModel", () => {
  test("merges queue rows, background terminals, active request, and first child approval", () => {
    const model = buildComposerShellModel({
      conversation: buildConversationSnapshot({
        turns: [
          {
            threadId: "thread_1",
            turnId: "turn_1",
            status: "completed",
            itemIds: [],
            items: [],
          },
        ],
        requests: [
          {
            type: "userInput",
            requestId: "user_input_active",
            projectId: "project_1",
            threadId: "thread_1",
            turnId: "turn_1",
            itemId: "item_1",
            createdAt: 10,
            questions: [],
            isBlocking: true,
          },
        ],
        pendingSteers: [
          {
            steerId: "steer_1",
            threadId: "thread_1",
            turnId: "turn_1",
            prompt: "Focus on the renderer.",
            createdAt: 20,
          },
        ],
        queuedFollowUps: {
          status: "ready",
          ledgerRevision: 0,
          projectionRevision: 0,
          entries: [
            {
              followUpId: "follow_up_1",
              clientUserMessageId: "client_follow_up_1",
              threadId: "thread_1",
              prompt: "Run validation next.",
              promptInput: { text: "Run validation next." },
              createdAtMs: 30,
              collaborationMode: "default",
              serviceTier: null,
              summary: null,
              pause: null,
              payloadRef: null,
            },
          ],
          inFlightFollowUpId: null,
          editingFollowUpId: null,
          error: null,
        },
        backgroundTerminalRows: [
          {
            id: "row_1",
            turnId: "turn_1",
            command:
              "bun test src/renderer/features/local-conversation/view/composer/local-conversation-composer-shell.test.tsx",
            cwd: "/tmp/project",
            previewLine: "1418 pass",
            processId: 4001,
          },
        ],
      }),
      childMemberships: [
        {
          threadId: "thread_2",
          parentThreadId: "thread_1",
          role: "backgroundChild",
          actorName: "Worker 1",
        },
      ],
      knownConversationsById: {
        thread_1: buildConversationSnapshot(),
        thread_2: buildConversationSnapshot({
          threadId: "thread_2",
          turns: [
            {
              threadId: "thread_2",
              turnId: "turn_2",
              status: "completed",
              itemIds: [],
              items: [],
            },
          ],
          requests: [
            {
              type: "approval",
              requestId: "approval_background",
              kind: "command",
              projectId: "project_1",
              threadId: "thread_2",
              turnId: "turn_2",
              itemId: "item_2",
              createdAt: 5,
            },
          ],
          statusActiveFlags: ["waitingOnApproval"],
        }),
      },
    });

    expect(model.activeRequest?.request.requestId).toBe("user_input_active");
    expect(model.backgroundRequest?.request.requestId).toBe("approval_background");
    expect(model.pendingSteerRows.length).toBe(0);
    expect(model.queuedFollowUpRows.length).toBe(1);
    expect(model.queuedFollowUpRows[0]?.displayText).toBe("Run validation next.");
    expect(model.backgroundTerminalRows.length).toBe(1);
    expect(model.backgroundAgentRows.length).toBe(1);
    expect(model.backgroundAgentRows[0]?.status).toBe("active");
    expect(model.showRequestCards).toBe(true);
    expect(model.showComposer).toBe(false);
  });

  test("preserves full queue projection state and summarizes attachment-only rows", () => {
    const model = buildComposerShellModel({
      conversation: buildConversationSnapshot({
        queuedFollowUps: {
          status: "ready",
          ledgerRevision: 7,
          projectionRevision: 11,
          entries: [
            {
              followUpId: "follow_up_attachment",
              clientUserMessageId: "client_attachment",
              threadId: "thread_1",
              prompt: "",
              promptInput: {
                text: "",
                images: [{ source: "data:image/png;base64,AA==" }],
                commentAttachments: [
                  {
                    id: "comment_1",
                    type: "comment",
                    content: [{ content_type: "text", text: "Check this" }],
                    position: { side: "right", path: "src/app.ts", line: 3 },
                    createdAt: 1,
                  },
                ],
              },
              createdAtMs: 30,
              collaborationMode: "default",
              serviceTier: null,
              summary: null,
              pause: {
                kind: "interrupted",
                reason: "Interrupted before the steer was accepted.",
              },
              payloadRef: null,
            },
          ],
          inFlightFollowUpId: "follow_up_attachment",
          editingFollowUpId: null,
          error: null,
        },
      }),
      knownConversationsById: {},
    });

    expect(model.queuedFollowUpLedgerRevision).toBe(7);
    expect(model.hasInterruptedQueuedFollowUps).toBe(true);
    expect(model.queuedFollowUpRows[0]).toMatchObject({
      displayText: "1 image · 1 review comment",
      pauseKind: "interrupted",
      isInFlight: true,
      imagePreviewSource: "data:image/png;base64,AA==",
    });
  });

  test("stacks child permission before a canonical active option request", () => {
    const model = buildComposerShellModel({
      conversation: buildConversationSnapshot({
        turns: [
          {
            threadId: "thread_1",
            turnId: "turn_1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
        canonicalRequests: [
          {
            id: "active-option",
            method: "item/tool/requestOptionPicker",
            params: {
              threadId: "thread_1",
              turnId: "turn_1",
              question: "Choose a slice",
              options: [{ label: "UI" }],
            },
          },
        ],
      }),
      childMemberships: [
        {
          threadId: "thread_child",
          parentThreadId: "thread_1",
          role: "childApproval",
          actorName: "Worker",
        },
      ],
      knownConversationsById: {
        thread_child: buildConversationSnapshot({
          threadId: "thread_child",
          turns: [
            {
              threadId: "thread_child",
              turnId: "turn_child",
              status: "inProgress",
              itemIds: [],
              items: [],
            },
          ],
          requests: [
            {
              type: "permissionRequest",
              requestId: "child-permission",
              projectId: "project_1",
              threadId: "thread_child",
              turnId: "turn_child",
              itemId: "child-permission-item",
              reason: "Allow child access",
              cwd: "/tmp/project",
              permissions: { network: null, fileSystem: null },
              completed: false,
              response: null,
              createdAt: 1,
            },
          ],
          canonicalRequests: [
            {
              id: "child-option",
              method: "item/tool/requestOptionPicker",
              params: {
                threadId: "thread_child",
                turnId: "turn_child",
                question: "Private child question",
                options: [{ label: "Wait" }],
              },
            },
          ],
        }),
      },
    });

    expect(model.backgroundRequest?.request.type).toBe("permissionRequest");
    expect(model.activeRequest?.request.type).toBe("optionPicker");
    expect(model.showRequestCards).toBe(true);
    expect(model.showComposer).toBe(false);
    expect(model.showApprovalMode).toBe(true);
  });

  test("keeps child approval selection in membership order", () => {
    const model = buildComposerShellModel({
      conversation: buildConversationSnapshot(),
      childMemberships: [
        {
          threadId: "thread_b",
          parentThreadId: "thread_1",
          role: "childApproval",
          actorName: "Worker B",
        },
        {
          threadId: "thread_a",
          parentThreadId: "thread_1",
          role: "childApproval",
          actorName: "Worker A",
        },
      ],
      knownConversationsById: {
        thread_b: buildConversationSnapshot({
          threadId: "thread_b",
          turns: [
            {
              threadId: "thread_b",
              turnId: "turn_b",
              status: "completed",
              itemIds: [],
              items: [],
            },
          ],
          requests: [
            {
              type: "approval",
              requestId: "approval_b",
              kind: "command",
              projectId: "project_1",
              threadId: "thread_b",
              turnId: "turn_b",
              itemId: "item_b",
              createdAt: 2,
            },
          ],
        }),
        thread_a: buildConversationSnapshot({
          threadId: "thread_a",
          turns: [
            {
              threadId: "thread_a",
              turnId: "turn_a",
              status: "completed",
              itemIds: [],
              items: [],
            },
          ],
          requests: [
            {
              type: "approval",
              requestId: "approval_a",
              kind: "command",
              projectId: "project_1",
              threadId: "thread_a",
              turnId: "turn_a",
              itemId: "item_a",
              createdAt: 1,
            },
          ],
        }),
      },
    });

    expect(model.backgroundRequest?.request.requestId).toBe("approval_b");
  });

  test("builds reference-style background subagent row metadata", () => {
    const model = buildComposerShellModel({
      conversation: buildConversationSnapshot({
        turns: [
          {
            threadId: "thread_1",
            turnId: "turn_parent_active",
            status: "inProgress",
            turnStartedAtMs: 100,
            itemIds: ["spawn_agent"],
            items: [
              {
                entryId: "spawn_agent",
                itemId: "spawn_agent",
                threadId: "thread_1",
                turnId: "turn_parent_active",
                type: "collabAgentToolCall",
                kind: "toolCall",
                semanticKind: "multiAgentAction",
                status: "inProgress",
                rawItem: {
                  type: "collabAgentToolCall",
                  tool: "spawnAgent",
                  status: "inProgress",
                  receiverThreadIds: ["thread_child"],
                  receiverThreads: [
                    {
                      threadId: "thread_child",
                      thread: {
                        nickname: "@Scout",
                        model: "gpt-5.3-codex",
                        agentRole: "explorer",
                      },
                    },
                  ],
                  agentsStates: {
                    thread_child: {
                      status: "running",
                      message: "Inspecting",
                    },
                  },
                  model: "gpt-5.3-codex",
                },
                createdAt: 100,
                updatedAt: 100,
              },
            ],
          },
        ],
      }),
      childMemberships: [
        {
          threadId: "thread_child",
          parentThreadId: "thread_1",
          role: "backgroundChild",
          actorName: "Fallback worker",
        },
      ],
      knownConversationsById: {
        thread_child: buildConversationSnapshot({
          threadId: "thread_child",
          agentNickname: "@Backup",
          turns: [
            {
              threadId: "thread_child",
              turnId: "turn_child",
              status: "inProgress",
              diff: [
                "diff --git a/src/a.ts b/src/a.ts",
                "--- a/src/a.ts",
                "+++ b/src/a.ts",
                "@@ -1,1 +1,2 @@",
                "-old",
                "+new",
                "+next",
              ].join("\n"),
              itemIds: ["reasoning_child"],
              items: [
                {
                  entryId: "reasoning_child",
                  itemId: "reasoning_child",
                  threadId: "thread_child",
                  turnId: "turn_child",
                  type: "reasoning",
                  kind: "reasoning",
                  semanticKind: "reasoning",
                  status: "inProgress",
                  rawItem: {
                    type: "reasoning",
                    summary: ["> **I'm Checking files.**"],
                  },
                  createdAt: 120,
                  updatedAt: 120,
                },
              ],
            },
          ],
        }),
      },
    });

    const row = model.backgroundAgentRows[0];
    expect(model.backgroundAgentRows.length).toBe(1);
    expect(row?.conversationId).toBe("thread_child");
    expect(row?.parentTurnKey).toBe("turn_parent_active");
    expect(row?.displayName).toBe("Scout");
    expect(row?.agentRole).toBe("explorer");
    expect(row?.spawnModel).toBe("gpt-5.3-codex");
    expect(row?.status).toBe("active");
    expect(row?.statusSummary).toBe("checking files");
    expect(`${row?.diffStats?.linesAdded ?? -1}:${row?.diffStats?.linesRemoved ?? -1}`).toBe("2:1");
    expect(row?.showInlineActivity).toBe(false);
  });

  test("normalizes background subagent status matrix edges", () => {
    const waitingModel = buildModelWithChild({
      parentTurns: [
        buildAgentTurn({
          turnId: "turn_waiting",
          agentStatus: "pendingInit",
        }),
      ],
    });
    expect(waitingModel.backgroundAgentRows[0]?.status).toBe("waiting");

    for (const agentStatus of ["interrupted", "errored", "shutdown", "notFound"] as const) {
      const hiddenModel = buildModelWithChild({
        parentTurns: [
          buildAgentTurn({
            turnId: `turn_${agentStatus}`,
            agentStatus,
          }),
        ],
      });
      expect(hiddenModel.backgroundAgentRows.length).toBe(0);
    }

    const closedModel = buildModelWithChild({
      parentTurns: [
        buildAgentTurn({
          turnId: "turn_close",
          tool: "closeAgent",
          agentStatus: "completed",
        }),
      ],
    });
    expect(closedModel.backgroundAgentRows.length).toBe(0);

    const unknownCurrentModel = buildModelWithChild({
      parentTurns: [
        buildAgentTurn({
          turnId: "turn_unknown_current",
          agentStatus: null,
        }),
      ],
    });
    expect(unknownCurrentModel.backgroundAgentRows[0]?.status).toBe("active");

    const unknownStaleModel = buildModelWithChild({
      parentTurns: [
        buildAgentTurn({
          turnId: "turn_unknown_stale",
          turnStatus: "completed",
          itemStatus: "completed",
          agentStatus: null,
        }),
      ],
    });
    expect(unknownStaleModel.backgroundAgentRows.length).toBe(0);

    const resumeActiveModel = buildModelWithChild({
      parentTurns: [
        buildAgentTurn({
          turnId: "turn_completed_parent",
          turnStatus: "completed",
          itemStatus: "completed",
          agentStatus: "completed",
        }),
      ],
      child: {
        resumeState: "needs_resume",
        statusType: "active",
        threadRuntimeStatus: {
          type: "active",
          activeFlags: [],
        },
        turns: [],
      },
    });
    expect(resumeActiveModel.backgroundAgentRows[0]?.status).toBe("active");

    const resumeCatalogActiveRuntimeIdleModel = buildModelWithChild({
      parentTurns: [
        buildAgentTurn({
          turnId: "turn_completed_parent",
          turnStatus: "completed",
          itemStatus: "completed",
          agentStatus: "completed",
        }),
      ],
      child: {
        resumeState: "needs_resume",
        statusType: "active",
        threadRuntimeStatus: {
          type: "idle",
        },
        turns: [],
      },
    });
    expect(resumeCatalogActiveRuntimeIdleModel.backgroundAgentRows[0]?.status).toBe("done");
  });

  test("resolves display names and roles from membership and latest references", () => {
    const membershipModel = buildModelWithChild({
      parentTurns: [
        buildAgentTurn({
          turnId: "turn_membership_name",
          nickname: "@Reference",
        }),
      ],
      membershipOverrides: {
        displayName: "@Planner",
      },
    });
    expect(membershipModel.backgroundAgentRows[0]?.displayName).toBe("Planner");

    const latestReferenceModel = buildModelWithChild({
      parentTurns: [
        buildAgentTurn({
          turnId: "turn_spawn",
          turnStatus: "completed",
          itemStatus: "completed",
          agentStatus: "completed",
          nickname: "@Scout",
          model: "gpt-5.3-codex",
          createdAt: 100,
        }),
        buildAgentTurn({
          turnId: "turn_send",
          tool: "sendInput",
          nickname: "@Builder",
          model: null,
          agentRole: "builder",
          createdAt: 200,
        }),
      ],
      membershipOverrides: {
        actorName: "Fallback worker",
      },
    });
    const latestRow = latestReferenceModel.backgroundAgentRows[0];
    expect(latestRow?.displayName).toBe("Builder");
    expect(latestRow?.agentRole).toBe("builder");
    expect(latestRow?.spawnModel).toBe("gpt-5.3-codex");

    const membershipThreadModel = buildModelWithChild({
      child: {
        agentNickname: "@Child",
        threadName: "Child thread title",
        threadPreview: "Child thread preview",
        statusType: "idle",
      },
      membershipOverrides: {
        actorName: "Actor label",
        thread: {
          nickname: "@Member",
          model: null,
          agentRole: null,
        },
      },
    });
    expect(membershipThreadModel.backgroundAgentRows[0]?.displayName).toBe("Member");

    const idFallbackModel = buildModelWithChild({
      child: {
        agentNickname: null,
        threadName: "Child thread title",
        threadPreview: "Child thread preview",
        statusType: "idle",
      },
      membershipOverrides: {
        actorName: "Actor label",
        thread: null,
      },
    });
    expect(idFallbackModel.backgroundAgentRows[0]?.displayName).toBe("thread_child");

    const defaultRoleModel = buildModelWithChild({
      parentTurns: [
        buildAgentTurn({
          turnId: "turn_default_role",
          agentRole: "default",
        }),
      ],
      child: {
        agentRole: "reviewer",
      },
    });
    expect(defaultRoleModel.backgroundAgentRows[0]?.agentRole).toBe(null);

    const membershipThreadRoleModel = buildModelWithChild({
      child: {
        agentRole: "child-reviewer",
        statusType: "idle",
      },
      membershipOverrides: {
        agentRole: "legacy-role",
        thread: {
          nickname: null,
          model: null,
          agentRole: "architect",
        },
      },
    });
    expect(membershipThreadRoleModel.backgroundAgentRows[0]?.agentRole).toBe("architect");

    const childRoleModel = buildModelWithChild({
      child: {
        agentRole: "child-reviewer",
        statusType: "idle",
      },
      membershipOverrides: {
        agentRole: "legacy-role",
        thread: null,
      },
    });
    expect(childRoleModel.backgroundAgentRows[0]?.agentRole).toBe("child-reviewer");
  });

  test("hides terminal errored child statuses from background rows", () => {
    const model = buildComposerShellModel({
      conversation: buildConversationSnapshot(),
      childMemberships: [
        {
          threadId: "thread_child",
          parentThreadId: "thread_1",
          role: "backgroundChild",
          actorName: "Worker",
        },
      ],
      knownConversationsById: {
        thread_child: buildConversationSnapshot({
          threadId: "thread_child",
          statusType: "systemError",
        }),
      },
    });

    expect(model.backgroundAgentRows.length).toBe(0);
  });

  test("uses child nickname and role fallback with one leading at sign stripped", () => {
    const model = buildComposerShellModel({
      conversation: buildConversationSnapshot(),
      childMemberships: [
        {
          threadId: "thread_child",
          parentThreadId: "thread_1",
          role: "backgroundChild",
        },
      ],
      knownConversationsById: {
        thread_child: buildConversationSnapshot({
          threadId: "thread_child",
          agentNickname: "@@Agent",
          agentRole: "reviewer",
          threadName: null,
          threadPreview: "",
          statusType: "idle",
        }),
      },
    });

    const row = model.backgroundAgentRows[0];
    expect(model.backgroundAgentRows.length).toBe(1);
    expect(row?.displayName).toBe("@Agent");
    expect(row?.agentRole).toBe("reviewer");
    expect(row?.status).toBe("done");
  });

  test("projects source-linked inline subagents with Codex overview message and recency fields", () => {
    const child = buildConversationSnapshot({
      threadId: "thread_child",
      source: { parentThreadId: "thread_1" },
      agentNickname: "@Scout",
      statusType: "idle",
      updatedAt: 200,
      turns: [
        {
          threadId: "thread_child",
          turnId: "turn_child",
          status: "completed",
          itemIds: ["message_child"],
          items: [
            {
              threadId: "thread_child",
              turnId: "turn_child",
              itemId: "message_child",
              type: "agentMessage",
              kind: "assistantMessage",
              semanticKind: "assistantMessage",
              role: "assistant",
              markdownText: "Finished the repository audit.",
              createdAt: 180,
              updatedAt: 190,
            },
          ],
        },
      ],
    });
    const model = buildComposerShellModel({
      conversation: buildConversationSnapshot(),
      childMemberships: [
        {
          threadId: "thread_child",
          parentThreadId: "thread_1",
          role: "backgroundChild",
          agentPath: "agents/scout",
          createdAtMs: 100,
          updatedAtMs: 200,
          statusType: "notLoaded",
          showInlineActivity: true,
        },
      ],
      knownConversationsById: { thread_child: child },
    });

    const row = model.backgroundAgentRows[0];
    expect(row?.parentConversationId).toBe("thread_1");
    expect(row?.parentTurnKey).toBe("0");
    expect(row?.showInlineActivity).toBe(true);
    expect(row?.status).toBe("done");
    expect(row?.lastAssistantMessage).toBe("Finished the repository audit.");
    expect(row?.lastAssistantMessageAtMs).toBe(190);
    expect(row?.recencyAtMs).toBe(190);
  });

  test("keeps not-loaded source metadata unresolved instead of claiming completion", () => {
    const model = buildComposerShellModel({
      conversation: buildConversationSnapshot(),
      childMemberships: [
        {
          threadId: "thread_child",
          parentThreadId: "thread_1",
          role: "backgroundChild",
          agentPath: "agents/scout",
          statusType: "notLoaded",
          showInlineActivity: true,
        },
      ],
      knownConversationsById: {},
    });

    expect(model.backgroundAgentRows[0]?.status).toBe("waiting");
  });
});
