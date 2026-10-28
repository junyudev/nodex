#!/usr/bin/env node
// Native protocol peer for an owned Electron scenario. Delegation uses the real MCP HTTP boundary.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

const kind = path.basename(process.argv[1]).startsWith("claude") ? "claude" : "codex";
if (process.argv.includes("--version")) {
  console.log(kind === "claude" ? "2.1.284 (Claude Code)" : "codex-cli 0.145.0-alpha.15");
  process.exit(0);
}
const home = process.env.NODEX_TEST_CROSS_PROVIDER_HOME;
if (!home) throw new Error("The native peer requires its owned fixture home");
const record = (event) => fs.appendFileSync(path.join(home, "native.jsonl"), `${JSON.stringify({ kind, ...event })}\n`);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const argument = (name) => {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const load = () => {
  try { return JSON.parse(fs.readFileSync(path.join(home, "codex-state.json"), "utf8")); }
  catch { return { threads: {} }; }
};
let state = load();
const persist = () => {
  const target = path.join(home, "codex-state.json");
  fs.writeFileSync(`${target}.${process.pid}.tmp`, JSON.stringify(state));
  fs.renameSync(`${target}.${process.pid}.tmp`, target);
};
// Like the real server, a config override may name a nested table or a dotted path.
const configValue = (config, key) => {
  if (config && Object.hasOwn(config, key)) return config[key];
  return key.split(".").reduce((value, part) => value?.[part], config ?? undefined);
};
const servers = new Map();
/** Input steered into an active turn, read by that turn before it finishes. */
const steered = new Map();
const mcpProfiles = new WeakMap();
const config = Object.fromEntries([
  "model", "review_model", "model_context_window", "model_auto_compact_token_limit", "model_auto_compact_token_limit_scope", "model_provider",
  "approval_policy", "approvals_reviewer", "sandbox_mode", "sandbox_workspace_write", "forced_chatgpt_workspace_id", "forced_login_method",
  "web_search", "tools", "instructions", "developer_instructions", "compact_prompt", "model_reasoning_effort", "model_reasoning_summary",
  "model_verbosity", "service_tier", "analytics", "apps", "browser_use", "computer_use", "desktop",
].map((key) => [key, null]));
const nativeSessionId = argument("--resume") ?? argument("--session-id") ?? randomUUID();
let claudeServer;
let claudeRunning = false;
let claudeHooks = {};
const hookRequests = new Map();
const model = argument("--model") ?? "claude-sonnet-5-5";
const notify = (method, params) => emit({ method, params });
const nativeThread = (id, cwd) => ({
  id, cwd, name: null, preview: "Native fixture", ephemeral: false, modelProvider: "openai",
  environments: null, model: null, reasoningEffort: null, extra: null, sessionId: id,
  forkedFromId: null, parentThreadId: null, section: null, sectionEnteredAt: null, projectId: null,
  historyMode: "paginated", recencyAt: Math.floor(Date.now()/1000), originator: null,
  canAcceptDirectInput: true, threadSource: "user", agentNickname: null, agentRole: null, gitInfo: null, daybreakEnabled: null,
  createdAt: Math.floor(Date.now()/1000), updatedAt: Math.floor(Date.now()/1000), source: { custom: "nodex-e2e" },
  status: { type: "idle" }, path: null, turns: [], cliVersion: "0.145.0-alpha.15", forkedFromId: null,
});
const nativeTurn = (id, status = "inProgress", items = []) => ({ id, rootTurnId: null, status, items, itemsView: "full", error: null, startedAt: Math.floor(Date.now()/1000), completedAt: null, durationMs: null });

const threadResponse = (thread, selectedModel) => ({
  thread, model: selectedModel ?? "gpt-5.5", modelProvider: "openai", serviceTier: null, cwd: thread.cwd,
  runtimeWorkspaceRoots: [thread.cwd], instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user",
  sandbox: { type: "dangerFullAccess" },
  activePermissionProfile: null, reasoningEffort: "medium", multiAgentMode: "explicitRequestOnly", initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null,
});

async function invokeClaudeHook(event, name, args, callId) {
  const callbacks = claudeHooks[event]?.flatMap((entry) => entry.hookCallbackIds ?? []) ?? [];
  let updated = args;
  for (const callbackId of callbacks) {
    const requestId = randomUUID();
    const response = await new Promise((resolve) => {
      hookRequests.set(requestId, resolve);
      emit({ type: "control_request", request_id: requestId, request: {
        subtype: "hook_callback", callback_id: callbackId, tool_use_id: callId,
        input: { hook_event_name: event, session_id: nativeSessionId, cwd: process.cwd(),
          tool_name: `mcp__nodex_app__${name}`, tool_input: updated, tool_use_id: callId },
      } });
    });
    if (response.hookSpecificOutput?.permissionDecision === "deny") throw new Error(response.hookSpecificOutput.permissionDecisionReason);
    updated = response.hookSpecificOutput?.updatedInput ?? updated;
  }
  return updated;
}

async function callTool(server, name, args, native) {
  if (!server?.url) throw new Error("Execution MCP registration is missing");
  let profile = mcpProfiles.get(server);
  if (!profile) {
    const initialize = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(server.headers ?? server.http_headers) },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "nodex-native-fixture", version: "1" } } }),
    });
    await initialize.text();
    profile = initialize.headers.get("mcp-session-id");
    if (!initialize.ok || !profile) throw new Error("MCP initialization did not establish its native session");
    mcpProfiles.set(server, profile);
    await fetch(server.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": profile, ...(server.headers ?? server.http_headers) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  }
  const callId = randomUUID();
  const item = { type: "mcpToolCall", id: callId, server: "nodex_app", tool: name, status: "inProgress",
    arguments: args, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: null,
    result: null, error: null, durationMs: null };
  if (kind === "codex") notify("item/started", { ...native, item, startedAtMs: Date.now() });
  else args = await invokeClaudeHook("PreToolUse", name, args, callId);
  let response;
  let json;
  try {
    response = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": profile, ...(server.headers ?? server.http_headers) },
      body: JSON.stringify({ jsonrpc: "2.0", id: callId, method: "tools/call", params: { name, arguments: args,
        ...(kind === "codex" ? { _meta: { callId, threadId: native.threadId,
          "x-codex-turn-metadata": { turn_id: native.turnId, root_turn_id: native.turnId } } } : {}),
      } }),
    });
    const body = await response.text();
    json = body.trim().startsWith("{") ? JSON.parse(body) : body.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))).find((value) => value.result || value.error);
  } finally {
    // Like Codex, the completed call carries what the tool returned.
    const result = json?.result;
    if (kind === "codex") notify("item/completed", { ...native, item: { ...item, status: result && !result.isError ? "completed" : "failed",
      result: result ? { content: result.content ?? [], structuredContent: result.structuredContent ?? null, _meta: null } : null }, completedAtMs: Date.now() });
    else await invokeClaudeHook("PostToolUse", name, args, callId);
  }
  if (!response.ok || !json || json.error || json.result?.isError)
    throw new Error(`Execution tool failed: ${response.status} ${JSON.stringify(json?.error ?? json?.result)}`);
  const result = json.result.structuredContent;
  record({ event: "tool.result", name, result });
  return result;
}

