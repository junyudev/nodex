#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const statePath = process.env.NODEX_FAKE_CODEX_STATE_PATH ?? path.join(process.cwd(), "state.json");
const logPath = process.env.NODEX_FAKE_CODEX_LOG_PATH ?? path.join(process.cwd(), "requests.jsonl");
const automaticCompletionDelayMs = Number.parseInt(
  process.env.NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS ?? "120",
  10,
);
// This fixture implements the bounded paginated-history protocol introduced at this version.
// Do not claim a newer generation until its additional capability contracts are implemented here.
const appServerVersion = "0.145.0-alpha.15";

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { thread: null, turns: [], turnSequence: 0 };
  }
};

let state = readState();
let inputBuffer = "";
const nowSeconds = () => Math.floor(Date.now() / 1_000);

const persist = () => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state));
};

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => write({ id, result });
const reject = (id, method) =>
  write({ id, error: { code: -32601, message: `Unhandled scenario request: ${method}` } });
const notify = (method, params) => write({ method, params });

const promptText = (params) =>
  params.input?.find((item) => item?.type === "text" && typeof item.text === "string")?.text ?? "";

const record = (method, params) => {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify({ method, params })}\n`);
};

const turn = (id, status, timestamps = {}, items = []) => ({
  id,
  items,
  itemsView: "full",
  status,
  error: null,
  startedAt: timestamps.startedAt ?? nowSeconds(),
  completedAt: timestamps.completedAt ?? null,
  durationMs: timestamps.durationMs ?? null,
});

const thread = (includeTurns = false) => ({
  model: null,
  reasoningEffort: null,
  id: state.thread?.id ?? "01900000-0000-7000-8000-000000000001",
  extra: null,
  sessionId: state.thread?.sessionId ?? "queue-parity-session",
  forkedFromId: null,
  parentThreadId: null,
  preview: "Queue parity scenario",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: state.thread?.createdAt ?? nowSeconds(),
  updatedAt: nowSeconds(),
  recencyAt: nowSeconds(),
  status: state.turns.some((entry) => entry.status === "inProgress")
    ? { type: "active", activeFlags: [] }
    : { type: "idle" },
  path: null,
  cwd: state.thread?.cwd ?? process.cwd(),
  cliVersion: appServerVersion,
  source: { custom: "nodex-e2e" },
  canAcceptDirectInput: true,
  threadSource: "user",
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "Queue parity scenario",
  turns: includeTurns ? state.turns : [],
});

const threadResponse = (includeTurns = false) => ({
  thread: thread(includeTurns),
  model: "gpt-5.5",
  modelProvider: "openai",
  serviceTier: null,
  cwd: state.thread?.cwd ?? process.cwd(),
  runtimeWorkspaceRoots: state.thread?.runtimeWorkspaceRoots ?? [state.thread?.cwd ?? process.cwd()],
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

const completeTurn = (turnId, status) => {
  state = readState();
  const current = state.turns.find((entry) => entry.id === turnId);
  if (!current || current.status !== "inProgress") return;
  current.status = status;
  current.completedAt = nowSeconds();
  current.durationMs = 50;
  persist();
  notify("turn/completed", { threadId: thread().id, turn: current });
  notify("thread/status/changed", { threadId: thread().id, status: { type: "idle" } });
};

const scheduleAutomaticCompletion = (turnId) => {
  setTimeout(
    () => completeTurn(turnId, "completed"),
    Number.isFinite(automaticCompletionDelayMs) ? Math.max(0, automaticCompletionDelayMs) : 120,
  );
};

const startTurn = (params) => {
  state = readState();
  state.turnSequence += 1;
  const shouldAutoComplete =
    process.env.NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN === "1" || state.turnSequence > 1;
  const next = turn(
    `turn-queue-parity-${state.turnSequence}`,
    "inProgress",
    {},
    [
      {
        type: "userMessage",
        id: `item-user-queue-parity-${state.turnSequence}`,
        clientId: params.clientUserMessageId ?? null,
        content: Array.isArray(params.input) ? params.input : [],
      },
    ],
  );
  state.turns.push(next);
  persist();
  record("turn/start", params);
  setTimeout(() => {
    notify("turn/started", { threadId: thread().id, turn: next });
    notify("thread/status/changed", {
      threadId: thread().id,
      status: { type: "active", activeFlags: [] },
    });
    if (shouldAutoComplete) scheduleAutomaticCompletion(next.id);
  }, 0);
  return next;
};

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
  desktop: null,
};

const model = {
  id: "gpt-5.5",
  model: "gpt-5.5",
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: "GPT-5.5",
  description: "Queue parity scenario model",
  modelSpecialty: null,
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced test reasoning" },
  ],
  defaultReasoningEffort: "medium",
  inputModalities: ["text", "image"],
  supportsPersonality: false,
  multiAgentVersion: null,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
  isDefault: true,
};

const handle = (message) => {
  state = readState();
  const method = message.method;
  if (typeof method !== "string") return;
  const id = message.id;
  const params = message.params ?? {};
  record("rpc", { method, params });

  switch (method) {
    case "initialize":
      respond(id, {
        userAgent: `codex-app-server/${appServerVersion}`,
        codexHome: process.env.CODEX_HOME ?? process.cwd(),
        platformFamily: os.platform() === "win32" ? "windows" : "unix",
        platformOs: os.platform() === "darwin" ? "macos" : os.platform(),
      });
      return;
    case "initialized":
      return;
    case "account/read":
      respond(id, {
        account: { type: "chatgpt", email: "queue@example.com", planType: "plus" },
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
      respond(id, { data: [] });
      return;
    case "skills/list":
      respond(id, { data: [] });
      return;
    case "hooks/list":
      respond(id, { data: [] });
      return;
    case "experimentalFeature/list":
      respond(id, { data: [], nextCursor: null });
      return;
    case "plugin/installed":
      respond(id, { marketplaces: [], marketplaceLoadErrors: [] });
      return;
    case "mcpServerStatus/list":
      respond(id, { data: [], nextCursor: null });
      return;
    case "config/read":
      respond(id, { config: emptyConfig, origins: {}, layers: [] });
      return;
    case "configRequirements/read":
      respond(id, { requirements: null });
      return;
    case "thread/list":
      respond(id, { data: state.thread ? [thread()] : [], nextCursor: null, backwardsCursor: null });
      return;
    case "thread/start": {
      state.thread = {
        id: "01900000-0000-7000-8000-000000000001",
        sessionId: "queue-parity-session",
        cwd: params.cwd ?? process.cwd(),
        runtimeWorkspaceRoots: params.runtimeWorkspaceRoots ?? [params.cwd ?? process.cwd()],
        createdAt: nowSeconds(),
      };
      persist();
      record(method, params);
      respond(id, threadResponse());
      setTimeout(() => notify("thread/started", { thread: thread() }), 0);
      return;
    }
    case "thread/resume":
      respond(id, {
        ...threadResponse(false),
        initialTurnsPage: null,
        turnsBackwardsCursor: null,
        itemsBackwardsCursor: null,
      });
      for (const pending of state.turns.slice(1)) {
        if (pending.status === "inProgress") scheduleAutomaticCompletion(pending.id);
      }
      return;
    case "thread/read":
      respond(id, { thread: thread(true) });
      return;
    case "thread/turns/list":
      respond(id, {
        data: state.turns.map((entry) =>
          params.itemsView === "notLoaded"
            ? { ...entry, items: [], itemsView: "notLoaded" }
            : entry,
        ),
        nextCursor: null,
        backwardsCursor: null,
      });
      return;
    case "thread/items/list": {
      const selectedTurn = state.turns.find((entry) => entry.id === params.turnId);
      const items = selectedTurn?.items ?? [];
      respond(id, {
        data: (params.sortDirection === "desc" ? [...items].reverse() : items).map((item) => ({
          turnId: params.turnId,
          item,
        })),
        nextCursor: null,
        backwardsCursor: null,
      });
      return;
    }
    case "thread/goal/get":
      respond(id, { goal: null });
      return;
    case "thread/unsubscribe":
      respond(id, {});
      return;
    case "thread/delete":
      if (state.thread?.id === params.threadId) {
        state = { thread: null, turns: [], turnSequence: 0 };
        persist();
      }
      respond(id, {});
      return;
    case "turn/start":
      if (
        process.env.NODEX_FAKE_CODEX_FAIL_ONCE_PROMPT === promptText(params) &&
        state.failedOnce !== true
      ) {
        state.failedOnce = true;
        persist();
        record("turn/start-attempt", params);
        write({ id, error: { code: -32000, message: "Scenario delivery failure" } });
        return;
      }
      respond(id, { turn: startTurn(params) });
      return;
    case "turn/steer":
      record(method, params);
      respond(id, { turnId: params.expectedTurnId });
      return;
    case "turn/interrupt": {
      record(method, params);
      respond(id, {});
      setTimeout(() => completeTurn(params.turnId, "interrupted"), 20);
      return;
    }
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
