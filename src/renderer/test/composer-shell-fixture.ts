import type {
  CodexAccountSnapshot,
  CodexCollaborationModePreset,
  CodexConversationChildMembership,
  CodexConversationItem,
  CodexConversationSnapshot,
  CodexConversationTurn,
  CodexCanonicalServerRequest,
  CodexDictationStateSnapshot,
  CodexModelOption,
  CodexReasoningEffortOption,
} from "@/lib/types";
import { buildComposerShellModel } from "@/features/local-conversation/projection/build-composer-shell-model";
import { buildThreadBodyModel } from "@/features/local-conversation/projection/build-thread-body-model";
import { selectPrimaryConversationRequest } from "@/features/local-conversation/conversation-request-helpers";
import { buildCodexFileChangeMap } from "../../shared/codex-file-change";
import type { ThreadFooterModel } from "@/features/local-conversation/thread-stage-types";

export type ComposerShellFixturePreset =
  | "background-activity"
  | "background-permission-option"
  | "implement-plan"
  | "file-approval-lane"
  | "onboarding-input-lane"
  | "permission-lane"
  | "mcp-elicitation-lane"
  | "option-picker-lane"
  | "setup-role-lane"
  | "setup-task-lane"
  | "setup-context-lane";

const FIXTURE_PROJECT_ID = "composer-project";
const FIXTURE_WORKSPACE_PATH = "/workspace/nodex";
const FIXTURE_THREAD_ID = "thread_composer";
const DEFAULT_ACCOUNT_AUTHENTICATED: CodexAccountSnapshot = {
  account: {
    type: "chatgpt",
    email: "asc@example.com",
    planType: "Pro",
  },
  requiresOpenAiAuth: false,
  pendingLogin: null,
  rateLimits: null,
};

const DEFAULT_MODELS: CodexModelOption[] = [
  {
    id: "gpt-5.3-codex",
    model: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    description: "Balanced model for thread work.",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "minimal", description: "Fastest" },
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep" },
    ],
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  },
];

const IMPLEMENT_PLAN_MODELS: CodexModelOption[] = [
  {
    id: "gpt-5.6-terra",
    model: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    description: "Fast everyday implementation work.",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Light" }],
    defaultReasoningEffort: "low",
    inputModalities: ["text", "image"],
    multiAgentVersion: "v2",
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  },
  {
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    description: "Deeper implementation work.",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Light" },
      { reasoningEffort: "medium", description: "Medium" },
      { reasoningEffort: "high", description: "High" },
      { reasoningEffort: "xhigh", description: "Extra High" },
      { reasoningEffort: "ultra", description: "Ultra" },
    ],
    defaultReasoningEffort: "xhigh",
    inputModalities: ["text", "image"],
    multiAgentVersion: "v2",
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  },
];

const DEFAULT_COLLABORATION_MODES: CodexCollaborationModePreset[] = [
  { name: "Default", mode: "default", model: null, reasoningEffort: null },
  { name: "Plan", mode: "plan", model: null, reasoningEffort: "high" },
];

const DEFAULT_REASONING_OPTIONS: CodexReasoningEffortOption[] = [
  { reasoningEffort: "medium", description: "Balanced" },
  { reasoningEffort: "high", description: "Thorough" },
];

const DEFAULT_DICTATION_STATE: CodexDictationStateSnapshot = {
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
};

