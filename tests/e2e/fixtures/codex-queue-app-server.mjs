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
const injectionReleasePath = process.env.NODEX_FAKE_CODEX_INJECTION_RELEASE_PATH;
const threadReadReleasePath = process.env.NODEX_FAKE_CODEX_THREAD_READ_RELEASE_PATH;
// Individual scenarios can opt into newer contracts after enabling their matching fixture paths.
const appServerVersion = process.env.NODEX_FAKE_CODEX_APP_SERVER_VERSION ?? "0.145.0-alpha.15";

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { thread: null, turns: [], turnSequence: 0, queueSequence: 0, queuedSubmissions: [] };
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

const searchSessions = new Map();
const extraSkillDirectory = process.env.NODEX_FAKE_CODEX_SKILL_DIRECTORY;
if (extraSkillDirectory) {
  fs.mkdirSync(extraSkillDirectory, {recursive: true});
  fs.watch(extraSkillDirectory, {recursive: true}, () => notify("skills/changed", {}));
}
const extraSkills = () => {
  if (!extraSkillDirectory) return [];
  return fs.readdirSync(extraSkillDirectory).flatMap((name) => {
    const skillPath = path.join(extraSkillDirectory, name, "SKILL.md");
    if (!fs.existsSync(skillPath)) return [];
    return [{name, description: "Live discovered scenario skill", path: skillPath, scope: "user", enabled: true, pluginId: null}];
  });
};


const promptText = (params) =>
  params.input?.find((item) => item?.type === "text" && typeof item.text === "string")?.text ?? "";

