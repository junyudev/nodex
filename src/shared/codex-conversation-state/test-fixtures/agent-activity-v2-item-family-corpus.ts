import type { ListMcpServerStatusResponse } from "@nodex/codex-app-server-protocol/v2/ListMcpServerStatusResponse";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2/ThreadItem";
import type { Turn } from "@nodex/codex-app-server-protocol/v2/Turn";

type CommandExecutionItem = Extract<ThreadItem, { type: "commandExecution" }>;
type FileChangeItem = Extract<ThreadItem, { type: "fileChange" }>;
type WebSearchItem = Extract<ThreadItem, { type: "webSearch" }>;
type McpToolCallItem = Extract<ThreadItem, { type: "mcpToolCall" }>;
type DynamicToolCallItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;
type JsonValue = McpToolCallItem["arguments"];

export type AgentActivityV2ItemPayloadFamily =
  | "command"
  | "patch"
  | "web"
  | "mcp"
  | "dynamic";

export type AgentActivityV2PayloadFieldExpectation =
  | {
    readonly path: string;
    readonly state: "equals";
    readonly value: JsonValue;
  }
  | {
    readonly path: string;
    readonly state: "absent" | "own-undefined";
  };

export interface AgentActivityV2ProjectedPayloadExpectation {
  readonly itemType: string;
  readonly fields: readonly AgentActivityV2PayloadFieldExpectation[];
}

export interface AgentActivityV2ItemProjectionContext {
  readonly turnStatus: Turn["status"];
  readonly rawItemIndex: number;
  readonly lastNonUserWorkItemIndex: number | null;
  readonly turnCwd: string | null;
  readonly turnDiff: string | null;
  readonly commandExecutionStartedAtMsById: Readonly<Record<string, number>>;
  readonly interruptedCommandExecutionItemIds: readonly string[];
  readonly mcpServerStatuses: ListMcpServerStatusResponse | null;
}

export type AgentActivityV2ActivityDisposition =
  | "groupable"
  | "standalone"
  | "filtered-before-source"
  | "routed-elsewhere";

export interface AgentActivityV2ItemPayloadCase {
  readonly id: string;
  readonly family: AgentActivityV2ItemPayloadFamily;
  readonly item: ThreadItem;
  readonly projectionContext: AgentActivityV2ItemProjectionContext;
  readonly expected: {
    readonly directPayloads: readonly AgentActivityV2ProjectedPayloadExpectation[];
    readonly aggregateItemTypes: readonly string[];
    readonly activityDispositions: readonly AgentActivityV2ActivityDisposition[];
    readonly identityValues: readonly string[];
  };
  readonly evidence: readonly string[];
}

const DEFAULT_PROJECTION_CONTEXT = {
  turnStatus: "inProgress",
  rawItemIndex: 0,
  lastNonUserWorkItemIndex: null,
  turnCwd: "/workspace/project",
  turnDiff: null,
  commandExecutionStartedAtMsById: {},
  interruptedCommandExecutionItemIds: [],
  mcpServerStatuses: null,
} satisfies AgentActivityV2ItemProjectionContext;

export const agentActivityV2MultiActionCommandItem = {
  type: "commandExecution",
  id: "command-multi",
  command: "sed -n fixture && find src fixture && rg fixture src && git status --short",
  cwd: "/workspace/project",
  processId: "process-fixture",
  pluginId: null,
  scriptPath: null,
  source: "agent",
  status: "completed",
  commandActions: [
    {
      type: "read",
      command: " sed -n '1,80p' src/example.ts ",
      name: "src/example.ts",
      path: "/workspace/project/src/example.ts",
    },
    {
      type: "listFiles",
      command: "find src -maxdepth 1 -type f",
      path: "src",
    },
    {
      type: "search",
      command: "rg -n fixture src",
      query: "fixture",
      path: "src",
    },
    {
      type: "unknown",
      command: "git status --short",
    },
  ],
  aggregatedOutput: "sanitized command output\n",
  exitCode: 0,
  durationMs: 45,
} satisfies CommandExecutionItem;

