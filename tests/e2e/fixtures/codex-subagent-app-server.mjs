#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const statePath = process.env.NODEX_FAKE_CODEX_STATE_PATH ?? path.join(process.cwd(), "state.json");
const logPath = process.env.NODEX_FAKE_CODEX_LOG_PATH ?? path.join(process.cwd(), "requests.jsonl");
const doneCount = Number.parseInt(process.env.NODEX_FAKE_SUBAGENT_DONE_COUNT ?? "12", 10);
const rootAutoCompleteMs = Number.parseInt(
  process.env.NODEX_FAKE_SUBAGENT_AUTO_COMPLETE_ROOT_MS ?? "",
  10,
);
const collabItemDelayMs = Number.parseInt(
  process.env.NODEX_FAKE_SUBAGENT_COLLAB_ITEM_DELAY_MS ?? "",
  10,
);
const receiverReadDelayMs = Number.parseInt(
  process.env.NODEX_FAKE_SUBAGENT_RECEIVER_READ_DELAY_MS ?? "",
  10,
);
const reconnectReadDelayMs = Number.parseInt(
  process.env.NODEX_FAKE_SUBAGENT_RECONNECT_READ_DELAY_MS ?? "",
  10,
);
const reconnectNotificationEnabled =
  process.env.NODEX_FAKE_SUBAGENT_RECONNECT_NOTIFICATION === "1";
const selectedDeleteDelayMs = Number.parseInt(
  process.env.NODEX_FAKE_SUBAGENT_DELETE_SELECTED_MS ?? "",
  10,
);
const topologyRecoveryEnabled = process.env.NODEX_FAKE_SUBAGENT_TOPOLOGY_MISSED_EDGE === "1";
const scenarioThreadTimestampHex =
  process.env.NODEX_FAKE_SUBAGENT_UUID_V7_TIMESTAMP_HEX ?? Date.now().toString(16).padStart(12, "0");
if (!/^[0-9a-f]{12}$/u.test(scenarioThreadTimestampHex)) {
  throw new Error("Subagent scenario UUIDv7 timestamp must be 12 lowercase hexadecimal digits");
}
const scenarioThreadId = (suffix) =>
  `${scenarioThreadTimestampHex.slice(0, 8)}-${scenarioThreadTimestampHex.slice(8)}-7000-8000-${suffix}`;
const nowSeconds = () => Math.floor(Date.now() / 1_000);
const rootThreadId = scenarioThreadId("000000000101");
const fallbackInterruptThreadId = scenarioThreadId("000000000201");
const selectedThreadId = scenarioThreadId("000000000202");
const relationshipReceiverThreadId = scenarioThreadId("000000000299");

const activeDefinitions = [
  {
    id: scenarioThreadId("000000000201"),
    name: "Lead explorer",
    preview: "Map the repository boundaries",
    status: { type: "active", activeFlags: [] },
    parentThreadId: rootThreadId,
    depth: 1,
  },
  {
    id: scenarioThreadId("000000000202"),
    name: "Deep investigator",
    preview: "Trace the selected-only hydration path",
    status: { type: "active", activeFlags: [] },
    parentThreadId: rootThreadId,
    depth: 1,
  },
  {
    id: scenarioThreadId("000000000203"),
    name: "Approval sentinel",
    preview: "Wait for a bounded user decision",
    status: { type: "active", activeFlags: ["waitingOnUserInput"] },
    parentThreadId: rootThreadId,
    depth: 1,
  },
  {
    id: scenarioThreadId("000000000204"),
    name: "Reconnect scout",
    preview: "Retain unknown state across residency changes",
    status: { type: "notLoaded" },
    parentThreadId: rootThreadId,
    depth: 1,
  },
  {
    id: scenarioThreadId("000000000205"),
    name: "Nested verifier",
    preview: "Verify recursive descendant discovery",
    status: { type: "active", activeFlags: [] },
    parentThreadId: scenarioThreadId("000000000201"),
    depth: 2,
  },
];