async function answer(prompt, server, native) {
  const plan = JSON.parse(fs.readFileSync(path.join(home, "plan.json"), "utf8"));
  const delegation = plan[prompt];
  if (typeof delegation?.reply === "string") return delegation.reply;
  if (!delegation) {
    // One finished task or a batch of siblings that finished before the parent woke.
    const terminalNotice = /^Delegated tasks? (\S+(?:, \S+)*) reached (?:a terminal state|terminal states)\./u.exec(prompt);
    if (terminalNotice) {
      const summaries = [];
      for (const taskId of terminalNotice[1].split(", ")) {
        const result = await callTool(server, "task_status", { taskId }, native);
        if (result.status !== "completed" || typeof result.summary !== "string")
          throw new Error(`Delegated completion has no completed result: ${JSON.stringify(result)}`);
        record({ event: "task.result-read", taskId: result.taskId, summary: result.summary });
        summaries.push(result.summary);
      }
      return summaries.length === 1
        ? `${kind === "claude" ? "Claude" : "Codex"} received async ${summaries[0]}`
        : `${kind === "claude" ? "Claude" : "Codex"} received ${summaries.length} async results`;
    }
    if (prompt === "Follow up after async completion") return "Codex follow-up complete";
    return `${kind === "claude" ? "Claude" : "Codex"} child report`;
  }
  if (delegation.createSession) {
    const created = await callTool(server, "create_session", delegation.createSession, native);
    record({ event: "session.created", sessionId: created.sessionId, threadId: created.threadId });
    return `${kind === "claude" ? "Claude" : "Codex"} started ${delegation.createSession.title}`;
  }
  record({ event: "delegate.started", prompt });
  await callTool(server, "list_agent_models", {}, native);
  if (delegation.fanout) {
    const taskIds = [];
    for (let index = 1; index <= delegation.fanout; index++) {
      const task = `${delegation.task} ${index}`;
      const result = await callTool(server, "delegate_task", {
        task, title: task, target: delegation.target, mode: "async", timeoutMs: 30_000,
        clientRequestId: `fixture:${nativeSessionId}:${prompt}:${index}`,
      }, native);
      taskIds.push(result.taskId);
    }
    record({ event: "fanout.delegated", taskIds });
    return `${kind === "claude" ? "Claude" : "Codex"} delegated ${taskIds.length} async children`;
  }
  const input = {
    task: delegation.task, title: delegation.task, target: delegation.target, mode: delegation.mode ?? "wait",
    timeoutMs: delegation.timeoutMs ?? 30_000, clientRequestId: `fixture:${nativeSessionId}:${prompt}`,
  };
  const result = await callTool(server, "delegate_task", input, native);
  if (delegation.mode !== "async") {
    const retried = await callTool(server, "delegate_task", input, native);
    if (retried.taskId !== result.taskId) throw new Error("A delegation retry changed its task identity");
  }
  if (delegation.mode === "async") return "Codex delegated async child";
  return `${kind === "claude" ? "Claude" : "Codex"} received ${result.summary ?? result.status}`;
}