export const agentActivityV2FallbackCommandItem = {
  type: "commandExecution",
  id: "command-fallback",
  command: "printf fixture",
  cwd: "/workspace/project",
  processId: null,
  pluginId: null,
  scriptPath: null,
  source: "agent",
  status: "completed",
  commandActions: [],
  aggregatedOutput: "",
  exitCode: 0,
  durationMs: null,
} satisfies CommandExecutionItem;

export const agentActivityV2MixedPatchItem = {
  type: "fileChange",
  id: "patch-mixed",
  changes: [
    {
      path: "src/example.ts",
      kind: {
        type: "update",
        move_path: null,
      },
      diff: "@@ -1 +1 @@\n-before\n+after\n",
    },
    {
      path: ".codex/visualizations/2026/07/10/fixture/chart.html",
      kind: {
        type: "add",
      },
      diff: "<html>sanitized visualization</html>",
    },
  ],
  status: "inProgress",
} satisfies FileChangeItem;

export const agentActivityV2FailedPatchItem = {
  type: "fileChange",
  id: "patch-failed",
  changes: [{
    path: "src/failed.ts",
    kind: {
      type: "delete",
    },
    diff: "@@ -1 +0,0 @@\n-export const failed = true;\n",
  }],
  status: "failed",
} satisfies FileChangeItem;

export const agentActivityV2WebSearchItem = {
  type: "webSearch",
  id: "web-search-full",
  query: "public app-server lifecycle",
  action: {
    type: "search",
    query: "public app-server lifecycle",
    queries: ["app-server lifecycle", "tool call lifecycle"],
  },
  results: null,
} satisfies WebSearchItem;

export const agentActivityV2WhitespaceWebSearchItem = {
  type: "webSearch",
  id: "web-search-whitespace",
  query: "   ",
  action: null,
  results: null,
} satisfies WebSearchItem;

export const agentActivityV2ActiveWebSearchItem = {
  type: "webSearch",
  id: "web-search-active-last",
  query: "https://example.invalid/fixture",
  action: {
    type: "openPage",
    url: "https://example.invalid/fixture",
  },
  results: null,
} satisfies WebSearchItem;

const FULL_MCP_APP_CONTEXT = {
  connectorId: "connector-fixture",
  linkId: "link-fixture",
  resourceUri: null,
  appName: "Fixture App",
  actionName: "Lookup fixture",
} as const;

export const agentActivityV2McpAppContextPrecedenceItem = {
  type: "mcpToolCall",
  id: "mcp-app-context",
  server: "fixture_app",
  tool: "lookup",
  status: "completed",
  arguments: {
    query: "fixture",
  },
  appContext: {
    ...FULL_MCP_APP_CONTEXT,
    resourceUri: "ui://fixture/preferred",
  },
  mcpAppUi: null,
  mcpAppResourceUri: "ui://fixture/deprecated",
  pluginId: "plugin-fixture",
  readOnlyHint: true,
  result: {
    content: [{
      type: "text",
      text: "sanitized MCP result",
    }],
    structuredContent: {
      count: 1,
    },
    _meta: {
      fixture: true,
    },
  },
  error: null,
  durationMs: 22,
} satisfies McpToolCallItem;

export const agentActivityV2McpBrowserSourceItem = {
  type: "mcpToolCall",
  id: "mcp-browser-source",
  server: "node_repl",
  tool: "run",
  status: "completed",
  arguments: {
    code: "fixture()",
  },
  appContext: FULL_MCP_APP_CONTEXT,
  mcpAppUi: null,
  pluginId: "plugin-browser-fixture",
  readOnlyHint: false,
  result: {
    content: [{
      type: "resource_link",
      uri: "https://example.invalid/fixture",
      name: "Fixture resource",
      title: "Fixture resource",
      description: "Sanitized resource link",
      mimeType: "text/plain",
    }],
    structuredContent: {
      ok: true,
    },
    _meta: {
      "codex/toolSurface": {
        kind: "browserUse",
        backend: "chrome",
      },
    },
  },
  error: null,
  durationMs: 18,
} satisfies McpToolCallItem;