const doneDefinitions = Array.from({ length: Math.max(0, doneCount) }, (_, index) => ({
  id: scenarioThreadId(String(301 + index).padStart(12, "0")),
  name: `Archive specialist ${index + 1}`,
  preview: `Completed metadata audit ${index + 1}`,
  status: { type: "idle" },
  parentThreadId: index === 11 ? activeDefinitions[0].id : rootThreadId,
  depth: index === 11 ? 2 : 1,
}));

const definitions = [...activeDefinitions, ...doneDefinitions];
const topologyRecoveredDefinition = topologyRecoveryEnabled ? (doneDefinitions.at(-1) ?? null) : null;
const relationshipReceiverDefinition = {
  id: relationshipReceiverThreadId,
  name: "Delayed relationship receiver",
  preview: "Hydrate relationship metadata outside the notification lane",
  status: { type: "notLoaded" },
  parentThreadId: rootThreadId,
  depth: 1,
};
const discoveryDefinitions = [
  activeDefinitions[4],
  ...activeDefinitions.slice(0, 4),
  ...doneDefinitions.filter((definition) => definition !== topologyRecoveredDefinition),
];

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {
      rootStarted: false,
      rootTurnStarted: false,
      completedChildIds: [],
      interruptedChildIds: [],
    };
  }
};

let state = readState();
let inputBuffer = "";

const persist = () => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state));
};

const processInstance = {
  ordinal: (Array.isArray(state.appServerInstances) ? state.appServerInstances.length : 0) + 1,
  pid: process.pid,
  startedAtMs: Date.now(),
};
state.appServerInstances = [
  ...(Array.isArray(state.appServerInstances) ? state.appServerInstances : []),
  processInstance,
];
persist();