function finishCodex(threadId, turnId, status, text) {
  state = load();
  const thread = state.threads[threadId];
  const turn = thread?.turns.find((value) => value.id === turnId);
  if (!turn || turn.status !== "inProgress") return;
  steered.delete(turnId);
  const texts = (Array.isArray(text) ? text : [text]).filter(Boolean);
  for (const [index, value] of texts.entries()) {
    const phase = index === texts.length - 1 ? "final_answer" : "commentary";
    const item = { type: "agentMessage", id: randomUUID(), text: value, phase, delivery: null, memoryCitation: null, questions: null };
    turn.items.push(item);
    notify("item/started", { threadId, turnId, item, startedAtMs: Date.now() });
    notify("item/completed", { threadId, turnId, item, completedAtMs: Date.now() });
  }
  turn.status = status;
  turn.completedAt = Math.floor(Date.now()/1000);
  persist();
  notify("turn/completed", { threadId, turn });
  notify("thread/status/changed", { threadId, status: { type: "idle" } });
}
function claudeResult(text, interrupted = false) {
  if (!claudeRunning) return;
  claudeRunning = false;
  if (text) emit({ type: "assistant", session_id: nativeSessionId, uuid: randomUUID(), parent_tool_use_id: null, message: { id: randomUUID(), role: "assistant", model, content: [{ type: "text", text }], usage: { input_tokens: 12, output_tokens: 5 } } });
  emit({ type: "result", subtype: "success", session_id: nativeSessionId, uuid: randomUUID(), is_error: false, result: text ?? "Stopped", duration_ms: 20, duration_api_ms: 20, num_turns: 1, stop_reason: interrupted ? null : "end_turn", total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] });
}