export const agentActivityV2McpComputerUseItem = {
  type: "mcpToolCall",
  id: "mcp-computer-active",
  server: "computer-use",
  tool: "computer",
  status: "inProgress",
  arguments: {
    action: "screenshot",
  },
  appContext: null,
  mcpAppUi: null,
  pluginId: null,
  readOnlyHint: false,
  result: null,
  error: null,
  durationMs: null,
} satisfies McpToolCallItem;

export const agentActivityV2McpErrorItem = {
  type: "mcpToolCall",
  id: "mcp-protocol-error",
  server: "fixture_server",
  tool: "fail",
  status: "failed",
  arguments: {
    fixture: true,
  },
  appContext: null,
  mcpAppUi: null,
  pluginId: null,
  readOnlyHint: null,
  result: {
    content: [{
      type: "text",
      text: "sanitized result that must lose to the protocol error",
    }],
    structuredContent: {
      shouldNotWin: true,
    },
    _meta: {
      shouldNotWin: true,
    },
  },
  error: {
    message: "sanitized MCP failure",
  },
  durationMs: 7,
} satisfies McpToolCallItem;

export const agentActivityV2McpStatusResolvedAppItem = {
  type: "mcpToolCall",
  id: "mcp-status-app",
  server: "status_server",
  tool: "status_tool",
  status: "completed",
  arguments: {},
  appContext: null,
  mcpAppUi: null,
  pluginId: null,
  readOnlyHint: true,
  result: {
    content: [],
    structuredContent: null,
    _meta: null,
  },
  error: null,
  durationMs: 3,
} satisfies McpToolCallItem;

const MCP_STATUS_APP_CONTEXT = {
  data: [{
    name: "status_server",
    runtimeStatus: null,
    pluginId: null,
    httpOrigin: null,
    serverInfo: null,
    serverCapabilities: null,
    toolsError: null,
    tools: {
      status_tool: {
        name: "status_tool",
        inputSchema: {
          type: "object",
        },
        _meta: {
          ui: {
            resourceUri: "ui://fixture/status-app",
          },
        },
      },
    },
    resources: [],
    resourceTemplates: [],
    authStatus: "unsupported",
  }],
  nextCursor: null,
} satisfies ListMcpServerStatusResponse;

export const agentActivityV2McpTerminalOverrideItem = {
  ...agentActivityV2McpComputerUseItem,
  id: "mcp-terminal-override",
  server: "fixture_server",
  tool: "still_in_progress",
} satisfies McpToolCallItem;

export const agentActivityV2DynamicGenericActiveItem = {
  type: "dynamicToolCall",
  id: "dynamic-generic-active",
  namespace: "fixture_namespace",
  tool: "fixture_tool",
  arguments: {
    input: "fixture",
  },
  status: "inProgress",
  contentItems: null,
  success: null,
  durationMs: null,
} satisfies DynamicToolCallItem;

export const agentActivityV2DynamicGenericFailedItem = {
  type: "dynamicToolCall",
  id: "dynamic-generic-failed",
  namespace: "fixture_namespace",
  tool: "fixture_tool",
  arguments: {
    input: "fixture",
  },
  status: "failed",
  contentItems: [{
    type: "inputText",
    text: "sanitized dynamic output",
  }],
  success: false,
  durationMs: 12,
} satisfies DynamicToolCallItem;