const record = (method, params) => {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify({ method, params })}\n`);
};

record("launch", { args: process.argv.slice(2), pid: process.pid });

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
  id: state.thread?.id ?? (process.env.NODEX_FAKE_CODEX_THREAD_ID ?? "01900000-0000-7000-8000-000000000001"),
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

const listTurns = ({ cursor, limit = 50, sortDirection = "desc", itemsView } = {}) => {
  const ordered = sortDirection === "asc" ? state.turns : [...state.turns].reverse();
  const start = cursor == null ? 0 : ordered.findIndex((entry) => entry.id === cursor);
  if (start < 0) throw new Error(`Unknown turn cursor: ${cursor}`);
  const page = ordered.slice(start, start + (limit ?? 50));
  return {
    data: page.map((entry) =>
      itemsView === "notLoaded" ? { ...entry, items: [], itemsView: "notLoaded" } : entry,
    ),
    nextCursor: ordered[start + page.length]?.id ?? null,
    backwardsCursor: ordered[start - 1]?.id ?? null,
  };
};

const queuedSubmissions = () =>
  Array.isArray(state.queuedSubmissions) ? state.queuedSubmissions : (state.queuedSubmissions = []);

let startQueuedSubmission;

const completeTurn = (turnId, status) => {
  state = readState();
  const current = state.turns.find((entry) => entry.id === turnId);
  if (!current || current.status !== "inProgress") return;
  if (status === "completed" && !current.items.some((item) => item.type === "agentMessage")) {
    const reply = {
      type: "agentMessage",
      id: `reply-${turnId}`,
      text: "The task completed successfully.",
      phase: "final_answer",
      delivery: null,
      memoryCitation: null,
      questions: null,
    };
    current.items.push(reply);
    notify("item/started", { threadId: thread().id, turnId, item: reply, startedAtMs: Date.now() });
    notify("item/completed", { threadId: thread().id, turnId, item: reply, completedAtMs: Date.now() });
  }
  current.status = status;
  current.completedAt = nowSeconds();
  current.durationMs = 50;
  persist();
  notify("turn/completed", { threadId: thread().id, turn: current });
  notify("thread/status/changed", { threadId: thread().id, status: { type: "idle" } });
  if (status === "completed" && queuedSubmissions().length > 0) {
    setTimeout(() => startQueuedSubmission(), 0);
  }
};

const scheduleAutomaticCompletion = (turnId) => {
  setTimeout(
    () => completeTurn(turnId, "completed"),
    Number.isFinite(automaticCompletionDelayMs) ? Math.max(0, automaticCompletionDelayMs) : 120,
  );
};

const startTurn = (params, source = "turn/start") => {
  state = readState();
  state.turnSequence += 1;
  const shouldAutoComplete =
    process.env.NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN === "1" || state.turnSequence > 1;
  const userMessage = {
    type: "userMessage",
    id: `item-user-queue-parity-${state.turnSequence}`,
    clientId: params.clientUserMessageId ?? null,
    content: Array.isArray(params.input) ? params.input : [],
  };
  const next = turn(
    `turn-queue-parity-${state.turnSequence}`,
    "inProgress",
    {},
    process.env.NODEX_FAKE_CODEX_BLOCKED_HOOK_TURN === "1" ? [] : [userMessage],
  );
  state.turns.push(next);
  persist();
  record(source, params);
  setTimeout(() => {
    notify("turn/started", { threadId: thread().id, turn: next });
    if (params.queuedSubmissionId != null) {
      const timestamp = Date.now();
      notify("item/started", {
        threadId: thread().id,
        turnId: next.id,
        item: userMessage,
        startedAtMs: timestamp,
      });
      notify("item/completed", {
        threadId: thread().id,
        turnId: next.id,
        item: userMessage,
        completedAtMs: timestamp,
      });
    }
    notify("thread/status/changed", {
      threadId: thread().id,
      status: { type: "active", activeFlags: [] },
    });
    record("async-question-mode", { enabled: process.env.NODEX_FAKE_CODEX_ASYNC_QUESTIONS === "1" });
    if (process.env.NODEX_FAKE_CODEX_ASYNC_QUESTIONS === "1") {
      setTimeout(() => {
        const currentTurn = state.turns.find((entry) => entry.id === next.id);
        if (!currentTurn || currentTurn.status !== "inProgress") return;
        const item = { type: "agentMessage", id: `question-${next.id}`, text: "Which scope?\nWhat name?", phase: "final_answer", delivery: "async", memoryCitation: null, questions: [{ title: "Which scope should I use?", options: ["Project", "Library"] }, { title: "What should I call it?", options: null }] };
        currentTurn.items.push(item);
        persist();
        notify("item/started", { startedAtMs: Date.now(), threadId: thread().id, turnId: next.id, item });
        notify("item/completed", { completedAtMs: Date.now(), threadId: thread().id, turnId: next.id, item });
        const progress = { type: "agentMessage", id: `progress-${next.id}`, text: "I am checking the available files while you answer.", phase: "commentary", delivery: null, memoryCitation: null, questions: null };
        currentTurn.items.push(progress);
        persist();
        notify("item/started", { startedAtMs: Date.now(), threadId: thread().id, turnId: next.id, item: progress });
        notify("item/completed", { completedAtMs: Date.now(), threadId: thread().id, turnId: next.id, item: progress });
      }, 600);
    }
    if (process.env.NODEX_FAKE_CODEX_FOOTER_METADATA === "1") {
      const skillPath = path.join(process.cwd(), ".agents/skills/footer-review/SKILL.md");
      fs.mkdirSync(path.dirname(skillPath), { recursive: true });
      fs.writeFileSync(skillPath, "---\nname: footer-review\ndescription: Review message actions\n---\nRead the message actions.\n");
      const command = {
        type: "commandExecution", id: `skill-read-${next.id}`, command: `cat ${skillPath}`,
        cwd: process.cwd(), pluginId: null, scriptPath: null, processId: null,
        source: "agent", status: "completed", commandActions: [{ type: "read", command: `cat ${skillPath}`, name: "SKILL.md", path: skillPath }],
        aggregatedOutput: "Read the message actions.", exitCode: 0, durationMs: 20,
      };
      next.items.push(command);
      notify("item/started", { threadId: thread().id, turnId: next.id, item: { ...command, status: "inProgress" }, startedAtMs: Date.now() });
      notify("item/completed", { threadId: thread().id, turnId: next.id, item: command, completedAtMs: Date.now() });
      const review = {
        threadId: thread().id, turnId: next.id, reviewId: `review-${next.id}`, targetItemId: command.id,
        startedAtMs: Date.now(), action: { type: "command", source: "unifiedExec", command: command.command, cwd: process.cwd() },
      };
      notify("item/autoApprovalReview/started", { ...review, review: { status: "inProgress", riskLevel: "low", userAuthorization: "high", rationale: null } });
      notify("item/autoApprovalReview/completed", { ...review, completedAtMs: Date.now(), decisionSource: "agent", review: { status: "approved", riskLevel: "low", userAuthorization: "high", rationale: "Reading the requested skill is allowed." } });
      const rejectedReview = { ...review, reviewId: `rejected-${next.id}`, targetItemId: null, action: { type: "command", source: "unifiedExec", command: "touch protected.txt", cwd: process.cwd() } };
      notify("item/autoApprovalReview/started", { ...rejectedReview, review: { status: "inProgress", riskLevel: "low", userAuthorization: "low", rationale: null } });
      notify("item/autoApprovalReview/completed", { ...rejectedReview, completedAtMs: Date.now(), decisionSource: "agent", review: { status: "denied", riskLevel: "low", userAuthorization: "low", rationale: "Changing the protected file was not requested." } });
      const answer = { type: "agentMessage", id: `reply-${next.id}`, text: "The metadata review is complete.", phase: "final_answer", delivery: null, questions: null,
        memoryCitation: { entries: [{ path: "MEMORY.md", lineStart: 2, lineEnd: 4, note: "Message actions follow project conventions." }], threadIds: [] },
      };
      next.items.push(answer);
      notify("item/started", { threadId: thread().id, turnId: next.id, item: answer, startedAtMs: Date.now() });
      notify("item/completed", { threadId: thread().id, turnId: next.id, item: answer, completedAtMs: Date.now() });
      persist();
      scheduleAutomaticCompletion(next.id);
      return;
    }
    if (process.env.NODEX_FAKE_CODEX_BLOCKED_HOOK_TURN === "1") {
      const run = {
        id: `blocked-hook-${next.id}`, eventName: "userPromptSubmit", handlerType: "command",
        executionMode: "sync", scope: "turn", sourcePath: "/fixture/hooks.json", source: "project",
        displayOrder: 0, status: "blocked", statusMessage: null,
        startedAt: Date.now(), completedAt: Date.now(), durationMs: 0,
        entries: [{ kind: "feedback", text: "The required check did not pass.\nFix it before retrying." }],
      };
      notify("hook/started", { threadId: thread().id, turnId: next.id, run: { ...run, status: "running", entries: [] } });
      notify("hook/completed", { threadId: thread().id, turnId: next.id, run });
      setTimeout(() => completeTurn(next.id, "interrupted"), 100);
      return;
    }
    if (process.env.NODEX_FAKE_CODEX_HOOK_TURN === "1") {
      const run = {
        id: `hook-${next.id}`, eventName: "sessionStart", handlerType: "command",
        executionMode: "sync", scope: "turn", sourcePath: "/fixture/hooks.json", source: "user",
        displayOrder: 0, status: "running", statusMessage: null,
        startedAt: Date.now(), completedAt: null, durationMs: null,
        entries: [{ kind: "context", text: "Injected hook context must stay hidden" }],
      };
      notify("hook/started", { threadId: thread().id, turnId: next.id, run });
      const item = { type: "agentMessage", id: `reply-${next.id}`, text: "The hook completed successfully.", phase: "final_answer", delivery: null, memoryCitation: null, questions: null };
      next.items.push(item);
      notify("item/started", { startedAtMs: Date.now(), threadId: thread().id, turnId: next.id, item });
      notify("item/completed", { completedAtMs: Date.now(), threadId: thread().id, turnId: next.id, item });
      run.status = "completed";
      run.completedAt = Date.now();
      run.durationMs = run.completedAt - run.startedAt;
      persist();
      notify("hook/completed", { threadId: thread().id, turnId: next.id, run });
    }
    if (shouldAutoComplete) scheduleAutomaticCompletion(next.id);
  }, 0);
  return next;
};

startQueuedSubmission = (queuedSubmissionId = null) => {
  state = readState();
  const queue = queuedSubmissions();
  const index = queuedSubmissionId == null
    ? 0
    : queue.findIndex((entry) => entry.id === queuedSubmissionId);
  const submission = queue[index];
  if (!submission) return null;
  queue.splice(index, 1);
  persist();
  notify("thread/queue/changed", { threadId: thread().id });
  return startTurn(
    {
      threadId: thread().id,
      input: submission.input,
      clientUserMessageId: submission.clientUserMessageId,
      queuedSubmissionId: submission.id,
    },
    "queue-turn/start",
  );
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
    case "getAuthStatus":
      respond(id, {
        authMethod: "chatgpt",
        authToken: params.includeToken
          ? `fixture.${Buffer.from(JSON.stringify({ exp: 4102444800, "https://api.openai.com/auth": { chatgpt_account_id: "queue-scenario", user_id: "queue-user" } })).toString("base64url")}.unsigned`
          : null,
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
    case "fuzzyFileSearch/sessionStart":
      searchSessions.set(params.sessionId, {roots: params.roots, query: ""});
      respond(id, {});
      return;
    case "fuzzyFileSearch/sessionUpdate": {
      const session = searchSessions.get(params.sessionId);
      if (!session) {
        write({id, error: {code: -32600, message: "fuzzy file search session not found"}});
        return;
      }
      session.query = params.query;
      respond(id, {});
      setTimeout(() => {
        if (searchSessions.get(params.sessionId) !== session || session.query !== params.query) return;
        const files = params.query === "fzmt" ? [
          {root: session.roots[0], path: "src/fuzzy-match.ts", file_name: "fuzzy-match.ts", match_type: "file", score: 10, indices: null},
          {root: session.roots[0], path: "node_modules/fuzzy-match.ts", file_name: "fuzzy-match.ts", match_type: "file", score: 10, indices: null},
        ] : params.query === "fzdir" ? [
          {root: session.roots[0], path: "src", file_name: "src", match_type: "directory", score: 10, indices: null},
        ] : params.query === "src/" ? [
          {root: session.roots[0], path: "src/fuzzy-match.ts", file_name: "fuzzy-match.ts", match_type: "file", score: 10, indices: null},
        ] : [];
        notify("fuzzyFileSearch/sessionUpdated", {sessionId: params.sessionId, query: params.query, files});
        notify("fuzzyFileSearch/sessionCompleted", {sessionId: params.sessionId});
      }, 5);
      return;
    }
    case "fuzzyFileSearch/sessionStop":
      searchSessions.delete(params.sessionId);
      respond(id, {});
      return;
    case "skills/list":
      respond(id, {
        data: [{
          cwd: process.cwd(),
          errors: [],
          skills: [...(process.env.NODEX_FAKE_CODEX_FOOTER_METADATA === "1" ? [{ name: "footer-review", description: "Review message actions", path: path.join(process.cwd(), ".agents/skills/footer-review/SKILL.md"), scope: "repo", enabled: true, pluginId: null }] : []), ...extraSkills(), ...Array.from({ length: Number(process.env.NODEX_FAKE_CODEX_SKILL_COUNT ?? 0) }, (_, index) => ({
            name: `abc-tool-${index}`,
            description: "aaaa ".repeat(200) + "xb",
            path: `${process.cwd()}/skills/abc-tool-${index}/SKILL.md`,
            scope: "user",
            enabled: true,
            pluginId: null,
          }))],
        }],
      });
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
    case "config/read": {
      const holdPath = process.env.NODEX_FAKE_CODEX_HOLD_CONFIG_PATH;
      if (holdPath && fs.existsSync(holdPath) && fs.readFileSync(holdPath, "utf8") === params.cwd) {
        record("config-read-held", { cwd: params.cwd, id, pid: process.pid });
        return;
      }
      respond(id, { config: emptyConfig, origins: {}, layers: [] });
      return;
    }
    case "config/batchWrite": {
      const keys = new Set(["sandbox_mode", "approval_policy", "approvals_reviewer"]);
      if (!Array.isArray(params.edits) || params.edits.some((edit) => !keys.has(edit.keyPath))) {
        reject(id, method);
        return;
      }
      for (const edit of params.edits) emptyConfig[edit.keyPath] = edit.value;
      respond(id, { status: "ok", version: "scenario-config", filePath: params.filePath ?? path.join(process.env.CODEX_HOME, "config.toml"), overriddenMetadata: null });
      return;
    }
    case "configRequirements/read":
      respond(id, { requirements: null });
      return;
    case "thread/list":
      respond(id, { data: state.thread && !params.parentThreadId ? [thread()] : [], nextCursor: null, backwardsCursor: null });
      return;
    case "thread/start": {
      state.thread = {
        id: (process.env.NODEX_FAKE_CODEX_THREAD_ID ?? "01900000-0000-7000-8000-000000000001"),
        sessionId: "queue-parity-session",
        cwd: params.cwd ?? process.cwd(),
        runtimeWorkspaceRoots: params.runtimeWorkspaceRoots ?? [params.cwd ?? process.cwd()],
        createdAt: nowSeconds(),
      };
      persist();
      record(method, params);
      const profileId = process.env.NODEX_FAKE_CODEX_INITIAL_PERMISSION_PROFILE;
      respond(id, {
        ...threadResponse(),
        ...(profileId ? { activePermissionProfile: { id: profileId, extends: null } } : {}),
      });
      setTimeout(() => notify("thread/started", { thread: thread() }), 0);
      return;
    }
    case "thread/resume": {
      const closingAttempts = Number.parseInt(process.env.NODEX_FAKE_CODEX_RESUME_CLOSING_ATTEMPTS ?? "0", 10);
      if (closingAttempts > 0) {
        state.resumeAttempts = (state.resumeAttempts ?? 0) + 1;
        persist();
        const closing = state.resumeAttempts <= closingAttempts;
        record("resume-attempt", { requestId: id, threadId: params.threadId, closing });
        if (closing) {
          write({ id, error: { code: -32603, message: `thread ${params.threadId} is closing; retry thread/resume after the thread is closed` } });
          return;
        }
      }
      const response = {
        ...threadResponse(params.excludeTurns !== true),
        initialTurnsPage: params.initialTurnsPage ? listTurns(params.initialTurnsPage) : null,
        turnsBackwardsCursor: state.turns.at(-1)?.id ?? null,
        itemsBackwardsCursor: null,
      };
      if (process.env.NODEX_FAKE_CODEX_RESUME_PARENT_CWD === "1") {
        response.cwd = path.dirname(response.cwd);
        record("resume-context", { requestedCwd: params.cwd, responseCwd: response.cwd });
      }
      if (process.env.NODEX_FAKE_CODEX_INITIAL_PERMISSION_PROFILE)
        record("resume-permissions", { activePermissionProfile: response.activePermissionProfile });
      respond(id, response);
      for (const pending of state.turns.slice(1)) {
        if (pending.status === "inProgress") scheduleAutomaticCompletion(pending.id);
      }
      return;
    }
    case "thread/read": {
      if (threadReadReleasePath && params.threadId === "coalesced-read-thread") {
        record("thread/read-held", { requestId: id, ...params });
        const release = setInterval(() => {
          if (!fs.existsSync(threadReadReleasePath)) return;
          clearInterval(release);
          record("thread/read-released", { requestId: id });
          respond(id, {
            thread: { ...thread(params.includeTurns === true), id: params.threadId },
          });
        }, 10);
        release.unref();
        return;
      }
      if (process.env.NODEX_FAKE_CODEX_LARGE_HISTORY === "1" && params.threadId === "large-response-thread") {
        const text = "多窗口😀".repeat(256);
        const turns = Array.from({ length: 4096 }, (_, index) => turn(
          `large-turn-${index}`,
          "completed",
          { startedAt: 1, completedAt: 2, durationMs: 1000 },
          [{ type: "agentMessage", id: `large-item-${index}`, text: `${index}:${text}`, phase: "final_answer", delivery: null, memoryCitation: null, questions: null }],
        ));
        const largeThread = { ...thread(), id: params.threadId, turns };
        const result = { thread: largeThread };
        record("large-history-response", { responseBytes: Buffer.byteLength(`${JSON.stringify({ id, result })}\n`), turnCount: turns.length });
        respond(id, result);
        notify("thread/started", { thread: largeThread });
        return;
      }
      respond(id, { thread: thread(params.includeTurns === true) });
      return;
    }
    case "thread/turns/list":
      respond(id, listTurns(params));
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
    case "thread/queue/list":
      respond(id, { data: [...queuedSubmissions()], nextCursor: null });
      return;
    case "thread/queue/add": {
      state.queueSequence = (state.queueSequence ?? 0) + 1;
      const queuedSubmission = {
        id: `queued-submission-${state.queueSequence}`,
        input: Array.isArray(params.input) ? params.input : [],
        clientUserMessageId: params.clientUserMessageId,
      };
      queuedSubmissions().push(queuedSubmission);
      persist();
      respond(id, { queuedSubmission });
      setTimeout(() => notify("thread/queue/changed", { threadId: params.threadId }), 0);
      return;
    }
    case "thread/queue/update": {
      const queue = queuedSubmissions();
      const index = queue.findIndex((entry) => entry.id === params.queuedSubmissionId);
      const current = queue[index];
      if (!current) {
        write({ id, error: { code: -32600, message: "Queued submission not found" } });
        return;
      }
      const queuedSubmission = { ...current, input: Array.isArray(params.input) ? params.input : [] };
      queue[index] = queuedSubmission;
      persist();
      respond(id, { queuedSubmission });
      setTimeout(() => notify("thread/queue/changed", { threadId: params.threadId }), 0);
      return;
    }
    case "thread/queue/delete": {
      const queue = queuedSubmissions();
      const index = queue.findIndex((entry) => entry.id === params.queuedSubmissionId);
      const deleted = index !== -1;
      if (deleted) queue.splice(index, 1);
      persist();
      respond(id, { deleted });
      if (deleted) setTimeout(() => notify("thread/queue/changed", { threadId: params.threadId }), 0);
      return;
    }
    case "thread/queue/reorder": {
      const queue = queuedSubmissions();
      const byId = new Map(queue.map((entry) => [entry.id, entry]));
      state.queuedSubmissions = params.queuedSubmissionIds.flatMap((queuedId) => {
        const entry = byId.get(queuedId);
        byId.delete(queuedId);
        return entry ? [entry] : [];
      });
      state.queuedSubmissions.push(...byId.values());
      persist();
      respond(id, {});
      setTimeout(() => notify("thread/queue/changed", { threadId: params.threadId }), 0);
      return;
    }
    case "thread/queue/start": {
      const next = startQueuedSubmission(params.queuedSubmissionId ?? null);
      if (!next) {
        write({ id, error: { code: -32600, message: "Queued submission not found" } });
        return;
      }
      respond(id, { turn: next });
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
        state = {
          thread: null,
          turns: [],
          turnSequence: 0,
          queueSequence: 0,
          queuedSubmissions: [],
        };
        persist();
      }
      respond(id, {});
      return;
    case "thread/inject_items": {
      if (!injectionReleasePath) {
        reject(id, method);
        return;
      }
      record("injection-held", { requestId: id, ...params });
      const release = setInterval(() => {
        if (!fs.existsSync(injectionReleasePath)) return;
        clearInterval(release);
        record("injection-released", { requestId: id });
        if (fs.readFileSync(injectionReleasePath, "utf8").trim() === "reject") {
          write({ id, error: { code: -32600, message: "Native context rejected", data: { reason: "ContextRejected" } } });
          return;
        }
        respond(id, {});
      }, 10);
      release.unref();
      return;
    }
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
      if (process.env.NODEX_FAKE_CODEX_ASYNC_STEER_FAILURE === "mismatch-once" && params.expectedTurnId !== "replacement-turn") {
        const activeTurn = state.turns.find((entry) => entry.id === params.expectedTurnId);
        if (activeTurn) activeTurn.id = "replacement-turn";
        persist();
        write({ id, error: { code: -32600, message: `expected active turn id \`${params.expectedTurnId}\` but found \`replacement-turn\`` } });
        return;
      }
      if (["inactive", "mismatch"].includes(process.env.NODEX_FAKE_CODEX_ASYNC_STEER_FAILURE)) {
        const message = process.env.NODEX_FAKE_CODEX_ASYNC_STEER_FAILURE === "inactive"
          ? "no active turn to steer"
          : `expected active turn id \`${params.expectedTurnId}\` but found \`replacement-turn\``;
        write({ id, error: { code: -32600, message } });
        return;
      }
      respond(id, { turnId: params.expectedTurnId });
      if (process.env.NODEX_FAKE_CODEX_ASYNC_QUESTIONS === "1") {
        const currentTurn = state.turns.find((entry) => entry.id === params.expectedTurnId);
        if (currentTurn) setTimeout(() => {
          const item = { type: "userMessage", id: `reply-${Date.now()}`, clientId: params.clientUserMessageId ?? null, content: params.input };
          currentTurn.items.push(item);
          persist();
          notify("item/started", { startedAtMs: Date.now(), threadId: thread().id, turnId: currentTurn.id, item });
          notify("item/completed", { completedAtMs: Date.now(), threadId: thread().id, turnId: currentTurn.id, item });
        }, Number(process.env.NODEX_FAKE_CODEX_ASYNC_ECHO_DELAY_MS ?? 20));
      }
      return;
    case "thread/compact/start": {
      record(method, params);
      const current = state.turns.findLast((entry) => entry.status === "inProgress");
      if (!current) {
        write({ id, error: { code: -32600, message: "No active scenario Turn to compact" } });
        return;
      }
      const item = { type: "contextCompaction", id: `compaction-${current.id}-${current.items.length}` };
      current.items.push(item);
      persist();
      respond(id, {});
      setTimeout(() => {
        notify("item/started", { threadId: thread().id, turnId: current.id, item, startedAtMs: Date.now() });
        notify("item/completed", { threadId: thread().id, turnId: current.id, item, completedAtMs: Date.now() });
      }, 20);
      return;
    }
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