async function handleCodex(message) {
  const { id, method } = message;
  const params = message.params ?? {};
  if (id === undefined) return;
  record({ event: "request", method, threadId: params.threadId ?? null });
  const reply = (result) => emit({ id, result });
  switch (method) {
    case "initialize": reply({ userAgent: "codex-app-server/0.145.0-alpha.15", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" }); return;
    case "getAuthStatus": reply({ authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: false }); return;
    case "account/read": reply({ account: { type: "chatgpt", email: "runtime@nodex.invalid", planType: "plus" }, requiresOpenaiAuth: false }); return;
    case "account/rateLimits/read": reply({ rateLimits: null }); return;
    case "model/list": reply({ data: [{ id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5", description: "Native fixture", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }], defaultReasoningEffort: "medium", inputModalities: ["text", "image"], isDefault: true }], nextCursor: null }); return;
    case "skills/list": reply({ data: [] }); return;
    case "plugin/installed": reply({ marketplaces: [], marketplaceLoadErrors: [] }); return;
    case "plugin/list": reply({ marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }); return;
    case "hooks/list": reply({ data: [] }); return;
    case "collaborationMode/list": reply({ data: [] }); return;
    case "mcpServerStatus/list": reply({ data: [], nextCursor: null }); return;
    case "experimentalFeature/list": reply({ data: [], nextCursor: null }); return;
    case "configRequirements/read": reply({ requirements: null, supportsIndependentSpeedModes: null }); return;
    case "config/read": reply({ config, origins: {}, layers: [] }); return;
    case "thread/list": reply({ data: [], nextCursor: null }); return;
    case "threadSection/list": reply({ data: [], nextCursor: null }); return;
    case "thread/start": {
      const threadId = randomUUID();
      state = load();
      const thread = { ...nativeThread(threadId, params.cwd), ephemeral: params.ephemeral === true, turns: [] };
      state.threads[threadId] = thread;
      persist();
      servers.set(threadId, configValue(params.config, "mcp_servers.nodex_app"));
      reply(threadResponse(thread, params.model)); return;
    }
    case "thread/resume": {
      state = load();
      const thread = state.threads[params.threadId];
      if (!thread) { emit({ id, error: { code: -32001, message: "Thread missing" } }); return; }
      servers.set(thread.id, configValue(params.config, "mcp_servers.nodex_app"));
      reply(threadResponse(thread, params.model)); return;
    }
    case "thread/read": { state = load(); reply({ thread: state.threads[params.threadId] }); return; }
    case "thread/fork": {
      // A native fork copies the source history through its last turn into a new thread.
      state = load();
      const source = state.threads[params.threadId];
      if (!source) { emit({ id, error: { code: -32001, message: "Thread missing" } }); return; }
      const last = params.lastTurnId === undefined ? source.turns.length : source.turns.findIndex((turn) => turn.id === params.lastTurnId) + 1;
      const threadId = randomUUID();
      const thread = { ...nativeThread(threadId, params.cwd ?? source.cwd), ephemeral: params.ephemeral === true, forkedFromId: source.id, turns: source.turns.slice(0, last), injectedItems: source.injectedItems ?? [] };
      state.threads[threadId] = thread;
      persist();
      servers.set(threadId, configValue(params.config, "mcp_servers.nodex_app"));
      record({ event: "fork", sourceThreadId: source.id, threadId });
      reply(threadResponse(thread, params.model)); return;
    }
    case "turn/start": {
      const turnId = randomUUID();
      const prompt = params.input?.filter((value) => value.type === "text").map((value) => value.text).join("\n") ?? "";
      state = load();
      const priorItems = [...(state.threads[params.threadId].injectedItems ?? []), ...state.threads[params.threadId].turns.flatMap((entry) => entry.items)];
      const turn = nativeTurn(turnId, "inProgress", [{ type: "userMessage", id: randomUUID(), clientId: params.clientUserMessageId ?? null, content: params.input ?? [] }]);
      state.threads[params.threadId].turns.push(turn);
      persist();
      reply({ turn });
      notify("turn/started", { threadId: params.threadId, turn });
      record({ event: "prompt", threadId: params.threadId, turnId, prompt, priorItems });
      if (prompt.startsWith("Hold child")) return;
      if (prompt.startsWith("Hold async")) {
        const timer = setInterval(() => {
          if (!fs.existsSync(path.join(home, "async-release"))) return;
          clearInterval(timer);
          finishCodex(params.threadId, turnId, "completed", "Codex child report");
        }, 25);
        return;
      }
      const native = { threadId: params.threadId, turnId };
      const texts = [await answer(prompt, servers.get(params.threadId), native)];
      // Like Codex, the turn answers what was steered into it before it finishes.
      for (let next = steered.get(turnId)?.shift(); next !== undefined; next = steered.get(turnId)?.shift())
        texts.push(await answer(next, servers.get(params.threadId), native));
      finishCodex(params.threadId, turnId, "completed", texts); return;
    }
    case "turn/steer": {
      // A steer joins the active turn as one more user message, as Codex reports it.
      state = load();
      const active = state.threads[params.threadId]?.turns.find((value) => value.id === params.expectedTurnId);
      if (active?.status !== "inProgress") {
        emit({ id, error: { code: -32600, message: "expectedTurnId does not match an active turn" } });
        return;
      }
      const text = params.input?.filter((value) => value.type === "text").map((value) => value.text).join("\n") ?? "";
      record({ event: "steer", threadId: params.threadId, turnId: params.expectedTurnId, text });
      steered.set(params.expectedTurnId, [...(steered.get(params.expectedTurnId) ?? []), text]);
      reply({ turnId: params.expectedTurnId });
      const item = { type: "userMessage", id: randomUUID(), clientId: params.clientUserMessageId ?? null, content: params.input ?? [] };
      notify("item/started", { threadId: params.threadId, turnId: params.expectedTurnId, item, startedAtMs: Date.now() });
      notify("item/completed", { threadId: params.threadId, turnId: params.expectedTurnId, item, completedAtMs: Date.now() });
      return;
    }
    case "turn/interrupt": reply({}); finishCodex(params.threadId, params.turnId, "interrupted"); return;
    case "thread/unsubscribe": {
      state = load();
      if (state.threads[params.threadId]?.ephemeral) {
        delete state.threads[params.threadId];
        servers.delete(params.threadId);
        persist();
        record({ event: "ephemeral.removed", threadId: params.threadId });
      }
      reply({ status: "unsubscribed" }); return;
    }
    // History another Agent produced joins the model-visible thread before the next turn.
    case "thread/inject_items": {
      state = load();
      const thread = state.threads[params.threadId];
      thread.injectedItems = [...(thread.injectedItems ?? []), ...params.items];
      persist();
      record({ event: "inject", threadId: params.threadId, items: params.items }); reply({}); return;
    }
    default: reply({});
  }
}

async function handleClaude(message) {
  if (message.type === "control_response") {
    const waiting = hookRequests.get(message.response.request_id);
    hookRequests.delete(message.response.request_id);
    waiting?.(message.response.response ?? {});
    return;
  }
  if (message.type === "control_request") {
    const request = message.request;
    record({ event: "control", subtype: request.subtype, nativeSessionId });
    const response = request.subtype === "initialize"
      ? { agents: [], commands: [], models: [{ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet", description: "Native fixture", supportsEffort: true, supportedEffortLevels: ["medium"] }], account: { email: "runtime@nodex.invalid", subscriptionType: "pro", tokenSource: "oauth" } }
      : request.subtype === "mcp_set_servers" ? { added: Object.keys(request.servers ?? {}), removed: [], errors: {} }
      : request.subtype === "get_usage" ? { session: {}, subscription_type: "pro", rate_limits_available: false, behaviors: null }
      : {};
    if (request.subtype === "initialize") claudeHooks = request.hooks ?? {};
    if (request.subtype === "mcp_set_servers") claudeServer = request.servers?.nodex_app;
    emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
    if (request.subtype === "interrupt") claudeResult(null, true);
    return;
  }
  if (message.type !== "user") return;
  const prompt = typeof message.message.content === "string" ? message.message.content : message.message.content.filter((value) => value.type === "text").map((value) => value.text).join("\n");
  record({ event: "prompt", prompt, nativeSessionId, resumed: argument("--resume") !== undefined });
  claudeRunning = true;
  emit({ type: "system", subtype: "init", session_id: nativeSessionId, uuid: randomUUID(), cwd: process.cwd(), tools: [], mcp_servers: [], model, permissionMode: "bypassPermissions", slash_commands: [], agents: [], skills: [], plugins: [], apiKeySource: "none", claude_code_version: "2.1.284", output_style: "default", fast_mode_state: "off" });
  if (prompt.startsWith("Hold child")) return;
  if (prompt.startsWith("Hold async")) {
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(home, "async-release"))) return;
      clearInterval(timer);
      void (async () => {
        const target = JSON.parse(fs.readFileSync(path.join(home, "content-target.json"), "utf8"));
        const read = await callTool(claudeServer, "fetch", { id: target.pageId, prepareFor: [{ kind: "title" }] });
        if (read.data?.resource?.title?.markdown !== "Cross Project source") throw new Error("Background child did not read the other Project Page");
        await callTool(claudeServer, "update_page", { pageId: target.pageId, title: { markdown: "Written by background Claude child", ifMatch: read.data.resource.title.etag } });
        record({ event: "content.write", pageId: target.pageId });
        claudeResult("Claude child report");
      })().catch((error) => { record({ event: "error", message: String(error) }); claudeResult(String(error)); });
    }, 25);
    return;
  }
  claudeResult(await answer(prompt, claudeServer));
}

record({ event: "launch", nativeSessionId, resumed: argument("--resume") !== undefined });
const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  const message = JSON.parse(line);
  // Independent requests remain responsive while one parent waits for its delegated child.
  void (kind === "codex" ? handleCodex(message) : handleClaude(message)).catch((cause) => {
    record({ event: "error", message: String(cause) });
    if (kind === "claude") claudeResult(String(cause));
    else if (message.method === "turn/start") finishCodex(message.params.threadId, state.threads[message.params.threadId]?.turns.at(-1)?.id, "failed", String(cause));
  });
}