export const agentActivityV2DynamicCreateThreadItem = {
  type: "dynamicToolCall",
  id: "dynamic-create-thread",
  namespace: "codex_app",
  tool: "create_thread",
  arguments: {
    target: {
      type: "project",
      projectId: "project-fixture",
      environment: {
        type: "local",
      },
    },
    prompt: "sanitized task prompt",
  },
  status: "completed",
  contentItems: [{
    type: "inputText",
    text: "{\"threadId\":\"thread-created-fixture\"}",
  }],
  success: true,
  durationMs: 30,
} satisfies DynamicToolCallItem;

export const agentActivityV2DynamicHandoffItem = {
  type: "dynamicToolCall",
  id: "dynamic-handoff-thread",
  namespace: "codex_app",
  tool: "handoff_thread",
  arguments: {
    threadId: "thread-destination-fixture",
    destinationHostId: "host-fixture",
    followUpPrompt: "sanitized follow-up",
  },
  status: "completed",
  contentItems: [
    {
      type: "inputText",
      text: "{\"operationId\":\"operation-fixture\"}",
    },
    {
      type: "inputImage",
      imageUrl: "data:image/png;base64,c2FuaXRpemVk",
    },
  ],
  success: true,
  durationMs: 40,
} satisfies DynamicToolCallItem;

export const agentActivityV2DynamicAutomationUpdateItem = {
  type: "dynamicToolCall",
  id: "dynamic-automation-update",
  namespace: "codex_app",
  tool: "automation_update",
  arguments: {
    mode: "view",
    id: "automation-request-fixture",
  },
  status: "completed",
  contentItems: [{
    type: "inputText",
    text: "{\"automationId\":\"automation-resolved-fixture\"}",
  }],
  success: true,
  durationMs: 15,
} satisfies DynamicToolCallItem;

export const agentActivityV2DynamicAutomationFailedItem = {
  ...agentActivityV2DynamicAutomationUpdateItem,
  id: "dynamic-automation-failed",
  status: "failed",
  contentItems: null,
  success: false,
  durationMs: 8,
} satisfies DynamicToolCallItem;

export const agentActivityV2DynamicLoadWorkspaceIgnoredItem = {
  type: "dynamicToolCall",
  id: "dynamic-load-workspace-ignored",
  namespace: "codex_app",
  tool: "load_workspace_dependencies",
  arguments: {},
  status: "completed",
  contentItems: [{
    type: "inputText",
    text: "sanitized dependency paths",
  }],
  success: true,
  durationMs: 5,
} satisfies DynamicToolCallItem;

function equals(path: string, value: JsonValue): AgentActivityV2PayloadFieldExpectation {
  return {
    path,
    state: "equals",
    value,
  };
}

function presence(
  path: string,
  state: "absent" | "own-undefined",
): AgentActivityV2PayloadFieldExpectation {
  return {
    path,
    state,
  };
}

const COMMAND_EVIDENCE = [
  "h59fr3q5.pretty.js:95555-95605 (command projection and split identity)",
  "h59fr3q5.pretty.js:66501-66531,66641-66649 (action mapping and finished state)",
];
const PATCH_EVIDENCE = [
  "h59fr3q5.pretty.js:95609-95645 (patch projection)",
  "h59fr3q5.pretty.js:66292-66382,66534-66564 (visualization and change mapping)",
  "h59fr3q5.pretty.js:95333-95360,96001-96028 (turn diff synthesis)",
];
const WEB_EVIDENCE = [
  "h59fr3q5.pretty.js:95144-95156,95879-95887 (web completion and projection)",
  "g4rafana.pretty.js:5401-5402,29944-29967 (blank-query filtering)",
];
const MCP_EVIDENCE = [
  "h59fr3q5.pretty.js:94917-94920,95421-95441 (MCP source and projection)",
  "h59fr3q5.pretty.js:66385-66466 (MCP result normalization)",
  "g4rafana.pretty.js:4528-4552,5404-5413,5504-5510 (MCP classification)",
];
const DYNAMIC_EVIDENCE = [
  "h59fr3q5.pretty.js:95652-95705 (dynamic projection and exclusions)",
  "g4rafana.pretty.js:29944-30105 (automation-update diversion before activity source)",
  "k0ede4gb.pretty.js:252347,253225,254721-254750,254905-254924 (dynamic registry)",
];