const record = (method, params) => {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({
      atMs: Date.now(),
      processInstanceOrdinal: processInstance.ordinal,
      processPid: processInstance.pid,
      method,
      params,
    })}\n`,
  );
};

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => write({ id, result });
const reject = (id, method) =>
  write({ id, error: { code: -32601, message: `Unhandled subagent scenario request: ${method}` } });
const notify = (method, params) => write({ method, params });

const emptyTurn = (id, status = "inProgress", itemsView = "full") => ({
  id,
  items: [],
  itemsView,
  status,
  error: null,
  startedAt: nowSeconds(),
  completedAt: status === "inProgress" ? null : nowSeconds(),
  durationMs: status === "inProgress" ? null : 25,
});

const topologyEdgeItem = () =>
  topologyRecoveredDefinition
    ? {
        type: "collabAgentToolCall",
        id: "spawn-topology-missed-edge",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: fallbackInterruptThreadId,
        receiverThreadIds: [topologyRecoveredDefinition.id],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      }
    : null;

const topologyEdgeItems = () => {
  const item = topologyEdgeItem();
  return item ? [item] : [];
};

const topologyTurn = () => ({
  ...emptyTurn("turn-topology-missed-edge", "completed", "full"),
  items: topologyEdgeItems(),
});

const rootThread = (includeTurns = false) => ({
  id: rootThreadId,
  extra: null,
  sessionId: "subagent-parity-session",
  forkedFromId: null,
  parentThreadId: null,
  preview: "Coordinate the subagent parity scenario",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: nowSeconds() - 120,
  updatedAt: nowSeconds(),
  recencyAt: nowSeconds(),
  status: state.rootTurnStarted
    ? { type: "active", activeFlags: [] }
    : { type: "idle" },
  path: null,
  cwd: process.cwd(),
  cliVersion: "0.0.0-subagent-parity-scenario",
  source: { custom: "nodex-subagent-e2e" },
  canAcceptDirectInput: true,
  threadSource: "user",
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "Subagent parity scenario",
  turns: includeTurns && state.rootTurnStarted ? [emptyTurn("turn-subagent-root")] : [],
});

const definitionById = (threadId) => {
  if (Array.isArray(state.deletedChildIds) && state.deletedChildIds.includes(threadId)) return null;
  return definitions.find((definition) => definition.id === threadId) ?? null;
};

const scheduleSelectedDelete = (threadId) => {
  if (
    threadId !== selectedThreadId ||
    !Number.isFinite(selectedDeleteDelayMs) ||
    selectedDeleteDelayMs < 0 ||
    state.selectedDeleteScheduledAtMs
  ) {
    return;
  }
  state.selectedDeleteScheduledAtMs = Date.now();
  persist();
  setTimeout(() => {
    state = readState();
    state.deletedChildIds = [
      ...new Set([
        ...(Array.isArray(state.deletedChildIds) ? state.deletedChildIds : []),
        threadId,
      ]),
    ];
    state.selectedDeletedAtMs = Date.now();
    persist();
    notify("thread/deleted", { threadId });
  }, selectedDeleteDelayMs);
};

const notifyReconnectAuthority = () => {
  if (!reconnectNotificationEnabled || processInstance.ordinal < 2) return;
  state = readState();
  const notifiedInstances = new Set(
    Array.isArray(state.reconnectNotificationInstances)
      ? state.reconnectNotificationInstances
      : [],
  );
  if (notifiedInstances.has(processInstance.ordinal)) return;
  notifiedInstances.add(processInstance.ordinal);
  state.reconnectNotificationInstances = [...notifiedInstances];
  state.reconnectNotificationAtMs = Date.now();
  persist();
  notify("thread/status/changed", {
    threadId: selectedThreadId,
    status: { type: "active", activeFlags: [] },
  });
};

const hasChildState = (key, threadId) =>
  Array.isArray(state[key]) && state[key].includes(threadId);

const childStatus = (definition) => {
  if (hasChildState("interruptedChildIds", definition.id)) return { type: "notLoaded" };
  if (hasChildState("completedChildIds", definition.id)) return { type: "idle" };
  return definition.status;
};

const childTurnStatus = (definition) => {
  if (hasChildState("interruptedChildIds", definition.id)) return "interrupted";
  if (hasChildState("completedChildIds", definition.id)) return "completed";
  return definition.status.type === "active" ? "inProgress" : "completed";
};

const childThread = (definition, includeTurns = false) => {
  const status = childStatus(definition);
  const agentRole = status.type === "idle" ? "reviewer" : "explorer";
  return {
    id: definition.id,
    extra: null,
    sessionId: "subagent-parity-session",
    forkedFromId: null,
    parentThreadId: definition.parentThreadId,
    preview: definition.preview,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "openai",
    createdAt: nowSeconds() - 90 + definitions.indexOf(definition),
    updatedAt: nowSeconds() - definitions.indexOf(definition),
    recencyAt: nowSeconds() - definitions.indexOf(definition),
    status,
    path: null,
    cwd: process.cwd(),
    cliVersion: "0.0.0-subagent-parity-scenario",
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: definition.parentThreadId,
          depth: definition.depth,
          agent_nickname: definition.name,
          agent_role: agentRole,
          agent_path: `agents/${definition.name.toLowerCase().replaceAll(" ", "-")}`,
        },
      },
    },
    canAcceptDirectInput: status.type === "active",
    threadSource: "subagent",
    agentNickname: definition.name,
    agentRole,
    gitInfo: null,
    name: definition.name,
    turns: includeTurns
      ? [emptyTurn(`turn-${definition.id}`, childTurnStatus(definition))]
      : [],
  };
};

const threadResponse = (thread) => ({
  thread,
  model: "gpt-5.5",
  modelProvider: "openai",
  serviceTier: null,
  cwd: thread.cwd,
  runtimeWorkspaceRoots: [thread.cwd],
  instructionSources: [],
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: { type: "dangerFullAccess" },
  activePermissionProfile: null,
  reasoningEffort: "medium",
  multiAgentMode: "explicitRequestOnly",
  initialTurnsPage: null,
  turnsBackwardsCursor: null,
  itemsBackwardsCursor: null,
});

const emptyConfig = {
  model: null,
  review_model: null,
  model_context_window: null,
  model_auto_compact_token_limit: null,
  model_auto_compact_token_limit_scope: null,
  model_provider: null,
  approval_policy: null,
  approvals_reviewer: null,
  sandbox_mode: null,
  sandbox_workspace_write: null,
  forced_chatgpt_workspace_id: null,
  forced_login_method: null,
  web_search: null,
  tools: null,
  instructions: null,
  developer_instructions: null,
  compact_prompt: null,
  model_reasoning_effort: null,
  model_reasoning_summary: null,
  model_verbosity: null,
  service_tier: null,
  analytics: null,
  apps: null,
  browser_use: null,
  computer_use: null,
  desktop: null,
};

const model = {
  id: "gpt-5.5",
  model: "gpt-5.5",
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: "GPT-5.5",
  description: "Subagent parity scenario model",
  modelSpecialty: null,
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced test reasoning" },
  ],
  defaultReasoningEffort: "medium",
  inputModalities: ["text", "image"],
  supportsPersonality: false,
  multiAgentVersion: "v2",
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
  isDefault: true,
};

const notifyBootstrapSubagent = () => {
  const parent = activeDefinitions[0];
  const nested = activeDefinitions[4];
  state.activeNotificationChildIds = [
    ...new Set([
      ...(Array.isArray(state.activeNotificationChildIds)
        ? state.activeNotificationChildIds
        : []),
      parent.id,
    ]),
  ];
  state.spawnNotificationThreadIds = [nested.id, parent.id];
  persist();
  setTimeout(() => notify("thread/started", { thread: childThread(nested) }), 0);
  setTimeout(() => notify("thread/started", { thread: childThread(parent) }), 25);
};

const completeRootNormally = () => {
  state = readState();
  if (!state.rootTurnStarted) return;
  state.rootTurnStarted = false;
  state.rootCompletedAtMs = Date.now();
  persist();
  notify("turn/completed", {
    threadId: rootThreadId,
    turn: emptyTurn("turn-subagent-root", "completed"),
  });
  notify("thread/status/changed", { threadId: rootThreadId, status: { type: "idle" } });
};

const notifyNoOwnerCollabItem = () => {
  state = readState();
  if (!state.rootTurnStarted) return;
  state.collabItemNotificationAtMs = Date.now();
  persist();
  notify("item/started", {
    threadId: rootThreadId,
    turnId: "turn-subagent-root",
    startedAtMs: Date.now(),
    item: {
      type: "collabAgentToolCall",
      id: "collab-delayed-relationship-repair",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: rootThreadId,
      receiverThreadIds: [relationshipReceiverThreadId],
      prompt: "Repair metadata without blocking later notifications",
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    },
  });
};

const notifyTopologyMissedEdge = () => {
  if (!topologyRecoveredDefinition) return;
  state = readState();
  if (!state.rootTurnStarted) return;
  state.topologyNotificationAtMs = Date.now();
  persist();
  notify("item/started", {
    threadId: rootThreadId,
    turnId: "turn-subagent-root",
    startedAtMs: Date.now(),
    item: {
      type: "subAgentActivity",
      id: "activity-topology-missed-edge",
      kind: "started",
      agentThreadId: topologyRecoveredDefinition.id,
      agentPath: "agents/archive-specialist-12",
    },
  });
};

const completeRootAndCascadedChildren = () => {
  state.rootTurnStarted = false;
  state.completedChildIds = activeDefinitions
    .filter((definition) => definition.id !== fallbackInterruptThreadId)
    .map((definition) => definition.id);
  persist();

  setTimeout(() => {
    notify("turn/completed", {
      threadId: rootThreadId,
      turn: emptyTurn("turn-subagent-root", "interrupted"),
    });
    notify("thread/status/changed", { threadId: rootThreadId, status: { type: "idle" } });
    for (const definition of activeDefinitions) {
      if (definition.id === fallbackInterruptThreadId) continue;
      notify("turn/completed", {
        threadId: definition.id,
        turn: emptyTurn(`turn-${definition.id}`, "completed"),
      });
    }
  }, 0);
};

const interruptFallbackChild = (threadId) => {
  const interrupted = new Set(
    Array.isArray(state.interruptedChildIds) ? state.interruptedChildIds : [],
  );
  interrupted.add(threadId);
  state.interruptedChildIds = [...interrupted];
  state.childInterruptAcceptedAtMs = Date.now();
  persist();

  // Keep distinct interrupted and runtime-idle observations. The first proves
  // conservative Unknown projection; the second is the terminal evidence that
  // permits the overview to move the resumable child to Done.
  setTimeout(() => {
    state = readState();
    state.childInterruptedNotificationAtMs = Date.now();
    persist();
    notify("turn/completed", {
      threadId,
      turn: emptyTurn(`turn-${threadId}`, "interrupted"),
    });
  }, 500);
  setTimeout(() => {
    state = readState();
    state.completedChildIds = [
      ...new Set([
        ...(Array.isArray(state.completedChildIds) ? state.completedChildIds : []),
        threadId,
      ]),
    ];
    state.childIdleNotificationAtMs = Date.now();
    persist();
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
  }, 650);
};

const handle = (message) => {
  state = readState();
  const method = message.method;
  if (typeof method !== "string") return;
  const id = message.id;
  const params = message.params ?? {};
  record(method, params);

  switch (method) {
    case "initialize":
      respond(id, {
        userAgent: "codex-app-server/0.152.0",
        codexHome: process.env.CODEX_HOME ?? process.cwd(),
        platformFamily: os.platform() === "win32" ? "windows" : "unix",
        platformOs: os.platform() === "darwin" ? "macos" : os.platform(),
      });
      return;
    case "initialized":
      setTimeout(notifyReconnectAuthority, 150);
      return;
    case "account/read":
      respond(id, {
        account: { type: "chatgpt", email: "subagents@example.com", planType: "plus" },
        requiresOpenaiAuth: false,
      });
      return;
    case "getAuthStatus":
      respond(id, {
        authMethod: "chatgpt",
        authToken: null,
        requiresOpenaiAuth: false,
      });
      return;
    case "account/rateLimits/read":
      respond(id, { rateLimits: null });
      return;
    case "model/list":
      respond(id, { data: [model], nextCursor: null });
      return;
    case "collaborationMode/list":
    case "skills/list":
    case "hooks/list":
      respond(id, { data: [] });
      return;
    case "experimentalFeature/list":
    case "mcpServerStatus/list":
      respond(id, { data: [], nextCursor: null });
      return;
    case "plugin/installed":
      respond(id, { marketplaces: [], marketplaceLoadErrors: [] });
      return;
    case "config/read":
      respond(id, { config: emptyConfig, origins: {}, layers: [] });
      return;
    case "configRequirements/read":
      respond(id, { requirements: null });
      return;
    case "thread/list": {
      if (params.ancestorThreadId === rootThreadId) {
        const visibleDefinitions = discoveryDefinitions.filter(
          (definition) => definitionById(definition.id) !== null,
        );
        state.lastDiscoveryThreadIds = visibleDefinitions.map((definition) => definition.id);
        persist();
        respond(id, {
          data: visibleDefinitions.map((definition) => childThread(definition)),
          nextCursor: null,
          backwardsCursor: null,
        });
        return;
      }
      respond(id, {
        data: state.rootStarted ? [rootThread()] : [],
        nextCursor: null,
        backwardsCursor: null,
      });
      return;
    }
    case "threadSection/list":
      respond(id, { data: [], nextCursor: null });
      return;
    case "thread/start":
      state.rootStarted = true;
      persist();
      respond(id, threadResponse(rootThread()));
      return;
    case "thread/resume": {
      if (params.threadId === rootThreadId) {
        respond(id, threadResponse(rootThread(params.excludeTurns !== true)));
        return;
      }
      const definition = definitionById(params.threadId);
      if (!definition) {
        write({ id, error: { code: -32004, message: "Scenario Thread not found" } });
        return;
      }
      respond(id, threadResponse(childThread(definition, params.excludeTurns !== true)));
      return;
    }
    case "thread/turns/list": {
      const itemsView = params.itemsView ?? "summary";
      if (params.threadId === rootThreadId) {
        respond(id, {
          data: state.rootTurnStarted
            ? [emptyTurn("turn-subagent-root", "inProgress", itemsView)]
            : [],
          nextCursor: null,
          backwardsCursor: null,
        });
        return;
      }
      const definition = definitionById(params.threadId);
      respond(id, {
        data:
          definition?.id === fallbackInterruptThreadId && itemsView === "full"
            ? [topologyTurn()]
            : definition
              ? [emptyTurn(`turn-${definition.id}`, childTurnStatus(definition), itemsView)]
              : [],
        nextCursor: null,
        backwardsCursor: null,
      });
      return;
    }
    case "thread/items/list":
      respond(id, { data: [], nextCursor: null, backwardsCursor: null });
      return;
    case "thread/read": {
      if (
        params.threadId === selectedThreadId &&
        processInstance.ordinal === 1 &&
        Number.isFinite(reconnectReadDelayMs) &&
        reconnectReadDelayMs >= 0
      ) {
        const definition = definitionById(params.threadId);
        state.reconnectReadStartedAtMs = Date.now();
        state.reconnectReadRespondedAtMs = null;
        persist();
        setTimeout(() => {
          state = readState();
          state.reconnectReadRespondedAtMs = Date.now();
          persist();
          respond(id, {
            thread: definition
              ? childThread(definition, params.includeTurns === true)
              : rootThread(params.includeTurns === true),
          });
        }, reconnectReadDelayMs);
        return;
      }
      if (
        params.threadId === relationshipReceiverThreadId &&
        Number.isFinite(receiverReadDelayMs) &&
        receiverReadDelayMs >= 0
      ) {
        state.receiverReadStartedAtMs = Date.now();
        state.receiverReadRespondedAtMs = null;
        persist();
        setTimeout(() => {
          state = readState();
          state.receiverReadRespondedAtMs = Date.now();
          persist();
          respond(id, { thread: childThread(relationshipReceiverDefinition) });
        }, receiverReadDelayMs);
        return;
      }
      const definition = definitionById(params.threadId);
      respond(id, { thread: definition ? childThread(definition, params.includeTurns === true) : rootThread(params.includeTurns === true) });
      if (definition) scheduleSelectedDelete(definition.id);
      return;
    }
    case "thread/goal/get":
      respond(id, { goal: null });
      return;
    case "thread/unsubscribe":
    case "thread/delete":
      respond(id, {});
      return;
    case "turn/start": {
      state.rootTurnStarted = true;
      state.rootTurnStartedAtMs = Date.now();
      state.rootCompletedAtMs = null;
      persist();
      const started = {
        ...emptyTurn("turn-subagent-root"),
        items: [],
      };
      respond(id, { turn: started });
      setTimeout(() => {
        notify("turn/started", { threadId: rootThreadId, turn: started });
        notify("thread/status/changed", {
          threadId: rootThreadId,
          status: { type: "active", activeFlags: [] },
        });
        notifyBootstrapSubagent();
        setTimeout(notifyTopologyMissedEdge, 75);
      }, 0);
      if (Number.isFinite(rootAutoCompleteMs) && rootAutoCompleteMs >= 0) {
        setTimeout(completeRootNormally, rootAutoCompleteMs);
      }
      if (Number.isFinite(collabItemDelayMs) && collabItemDelayMs >= 0) {
        setTimeout(notifyNoOwnerCollabItem, collabItemDelayMs);
      }
      return;
    }
    case "turn/interrupt": {
      respond(id, {});
      if (params.threadId === rootThreadId) {
        completeRootAndCascadedChildren();
        return;
      }
      if (params.threadId === fallbackInterruptThreadId) {
        interruptFallbackChild(params.threadId);
      }
      return;
    }
    case "turn/steer":
      respond(id, {});
      return;
    default:
      if (id !== undefined) reject(id, method);
  }
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  const lines = inputBuffer.split("\n");
  inputBuffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