function buildConversationItem(overrides: Partial<CodexConversationItem>): CodexConversationItem {
  return {
    threadId: FIXTURE_THREAD_ID,
    turnId: "turn_fixture_1",
    itemId: "item_fixture_1",
    type: "assistant_message",
    kind: "assistantMessage",
    semanticKind: "assistantMessage",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildConversationTurn(overrides: Partial<CodexConversationTurn>): CodexConversationTurn {
  const items = overrides.items ?? [];
  return {
    threadId: FIXTURE_THREAD_ID,
    turnId: "turn_fixture_1",
    status: "completed",
    itemIds: items.map((item) => item.itemId),
    items,
    ...overrides,
  };
}

function buildConversation(
  overrides?: Partial<CodexConversationSnapshot>,
): CodexConversationSnapshot {
  return {
    threadId: FIXTURE_THREAD_ID,
    projectId: FIXTURE_PROJECT_ID,
    source: overrides?.source ?? null,
    threadName: "Validate composer request ownership",
    threadPreview: "Cover tool calls, request lanes, edit flow, and fork flow.",
    modelProvider: "openai",
    cwd: FIXTURE_WORKSPACE_PATH,
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1_000,
    updatedAt: 8_000,
    linkedAt: "2026-03-24T08:00:00.000Z",
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

function buildStreamingConversation(
  overrides?: Partial<CodexConversationSnapshot>,
): CodexConversationSnapshot {
  return buildConversation({
    statusType: "active",
    statusActiveFlags: [],
    updatedAt: 25_000,
    turns: [
      buildConversationTurn({
        turnId: "turn_fixture_streaming",
        status: "inProgress",
        items: [
          buildConversationItem({
            turnId: "turn_fixture_streaming",
            itemId: "user_fixture_streaming",
            type: "user_message",
            kind: "userMessage",
            semanticKind: "userMessage",
            role: "user",
            markdownText: "Implement canonical request ownership for the composer.",
            createdAt: 20_000,
            updatedAt: 20_000,
          }),
          buildConversationItem({
            turnId: "turn_fixture_streaming",
            itemId: "reasoning_fixture_streaming",
            type: "reasoning",
            kind: "reasoning",
            semanticKind: "reasoning",
            status: "inProgress",
            markdownText: "Checking the active request and background activity ownership.",
            createdAt: 21_000,
            updatedAt: 24_000,
          }),
          buildConversationItem({
            turnId: "turn_fixture_streaming",
            itemId: "exec_fixture_streaming",
            type: "command_execution",
            kind: "commandExecution",
            semanticKind: "exec",
            status: "inProgress",
            toolCall: {
              subtype: "command",
              toolName: "exec_command",
              args: {
                command: "sed -n '1,220p' src/renderer/lib/api.ts",
                cwd: FIXTURE_WORKSPACE_PATH,
                summaryLabel: "Reading renderer transport seams",
              },
              result:
                'import { resolveInvokeTransport, resolveRendererTransport } from "./renderer-transport";',
            },
            createdAt: 22_000,
            updatedAt: 25_000,
          }),
        ],
      }),
    ],
    ...overrides,
  });
}

function buildImplementPlanConversation(): CodexConversationSnapshot {
  return buildConversation({
    updatedAt: 30_000,
    requests: [
      {
        type: "implementPlan",
        requestId: "implement-plan:turn_fixture_plan",
        projectId: FIXTURE_PROJECT_ID,
        threadId: FIXTURE_THREAD_ID,
        turnId: "turn_fixture_plan",
        itemId: "implement-plan:turn_fixture_plan",
        planContent: [
          "1. Project canonical requests into the composer.",
          "2. Preserve request family interactions.",
          "3. Verify shared editor and composer request handling.",
        ].join("\n"),
        createdAt: 29_500,
      },
    ],
    turns: [
      buildConversationTurn({
        turnId: "turn_fixture_plan",
        status: "completed",
        items: [
          buildConversationItem({
            turnId: "turn_fixture_plan",
            itemId: "user_fixture_plan",
            type: "user_message",
            kind: "userMessage",
            semanticKind: "userMessage",
            role: "user",
            markdownText: "Plan request ownership for the composer.",
            createdAt: 20_000,
            updatedAt: 20_000,
          }),
          buildConversationItem({
            turnId: "turn_fixture_plan",
            itemId: "plan_fixture_plan",
            type: "plan",
            kind: "plan",
            semanticKind: "proposedPlan",
            markdownText: [
              "1. Project canonical requests into the composer.",
              "2. Preserve request family interactions.",
              "3. Verify shared editor and composer request handling.",
              "4. Verify shared editor and composer request handling.",
              "5. Verify shared editor and composer request handling.",
              "6. Verify shared editor and composer request handling.",
              "7. Verify shared editor and composer request handling.",
              "8. Verify shared editor and composer request handling.",
              "9. Verify shared editor and composer request handling.",
              "10. Verify shared editor and composer request handling.",
              "11. Verify shared editor and composer request handling.",
            ].join("\n"),
            createdAt: 25_000,
            updatedAt: 29_000,
          }),
          buildConversationItem({
            turnId: "turn_fixture_plan",
            itemId: "implement-plan:turn_fixture_plan",
            type: "planImplementation",
            kind: "planImplementation",
            semanticKind: "planImplementation",
            markdownText: [
              "1. Project canonical requests into the composer.",
              "2. Preserve request family interactions.",
              "3. Verify shared editor and composer request handling.",
            ].join("\n"),
            status: "inProgress",
            createdAt: 29_500,
            updatedAt: 30_000,
          }),
        ],
      }),
    ],
  });
}

function buildBackgroundConversation(): {
  conversation: CodexConversationSnapshot;
  childMemberships: readonly CodexConversationChildMembership[];
  knownConversationsById: Record<string, CodexConversationSnapshot>;
} {
  const backgroundThreadId = "thread_fixture_background_worker";
  const waitingBackgroundThreadId = "thread_fixture_background_planner";
  const doneBackgroundThreadId = "thread_fixture_background_finisher";
  const childMemberships: CodexConversationChildMembership[] = [
    {
      threadId: backgroundThreadId,
      parentThreadId: FIXTURE_THREAD_ID,
      role: "backgroundChild",
      actorName: "Worker 1",
      showInlineActivity: true,
      thread: {
        nickname: "Worker 1",
        model: null,
        agentRole: null,
      },
    },
    {
      threadId: waitingBackgroundThreadId,
      parentThreadId: FIXTURE_THREAD_ID,
      role: "backgroundChild",
      actorName: "Planner",
      thread: {
        nickname: "Planner",
        model: null,
        agentRole: null,
      },
    },
    {
      threadId: doneBackgroundThreadId,
      parentThreadId: FIXTURE_THREAD_ID,
      role: "backgroundChild",
      actorName: "Finisher",
      thread: {
        nickname: "Finisher",
        model: null,
        agentRole: null,
      },
    },
  ];
  const conversation = buildConversation({
    statusType: "active",
    statusActiveFlags: [],
    requests: [
      {
        type: "approval",
        requestId: "approval_fixture_active",
        kind: "command",
        projectId: FIXTURE_PROJECT_ID,
        threadId: FIXTURE_THREAD_ID,
        turnId: "turn_fixture_streaming",
        itemId: "exec_fixture_streaming",
        reason: "Foreground thread wants to run the semantic checks.",
        command: "bun run lint",
        cwd: FIXTURE_WORKSPACE_PATH,
        createdAt: 26_000,
      },
    ],
    turns: buildStreamingConversation().turns,
    pendingSteers: [
      {
        steerId: "steer_fixture_1",
        threadId: FIXTURE_THREAD_ID,
        turnId: "turn_fixture_streaming",
        prompt: "Keep requests on the canonical projection path.",
        createdAt: 27_000,
      },
    ],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [
        {
          followUpId: "follow_up_fixture_1",
          clientUserMessageId: "client_follow_up_fixture_1",
          threadId: FIXTURE_THREAD_ID,
          prompt: "Run final validation once the request workflow is complete.",
          promptInput: { text: "Run final validation once the request workflow is complete." },
          createdAtMs: 28_000,
          collaborationMode: "default",
          serviceTier: null,
          summary: null,
          pause: null,
        },
      ],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    backgroundTerminalRows: [
      {
        id: "background_terminal_fixture_1",
        turnId: "turn_fixture_background",
        command:
          "bun test src/renderer/features/local-conversation/view/shared/request-cards/local-conversation-request-cards.test.tsx",
        cwd: FIXTURE_WORKSPACE_PATH,
        previewLine: "1418 pass",
        processId: 4172,
      },
    ],
  });

  const backgroundConversation = buildConversation({
    threadId: backgroundThreadId,
    threadName: "Worker 1",
    threadPreview: "Reviewing request-card density",
    statusType: "active",
    statusActiveFlags: ["waitingOnApproval"],
    turns: [
      buildConversationTurn({
        threadId: backgroundThreadId,
        turnId: "turn_fixture_background",
        status: "inProgress",
        items: [
          buildConversationItem({
            threadId: backgroundThreadId,
            turnId: "turn_fixture_background",
            itemId: "user_fixture_background",
            type: "user_message",
            kind: "userMessage",
            semanticKind: "userMessage",
            role: "user",
            markdownText: "Check request-card keyboard continuity.",
            createdAt: 25_000,
            updatedAt: 25_000,
          }),
        ],
      }),
    ],
    requests: [
      {
        type: "approval",
        requestId: "approval_fixture_background",
        kind: "command",
        projectId: FIXTURE_PROJECT_ID,
        threadId: backgroundThreadId,
        turnId: "turn_fixture_background",
        itemId: "background_exec_fixture",
        reason: "Background child wants to run the isolated request-card tests.",
        command:
          "bun test src/renderer/features/local-conversation/view/shared/request-cards/local-conversation-request-cards.test.tsx",
        cwd: FIXTURE_WORKSPACE_PATH,
        createdAt: 26_500,
      },
    ],
  });
  const waitingBackgroundConversation = buildConversation({
    threadId: waitingBackgroundThreadId,
    threadName: "Planner",
    threadPreview: "Waiting for the next instruction",
    statusType: "notLoaded",
    statusActiveFlags: [],
    turns: [],
    requests: [],
  });
  const doneBackgroundConversation = buildConversation({
    threadId: doneBackgroundThreadId,
    threadName: "Finisher",
    threadPreview: "Finished collecting notes",
    statusType: "idle",
    statusActiveFlags: [],
    turns: [
      buildConversationTurn({
        threadId: doneBackgroundThreadId,
        turnId: "turn_fixture_background_done",
        status: "completed",
        items: [
          buildConversationItem({
            threadId: doneBackgroundThreadId,
            turnId: "turn_fixture_background_done",
            itemId: "assistant_fixture_background_done",
            type: "assistant_message",
            kind: "assistantMessage",
            semanticKind: "assistantMessage",
            role: "assistant",
            markdownText: "Finished collecting notes.",
            createdAt: 25_000,
            updatedAt: 25_000,
          }),
        ],
      }),
    ],
    requests: [],
  });

  return {
    conversation,
    childMemberships,
    knownConversationsById: {
      [FIXTURE_THREAD_ID]: conversation,
      [backgroundThreadId]: backgroundConversation,
      [waitingBackgroundThreadId]: waitingBackgroundConversation,
      [doneBackgroundThreadId]: doneBackgroundConversation,
    },
  };
}

const REQUEST_CARD_FIXTURES = {
  optionPicker: {
    type: "optionPicker" as const,
    requestId: "option_picker_fixture_card",
    projectId: FIXTURE_PROJECT_ID,
    threadId: FIXTURE_THREAD_ID,
    turnId: "turn_fixture_request",
    itemId: "call_option_picker_fixture_card",
    question: "Which request workflow should Codex implement next?",
    options: [
      { label: "Request projection", description: "Align canonical request selection." },
      { label: "Composer surface", description: "Align request-card behavior and styling." },
      { label: "Response route", description: "Align owner and follower replies." },
    ],
    allowMultiple: true,
    submitLabel: "Continue",
    skipLabel: "Not now",
    createdAt: 1,
  },
  fileApproval: {
    type: "approval" as const,
    requestId: "file_approval_fixture_card",
    kind: "file" as const,
    projectId: FIXTURE_PROJECT_ID,
    threadId: FIXTURE_THREAD_ID,
    turnId: "turn_fixture_request",
    itemId: "item_fixture_file_approval",
    grantRoot: FIXTURE_WORKSPACE_PATH,
    createdAt: 1,
  },
  fileApprovalItem: buildConversationItem({
    turnId: "turn_fixture_request",
    itemId: "item_fixture_file_approval",
    entryId: "item_fixture_file_approval",
    type: "file_change",
    kind: "fileChange",
    semanticKind: "patch",
    status: "inProgress",
    approvalRequestId: "file_approval_fixture_card",
    fileChange: {
      changes: buildCodexFileChangeMap([
        {
          type: "add",
          path: "src/generated-preview.ts",
          content: "export const preview = true;\n",
        },
        {
          type: "update",
          path: "src/generated-preview.ts",
          movePath: null,
          unifiedDiff: [
            "@@ -1,1 +1,2 @@",
            "-export const preview = false;",
            "+export const preview = true;",
            "+export const ready = true;",
          ].join("\n"),
        },
      ]),
      success: null,
    },
    createdAt: 1,
    updatedAt: 1,
  }),
  permissionRequest: {
    type: "permissionRequest" as const,
    requestId: "permission_fixture_card",
    projectId: FIXTURE_PROJECT_ID,
    threadId: FIXTURE_THREAD_ID,
    turnId: "turn_fixture_request",
    itemId: "item_fixture_request_permission",
    cwd: FIXTURE_WORKSPACE_PATH,
    reason: "Codex needs network access and read access to the workspace for this turn.",
    permissions: {
      network: {
        enabled: true,
      },
      fileSystem: {
        read: null,
        write: null,
        entries: [
          {
            path: {
              type: "path" as const,
              path: FIXTURE_WORKSPACE_PATH,
            },
            access: "read" as const,
          },
        ],
      },
    },
    response: null,
    completed: false,
    createdAt: 1,
  },
  mcpServerElicitation: {
    type: "mcpServerElicitation" as const,
    requestId: "mcp_fixture_card",
    projectId: FIXTURE_PROJECT_ID,
    threadId: FIXTURE_THREAD_ID,
    turnId: "turn_fixture_request",
    itemId: "item_fixture_request_mcp",
    kind: "generic" as const,
    mode: "form" as const,
    serverName: "Context7",
    message: "Allow this MCP server call to continue?",
    requestedSchema: {
      type: "object",
      required: ["project"],
      properties: {
        project: {
          type: "string",
          title: "Project",
          description: "Repository or package name to inspect",
        },
        branch: {
          type: "string",
          title: "Branch",
          description: "Optional branch override",
        },
      },
    },
    createdAt: 1,
  },
};
type FixtureDynamicToolArguments = Extract<
  CodexCanonicalServerRequest,
  { method: "item/tool/call" }
>["params"]["arguments"];

function buildDynamicRequest(input: {
  id: string;
  tool: string;
  arguments: FixtureDynamicToolArguments;
}): CodexCanonicalServerRequest {
  return {
    id: input.id,
    method: "item/tool/call",
    params: {
      threadId: FIXTURE_THREAD_ID,
      turnId: "turn_fixture_streaming",
      callId: `call_${input.id}`,
      namespace: "codex_app",
      tool: input.tool,
      arguments: input.arguments,
    },
  };
}

function buildOnboardingInputRequestConversation(): CodexConversationSnapshot {
  return buildStreamingConversation({
    canonicalRequests: [
      buildDynamicRequest({
        id: "onboarding_fixture_active",
        tool: "request_onboarding_input",
        arguments: {
          questions: [
            {
              id: "first_goal",
              question: "What should Codex help you accomplish first?",
              options: [
                { label: "Build a feature", description: "Start with implementation." },
                { label: "Review code", description: "Start with a focused review." },
              ],
            },
          ],
        },
      }),
    ],
  });
}

function buildPermissionRequestConversation(): CodexConversationSnapshot {
  return buildStreamingConversation({
    requests: [
      {
        ...REQUEST_CARD_FIXTURES.permissionRequest,
        requestId: "permission_fixture_active",
        turnId: "turn_fixture_streaming",
        itemId: "reasoning_fixture_streaming",
        createdAt: 26_000,
      },
    ],
  });
}

function buildFileApprovalRequestConversation(): CodexConversationSnapshot {
  const conversation = buildStreamingConversation();
  const turns = conversation.turns.map((turn) =>
    turn.turnId === "turn_fixture_streaming"
      ? {
          ...turn,
          itemIds: [...turn.itemIds, "file_fixture_streaming"],
          items: [
            ...turn.items,
            {
              ...REQUEST_CARD_FIXTURES.fileApprovalItem,
              threadId: FIXTURE_THREAD_ID,
              turnId: "turn_fixture_streaming",
              itemId: "file_fixture_streaming",
              entryId: "file_fixture_streaming",
            },
          ],
        }
      : turn,
  );
  return {
    ...conversation,
    turns,
    requests: [
      {
        ...REQUEST_CARD_FIXTURES.fileApproval,
        requestId: "file_approval_fixture_active",
        turnId: "turn_fixture_streaming",
        itemId: "file_fixture_streaming",
        createdAt: 26_000,
      },
    ],
  };
}

function buildMcpElicitationRequestConversation(): CodexConversationSnapshot {
  return buildStreamingConversation({
    requests: [
      {
        ...REQUEST_CARD_FIXTURES.mcpServerElicitation,
        requestId: "mcp_fixture_active",
        turnId: "turn_fixture_streaming",
        itemId: "reasoning_fixture_streaming",
        createdAt: 26_000,
      },
    ],
  });
}

function buildOptionPickerRequestConversation(): CodexConversationSnapshot {
  return buildStreamingConversation({
    canonicalRequests: [
      {
        id: "option_fixture_active",
        method: "item/tool/requestOptionPicker",
        params: {
          threadId: FIXTURE_THREAD_ID,
          turnId: "turn_fixture_streaming",
          question: REQUEST_CARD_FIXTURES.optionPicker.question,
          options: REQUEST_CARD_FIXTURES.optionPicker.options,
          allowMultiple: true,
          submitLabel: "Continue",
          skipLabel: "Not now",
        },
      },
    ],
  });
}

function buildSetupStepRequestConversation(
  step: "role" | "task" | "context",
): CodexConversationSnapshot {
  const request: CodexCanonicalServerRequest =
    step === "context"
      ? {
          id: "setup_context_fixture_active",
          method: "item/tool/requestSetupCodexContextPicker",
          params: {
            threadId: FIXTURE_THREAD_ID,
            turnId: "turn_fixture_streaming",
          },
        }
      : buildDynamicRequest({
          id: `setup_${step}_fixture_active`,
          tool: "setup_codex_step",
          arguments: { step },
        });
  return buildStreamingConversation({ canonicalRequests: [request] });
}

function buildBackgroundPermissionOptionConversation(): {
  conversation: CodexConversationSnapshot;
  childMemberships: readonly CodexConversationChildMembership[];
  knownConversationsById: Record<string, CodexConversationSnapshot>;
} {
  const background = buildBackgroundConversation();
  const childId = background.childMemberships[0]?.threadId;
  if (!childId) return background;
  const childConversation = background.knownConversationsById[childId];
  if (!childConversation) return background;

  const conversation = {
    ...background.conversation,
    requests: [],
    canonicalRequests: buildOptionPickerRequestConversation().canonicalRequests,
  };
  const permissionRequest = {
    ...REQUEST_CARD_FIXTURES.permissionRequest,
    requestId: "permission_fixture_background",
    threadId: childId,
    turnId: "turn_fixture_background",
    itemId: "user_fixture_background",
    reason: "Worker 1 needs read access to verify the generated request matrix.",
    createdAt: 26_500,
  };
  const nextChildConversation = {
    ...childConversation,
    requests: [permissionRequest],
  };
  return {
    conversation,
    childMemberships: background.childMemberships,
    knownConversationsById: {
      ...background.knownConversationsById,
      [conversation.threadId]: conversation,
      [childId]: nextChildConversation,
    },
  };
}

/** Projects canonical requests and background ownership through the production composer models. */
export function buildComposerShellFixture(
  preset: ComposerShellFixturePreset = "background-activity",
): ThreadFooterModel {
  const scenario = buildComposerConversationFixture(preset);
  const conversation = scenario.conversation;
  const activeThreadId = conversation.threadId;
  const turns = conversation.turns;
  const requests = conversation.requests;
  const canonicalRequests = conversation.canonicalRequests ?? [];
  const resumeState = conversation.resumeState;
  const statusType = conversation.statusType;
  const body = buildThreadBodyModel({
    activeThreadId,
    conversation,
    activeThreadArchived: conversation.archived,
    parentTurns: [],
    isNewThreadTab: false,
    newThreadTarget: null,
    isCloudNewThreadTarget: false,
    threadStartProgress: null,
  });
  const primaryRequest = selectPrimaryConversationRequest(conversation);
  const composerShell = buildComposerShellModel({
    threadId: activeThreadId,
    turns,
    requests,
    canonicalRequests,
    pendingSteers: conversation.pendingSteers,
    queuedFollowUps: [...conversation.queuedFollowUps.entries],
    backgroundTerminalRows: conversation.backgroundTerminalRows,
    childMemberships: [...scenario.childMemberships],
    statusType,
    statusActiveFlags: conversation.statusActiveFlags,
    knownConversationsById: scenario.knownConversationsById,
    primaryRequest,
  });
  const activeTurn = [...turns].reverse().find((turn) => turn.status === "inProgress") ?? null;
  const availableModels = preset === "implement-plan" ? IMPLEMENT_PLAN_MODELS : DEFAULT_MODELS;
  const selectedModel =
    preset === "implement-plan" ? "gpt-5.6-sol" : (availableModels[0]?.model ?? "");
  const selectedReasoningEffort = preset === "implement-plan" ? "xhigh" : "high";
  return {
    connectionStatus: "connected",
    workspaceSearchContext: {
      hostId: "local",
      roots: ["/tmp/project"],
      skillRoots: ["/tmp/project"],
    },
    projectId: FIXTURE_PROJECT_ID,
    hostId: "local",
    projectWorkspacePath: FIXTURE_WORKSPACE_PATH,
    threadId: activeThreadId,
    cwd: conversation?.cwd ?? null,
    account: DEFAULT_ACCOUNT_AUTHENTICATED,
    conversation,
    resumeState,
    activeTurn,
    isThreadRunning: Boolean(activeTurn || statusType === "active"),
    isNewThreadTab: false,
    isCloudNewThreadTarget: false,
    newThreadTarget: null,
    composerShell,
    body,
    collaborationModes: DEFAULT_COLLABORATION_MODES,
    selectedCollaborationMode: "default",
    selectedModel,
    modelPickerShortcut: {
      label: "Ctrl+Shift+M",
      ariaKeyShortcuts: "Control+Shift+M",
    },
    availableModels,
    selectedReasoningEffort,
    reasoningEffortOptions: DEFAULT_REASONING_OPTIONS,
    permissionMode: "auto",
    permissionState: {
      mode: "auto",
      effectivePreset: "auto",
      availableModes: ["auto", "guardian-approvals", "full-access", "custom"],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxMode: "workspace-write",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [FIXTURE_WORKSPACE_PATH],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      autoReviewAvailable: true,
      configTarget: {
        source: "user",
        filePath: `${FIXTURE_WORKSPACE_PATH}/.codex/config.toml`,
      },
    },
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    composerIntent: null,
    dictation: DEFAULT_DICTATION_STATE,
  };
}

function buildComposerConversationFixture(preset: ComposerShellFixturePreset): {
  readonly conversation: CodexConversationSnapshot;
  readonly childMemberships: readonly CodexConversationChildMembership[];
  readonly knownConversationsById: Record<string, CodexConversationSnapshot>;
} {
  if (preset === "background-activity") return buildBackgroundConversation();
  if (preset === "background-permission-option")
    return buildBackgroundPermissionOptionConversation();

  const builders = {
    "implement-plan": buildImplementPlanConversation,
    "file-approval-lane": buildFileApprovalRequestConversation,
    "onboarding-input-lane": buildOnboardingInputRequestConversation,
    "permission-lane": buildPermissionRequestConversation,
    "mcp-elicitation-lane": buildMcpElicitationRequestConversation,
    "option-picker-lane": buildOptionPickerRequestConversation,
    "setup-role-lane": () => buildSetupStepRequestConversation("role"),
    "setup-task-lane": () => buildSetupStepRequestConversation("task"),
    "setup-context-lane": () => buildSetupStepRequestConversation("context"),
  } satisfies Record<
    Exclude<ComposerShellFixturePreset, "background-activity" | "background-permission-option">,
    () => CodexConversationSnapshot
  >;
  const conversation = builders[preset]();
  return {
    conversation,
    childMemberships: [],
    knownConversationsById: { [conversation.threadId]: conversation },
  };
}