export const agentActivityV2ItemFamilyCorpus = [
  {
    id: "command-multi-action-completed",
    family: "command",
    item: agentActivityV2MultiActionCommandItem,
    projectionContext: {
      ...DEFAULT_PROJECTION_CONTEXT,
      commandExecutionStartedAtMsById: {
        "command-multi": 1_000,
      },
    },
    expected: {
      directPayloads: ["read", "list_files", "search", "unknown"].map(
        (parsedType, index) => ({
          itemType: "exec",
          fields: [
            equals("/callId", `command-multi:${index}`),
            equals("/commandExecutionItemId", "command-multi"),
            equals("/startedAtMs", 1_000),
            equals("/parsedCmd/type", parsedType),
            equals("/output/exitCode", 0),
          ],
        }),
      ),
      aggregateItemTypes: [],
      activityDispositions: ["groupable", "groupable", "groupable", "groupable"],
      identityValues: [
        "command-multi:0",
        "command-multi:1",
        "command-multi:2",
        "command-multi:3",
      ],
    },
    evidence: COMMAND_EVIDENCE,
  },
  {
    id: "command-zero-action-fallback",
    family: "command",
    item: agentActivityV2FallbackCommandItem,
    projectionContext: DEFAULT_PROJECTION_CONTEXT,
    expected: {
      directPayloads: [{
        itemType: "exec",
        fields: [
          equals("/callId", "command-fallback"),
          presence("/commandExecutionItemId", "absent"),
          presence("/processId", "own-undefined"),
          presence("/startedAtMs", "own-undefined"),
          presence("/durationMs", "own-undefined"),
          equals("/parsedCmd/type", "unknown"),
          equals("/output/aggregatedOutput", ""),
        ],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["groupable"],
      identityValues: ["command-fallback"],
    },
    evidence: COMMAND_EVIDENCE,
  },
  {
    id: "patch-normal-plus-visualization",
    family: "patch",
    item: agentActivityV2MixedPatchItem,
    projectionContext: DEFAULT_PROJECTION_CONTEXT,
    expected: {
      directPayloads: [{
        itemType: "patch",
        fields: [
          equals("/callId", "patch-mixed"),
          equals("/changes/src~1example.ts/type", "update"),
          equals("/visualizationActivities/0/kind", "create"),
          equals("/success", null),
        ],
      }],
      aggregateItemTypes: ["turn-diff"],
      activityDispositions: ["groupable"],
      identityValues: ["patch-mixed"],
    },
    evidence: PATCH_EVIDENCE,
  },
  {
    id: "patch-failed-no-turn-diff",
    family: "patch",
    item: agentActivityV2FailedPatchItem,
    projectionContext: DEFAULT_PROJECTION_CONTEXT,
    expected: {
      directPayloads: [{
        itemType: "patch",
        fields: [
          equals("/callId", "patch-failed"),
          equals("/success", false),
        ],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["groupable"],
      identityValues: ["patch-failed"],
    },
    evidence: PATCH_EVIDENCE,
  },
  {
    id: "web-search-full-action",
    family: "web",
    item: agentActivityV2WebSearchItem,
    projectionContext: {
      ...DEFAULT_PROJECTION_CONTEXT,
      rawItemIndex: 4,
      lastNonUserWorkItemIndex: 7,
    },
    expected: {
      directPayloads: [{
        itemType: "web-search",
        fields: [
          equals("/query", "public app-server lifecycle"),
          equals("/action/type", "search"),
          equals("/completed", true),
          presence("/id", "absent"),
        ],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["groupable"],
      identityValues: ["source-index-fallback"],
    },
    evidence: WEB_EVIDENCE,
  },
  {
    id: "web-search-active-last",
    family: "web",
    item: agentActivityV2ActiveWebSearchItem,
    projectionContext: {
      ...DEFAULT_PROJECTION_CONTEXT,
      rawItemIndex: 7,
      lastNonUserWorkItemIndex: 7,
    },
    expected: {
      directPayloads: [{
        itemType: "web-search",
        fields: [
          equals("/query", "https://example.invalid/fixture"),
          equals("/action/type", "openPage"),
          equals("/completed", false),
          presence("/id", "absent"),
        ],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["groupable"],
      identityValues: ["source-index-fallback"],
    },
    evidence: WEB_EVIDENCE,
  },
  {
    id: "web-search-whitespace-filtered",
    family: "web",
    item: agentActivityV2WhitespaceWebSearchItem,
    projectionContext: {
      ...DEFAULT_PROJECTION_CONTEXT,
      rawItemIndex: 2,
      lastNonUserWorkItemIndex: 3,
    },
    expected: {
      directPayloads: [{
        itemType: "web-search",
        fields: [
          equals("/query", "   "),
          equals("/completed", true),
        ],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["filtered-before-source"],
      identityValues: [],
    },
    evidence: WEB_EVIDENCE,
  },
  {
    id: "mcp-app-context-precedence",
    family: "mcp",
    item: agentActivityV2McpAppContextPrecedenceItem,
    projectionContext: DEFAULT_PROJECTION_CONTEXT,
    expected: {
      directPayloads: [{
        itemType: "mcp-tool-call",
        fields: [
          equals("/mcpAppResourceUri", "ui://fixture/preferred"),
          equals("/pluginId", "plugin-fixture"),
          equals("/result/type", "success"),
          equals("/result/raw/_meta/fixture", true),
          presence("/appContext", "absent"),
        ],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["standalone"],
      identityValues: ["mcp-app-context"],
    },
    evidence: MCP_EVIDENCE,
  },
  {
    id: "mcp-node-repl-browser-source",
    family: "mcp",
    item: agentActivityV2McpBrowserSourceItem,
    projectionContext: {
      ...DEFAULT_PROJECTION_CONTEXT,
      mcpServerStatuses: {
        data: [],
        nextCursor: null,
      },
    },
    expected: {
      directPayloads: [{
        itemType: "mcp-tool-call",
        fields: [
          equals("/source/kind", "browserUse"),
          equals("/source/backend", "chrome"),
          equals("/result/content/0/type", "resource_link"),
          equals("/completed", true),
        ],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["groupable"],
      identityValues: ["mcp-browser-source"],
    },
    evidence: MCP_EVIDENCE,
  },
  {
    id: "mcp-computer-use-active",
    family: "mcp",
    item: agentActivityV2McpComputerUseItem,
    projectionContext: DEFAULT_PROJECTION_CONTEXT,
    expected: {
      directPayloads: [{
        itemType: "mcp-tool-call",
        fields: [
          equals("/functionName", "computer-use__computer"),
          equals("/completed", false),
          equals("/result", null),
        ],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["standalone"],
      identityValues: ["mcp-computer-active"],
    },
    evidence: MCP_EVIDENCE,
  },
  {
    id: "mcp-protocol-error",
    family: "mcp",
    item: agentActivityV2McpErrorItem,
    projectionContext: DEFAULT_PROJECTION_CONTEXT,
    expected: {
      directPayloads: [{
        itemType: "mcp-tool-call",
        fields: [
          equals("/result/type", "error"),
          equals("/result/kind", "protocol"),
          equals("/result/error", "sanitized MCP failure"),
          equals("/completed", true),
        ],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["groupable"],
      identityValues: ["mcp-protocol-error"],
    },
    evidence: MCP_EVIDENCE,
  },
  {
    id: "mcp-status-resolved-app",
    family: "mcp",
    item: agentActivityV2McpStatusResolvedAppItem,
    projectionContext: {
      ...DEFAULT_PROJECTION_CONTEXT,
      mcpServerStatuses: MCP_STATUS_APP_CONTEXT,
    },
    expected: {
      directPayloads: [{
        itemType: "mcp-tool-call",
        fields: [
          presence("/mcpAppResourceUri", "own-undefined"),
          equals("/completed", true),
        ],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["standalone"],
      identityValues: ["mcp-status-app"],
    },
    evidence: [
      ...MCP_EVIDENCE,
      "k0ede4gb.pretty.js:200591-200625 (ListMcpServerStatusResponse.data resolver)",
    ],
  },
  {
    id: "mcp-terminal-turn-override",
    family: "mcp",
    item: agentActivityV2McpTerminalOverrideItem,
    projectionContext: {
      ...DEFAULT_PROJECTION_CONTEXT,
      turnStatus: "completed",
    },
    expected: {
      directPayloads: [{
        itemType: "mcp-tool-call",
        fields: [equals("/completed", true)],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["groupable"],
      identityValues: ["mcp-terminal-override"],
    },
    evidence: MCP_EVIDENCE,
  },
  {
    id: "dynamic-generic-active",
    family: "dynamic",
    item: agentActivityV2DynamicGenericActiveItem,
    projectionContext: DEFAULT_PROJECTION_CONTEXT,
    expected: {
      directPayloads: [{
        itemType: "dynamic-tool-call",
        fields: [
          equals("/completed", false),
          presence("/contentItems", "absent"),
          presence("/success", "absent"),
          presence("/durationMs", "absent"),
          presence("/status", "absent"),
        ],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["groupable"],
      identityValues: ["dynamic-generic-active"],
    },
    evidence: DYNAMIC_EVIDENCE,
  },
  {
    id: "dynamic-generic-failed-output-elided",
    family: "dynamic",
    item: agentActivityV2DynamicGenericFailedItem,
    projectionContext: DEFAULT_PROJECTION_CONTEXT,
    expected: {
      directPayloads: [{
        itemType: "dynamic-tool-call",
        fields: [
          equals("/completed", true),
          presence("/contentItems", "absent"),
          presence("/success", "absent"),
          presence("/durationMs", "absent"),
        ],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["groupable"],
      identityValues: ["dynamic-generic-failed"],
    },
    evidence: DYNAMIC_EVIDENCE,
  },
  {
    id: "dynamic-create-thread-groupable",
    family: "dynamic",
    item: agentActivityV2DynamicCreateThreadItem,
    projectionContext: DEFAULT_PROJECTION_CONTEXT,
    expected: {
      directPayloads: [{
        itemType: "dynamic-tool-call",
        fields: [
          equals("/callId", "dynamic-create-thread"),
          equals("/contentItems/0/type", "inputText"),
          equals("/success", true),
        ],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["groupable"],
      identityValues: ["dynamic-create-thread"],
    },
    evidence: DYNAMIC_EVIDENCE,
  },
  {
    id: "dynamic-handoff-standalone",
    family: "dynamic",
    item: agentActivityV2DynamicHandoffItem,
    projectionContext: DEFAULT_PROJECTION_CONTEXT,
    expected: {
      directPayloads: [{
        itemType: "dynamic-tool-call",
        fields: [
          equals("/callId", "dynamic-handoff-thread"),
          equals("/contentItems/1/type", "inputImage"),
          equals("/success", true),
        ],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["standalone"],
      identityValues: ["dynamic-handoff-thread"],
    },
    evidence: DYNAMIC_EVIDENCE,
  },
  {
    id: "dynamic-automation-update-routed",
    family: "dynamic",
    item: agentActivityV2DynamicAutomationUpdateItem,
    projectionContext: DEFAULT_PROJECTION_CONTEXT,
    expected: {
      directPayloads: [{
        itemType: "automation-update",
        fields: [
          equals("/callId", "dynamic-automation-update"),
          equals("/arguments/mode", "view"),
          equals("/arguments/id", "automation-resolved-fixture"),
          equals("/result/automationId", "automation-resolved-fixture"),
          equals("/result/mode", null),
        ],
      }],
      aggregateItemTypes: [],
      activityDispositions: ["routed-elsewhere"],
      identityValues: [],
    },
    evidence: DYNAMIC_EVIDENCE,
  },
  {
    id: "dynamic-automation-update-failed-hidden",
    family: "dynamic",
    item: agentActivityV2DynamicAutomationFailedItem,
    projectionContext: DEFAULT_PROJECTION_CONTEXT,
    expected: {
      directPayloads: [],
      aggregateItemTypes: [],
      activityDispositions: [],
      identityValues: [],
    },
    evidence: DYNAMIC_EVIDENCE,
  },
  {
    id: "dynamic-load-workspace-excluded",
    family: "dynamic",
    item: agentActivityV2DynamicLoadWorkspaceIgnoredItem,
    projectionContext: DEFAULT_PROJECTION_CONTEXT,
    expected: {
      directPayloads: [],
      aggregateItemTypes: [],
      activityDispositions: [],
      identityValues: [],
    },
    evidence: DYNAMIC_EVIDENCE,
  },
] satisfies readonly AgentActivityV2ItemPayloadCase[];

function expectedRawType(family: AgentActivityV2ItemPayloadFamily): ThreadItem["type"] {
  switch (family) {
    case "command":
      return "commandExecution";
    case "patch":
      return "fileChange";
    case "web":
      return "webSearch";
    case "mcp":
      return "mcpToolCall";
    case "dynamic":
      return "dynamicToolCall";
  }
}

export function validateAgentActivityV2ItemFamilyCorpus(): readonly string[] {
  const errors: string[] = [];
  const caseIds = new Set<string>();
  const itemIds = new Set<string>();
  const families = new Set<AgentActivityV2ItemPayloadFamily>();

  for (const payloadCase of agentActivityV2ItemFamilyCorpus) {
    if (caseIds.has(payloadCase.id)) {
      errors.push(`duplicate item payload case ${payloadCase.id}`);
    }
    caseIds.add(payloadCase.id);

    if (itemIds.has(payloadCase.item.id)) {
      errors.push(`duplicate raw item id ${payloadCase.item.id}`);
    }
    itemIds.add(payloadCase.item.id);
    families.add(payloadCase.family);

    if (payloadCase.item.type !== expectedRawType(payloadCase.family)) {
      errors.push(
        `item payload case ${payloadCase.id} family ${payloadCase.family} does not match ${payloadCase.item.type}`,
      );
    }
    if (payloadCase.evidence.length === 0) {
      errors.push(`item payload case ${payloadCase.id} has no exact evidence`);
    }
    if (
      payloadCase.expected.directPayloads.length
      !== payloadCase.expected.activityDispositions.length
    ) {
      errors.push(`item payload case ${payloadCase.id} has misaligned activity dispositions`);
    }
    const visibleDispositionCount = payloadCase.expected.activityDispositions.filter(
      (disposition) => disposition === "groupable" || disposition === "standalone",
    ).length;
    if (payloadCase.expected.identityValues.length !== visibleDispositionCount) {
      errors.push(`item payload case ${payloadCase.id} has misaligned activity identities`);
    }

    for (const projectedPayload of payloadCase.expected.directPayloads) {
      const paths = new Set<string>();
      for (const field of projectedPayload.fields) {
        if (!field.path.startsWith("/") || field.path.length < 2) {
          errors.push(`item payload case ${payloadCase.id} has invalid field path ${field.path}`);
        }
        if (paths.has(field.path)) {
          errors.push(`item payload case ${payloadCase.id} repeats field path ${field.path}`);
        }
        paths.add(field.path);
      }
    }
  }

  for (const family of ["command", "patch", "web", "mcp", "dynamic"] as const) {
    if (!families.has(family)) {
      errors.push(`item payload corpus is missing family ${family}`);
    }
  }

  return errors;
}
