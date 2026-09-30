/** Deterministic native stream-json peer. The production SDK owns all transport behavior. */
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.284 (Claude Code)\n");
  process.exit(0);
}

const argument = (name) => {
  const assigned = process.argv.find((value) => value.startsWith(`${name}=`));
  if (assigned) return assigned.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const sessionId = argument("--resume") ?? argument("--session-id");
if (!sessionId) throw new Error("Expected a native session identity");
const cwd = process.cwd();
const directory = join(
  process.env.CLAUDE_CONFIG_DIR,
  "projects",
  cwd.replace(/[^a-zA-Z0-9]/g, "-"),
);
mkdirSync(directory, { recursive: true });
const projectDirectories = join(process.env.CLAUDE_CONFIG_DIR, "projects");
const transcriptPath =
  (argument("--resume") &&
    readdirSync(projectDirectories, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(projectDirectories, entry.name, `${sessionId}.jsonl`))
      .find((candidate) => existsSync(candidate))) ||
  join(directory, `${sessionId}.jsonl`);
const readTranscript = () =>
  existsSync(transcriptPath)
    ? readFileSync(transcriptPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const promptTexts = (entries) =>
  entries
    .filter((entry) => entry.type === "user" && typeof entry.message?.content === "string")
    .map((entry) => entry.message.content);
const retainedTranscript = readTranscript();
let parentUuid =
  retainedTranscript.findLast((entry) => entry.uuid && !entry.isSidechain)?.uuid ?? null;
const resolveModel = (value) =>
  value === "sonnet"
    ? "claude-sonnet-5-5"
    : !value || value === "default" || value === "opus"
      ? "claude-opus-5"
      : value;
const settings = JSON.parse(argument("--settings") ?? "{}");
let model = resolveModel(argument("--model") ?? settings.model);
let effort = argument("--effort") ?? settings.effortLevel ?? "high";
let permissionMode = argument("--permission-mode") ?? "default";
const allowsBypass =
  process.argv.includes("--allow-dangerously-skip-permissions") ||
  process.argv.includes("--dangerously-skip-permissions");
const thinkingEnabled = () =>
  process.env.MAX_THINKING_TOKENS
    ? Number.parseInt(process.env.MAX_THINKING_TOKENS, 10) > 0
    : settings.alwaysThinkingEnabled !== false;
const fastState = () => (model === "claude-opus-5" && settings.fastMode === true ? "on" : "off");
const observe = (event) =>
  appendFileSync(
    join(process.env.CLAUDE_CONFIG_DIR, "observations.jsonl"),
    `${JSON.stringify(event)}\n`,
  );
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
observe({
  type: "launch",
  cwd,
  persistent: !process.argv.includes("--no-session-persistence"),
  sessionId,
  resumed: Boolean(argument("--resume")),
  model,
  effort,
  permissionMode,
  allowsBypass,
  worktreeEnv: process.env.NODEX_E2E_WORKTREE_ENV,
  historyPromptTexts: promptTexts(retainedTranscript),
});
const record = (type, message, fields = {}) => {
  const uuid = randomUUID();
  const entry = {
    type,
    uuid,
    parentUuid,
    sessionId,
    cwd,
    timestamp: new Date().toISOString(),
    message,
    isSidechain: false,
    userType: "external",
    version: "2.1.284",
    ...fields,
  };
  appendFileSync(transcriptPath, `${JSON.stringify(entry)}\n`);
  parentUuid = uuid;
  return uuid;
};
const result = () =>
  send({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    uuid: randomUUID(),
    is_error: false,
    result: "Completed",
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    fast_mode_state: fastState(),
  });
const respond = (request, response = {}) =>
  send({
    type: "control_response",
    response: { subtype: "success", request_id: request.request_id, response },
  });
for await (const line of createInterface({ input: process.stdin })) {
  const incoming = JSON.parse(line);
  if (incoming.type === "control_request") {
    const request = incoming.request;
    if (request.subtype === "initialize") {
      respond(incoming, {
        agents: [],
        account: null,
        commands: [
          { name: "workspace-check", description: "Check the workspace", argumentHint: "" },
        ],
        models: [
          {
            value: "default",
            resolvedModel: "claude-opus-5",
            displayName: "Default",
            description: "Default model",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
            supportsAdaptiveThinking: true,
            supportsFastMode: true,
          },
          {
            value: "sonnet",
            resolvedModel: "claude-sonnet-5-5",
            displayName: "Sonnet",
            description: "Sonnet model",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
            supportsAdaptiveThinking: true,
          },
        ],
        fast_mode_state: fastState(),
      });
      continue;
    }
    if (request.subtype === "get_settings") {
      respond(incoming, {
        effective: { alwaysThinkingEnabled: true, fastMode: false, ...settings },
        sources: [{ source: "flagSettings", settings: { ...settings } }],
        applied: { model, effort, advisor: null, ultracode: false },
      });
      continue;
    }
    if (request.subtype === "set_model") model = resolveModel(request.model);
    if (request.subtype === "set_permission_mode") {
      if (request.mode === "bypassPermissions" && !allowsBypass) {
        send({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: incoming.request_id,
            error: "bypassPermissions requires allowDangerouslySkipPermissions",
          },
        });
        continue;
      }
      permissionMode = request.mode;
      observe({ type: "permission", permissionMode });
      send({
        type: "system",
        subtype: "status",
        status: null,
        permissionMode,
        session_id: sessionId,
        uuid: randomUUID(),
      });
    }
    if (request.subtype === "apply_flag_settings") {
      for (const [key, value] of Object.entries(request.settings)) {
        if (value === null) delete settings[key];
        else settings[key] = value;
      }
      if ("model" in request.settings) model = resolveModel(request.settings.model);
      if ("effortLevel" in request.settings) effort = request.settings.effortLevel ?? "high";
      observe({
        type: "settings",
        model,
        effort,
        thinking: thinkingEnabled(),
        fast: fastState() === "on",
      });
    }
    respond(incoming);
    if (request.subtype === "stop_task") {
      send({
        type: "system",
        subtype: "task_notification",
        session_id: sessionId,
        uuid: randomUUID(),
        task_id: request.task_id,
        status: "stopped",
        summary: "Watcher stopped",
        output_file: "",
      });
      send({
        type: "system",
        subtype: "background_tasks_changed",
        session_id: sessionId,
        uuid: randomUUID(),
        tasks: [],
      });
    }
    if (request.subtype === "interrupt") result();
    continue;
  }
  if (incoming.type === "user") {
    const priorPromptTexts = promptTexts(readTranscript());
    const userUuid = record("user", incoming.message);
    send({
      type: "user",
      session_id: sessionId,
      uuid: userUuid,
      parent_tool_use_id: null,
      message: incoming.message,
    });
    observe({
      type: "prompt",
      sessionId,
      cwd,
      model,
      effort,
      permissionMode,
      thinking: thinkingEnabled(),
      fast: fastState() === "on",
      content: incoming.message.content,
      priorPromptTexts,
      environment: {
        baseUrl: process.env.ANTHROPIC_BASE_URL,
        tokenMatches: process.env.ANTHROPIC_AUTH_TOKEN === "e2e-environment-token",
        apiKeyEmpty: process.env.ANTHROPIC_API_KEY === "",
        worktreeEnv: process.env.NODEX_E2E_WORKTREE_ENV,
      },
    });
    if (
      typeof incoming.message.content === "string" &&
      incoming.message.content.startsWith("Verify handoff ")
    ) {
      const message = {
        id: `handoff-check-${randomUUID()}`,
        role: "assistant",
        model,
        content: [
          { type: "text", text: `Native handoff verified: ${incoming.message.content.slice(15)}` },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      };
      send({
        type: "assistant",
        session_id: sessionId,
        uuid: record("assistant", message),
        parent_tool_use_id: null,
        message,
      });
      result();
      continue;
    }
    if (incoming.message.content === "Wait for cancellation") continue;
    if (incoming.message.content === "Verify thinking disabled") {
      if (permissionMode !== "default") throw new Error("Expected native manual permission mode");
      send({
        type: "control_request",
        request_id: "permission-check",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          tool_use_id: "manual-check",
          input: { command: "pwd" },
        },
      });
      continue;
    }
    if (incoming.message.content === "Verify thinking enabled") {
      if (!thinkingEnabled()) throw new Error("Expected native thinking to be reenabled");
      const message = {
        id: "thinking-check",
        role: "assistant",
        model,
        content: [
          { type: "thinking", thinking: "Thinking is enabled again" },
          { type: "text", text: "Native thinking enabled" },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      };
      send({
        type: "assistant",
        session_id: sessionId,
        uuid: record("assistant", message),
        parent_tool_use_id: null,
        message,
      });
      result();
      continue;
    }
    if (incoming.message.content === "Simulate failure") {
      send({
        type: "result",
        subtype: "error_max_turns",
        session_id: sessionId,
        uuid: randomUUID(),
        is_error: true,
        errors: ["Maximum turns reached"],
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
      });
      continue;
    }
    if (incoming.message.content === "/compact") {
      send({
        type: "system",
        subtype: "compact_boundary",
        session_id: sessionId,
        uuid: randomUUID(),
        compact_metadata: { trigger: "manual", pre_tokens: 1000, post_tokens: 25 },
      });
      result();
      continue;
    }
    if (
      Array.isArray(incoming.message.content) &&
      incoming.message.content.some((part) => part.type === "image")
    ) {
      const message = {
        id: `image-answer-${randomUUID()}`,
        role: "assistant",
        model,
        content: [{ type: "text", text: "Native image inspected" }],
        usage: { input_tokens: 20, output_tokens: 5 },
      };
      send({
        type: "assistant",
        session_id: sessionId,
        uuid: record("assistant", message),
        parent_tool_use_id: null,
        message,
      });
      result();
      continue;
    }

    send({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      uuid: randomUUID(),
      model,
      effort,
      permissionMode,
      fast_mode_state: fastState(),
    });
    send({
      type: "control_request",
      request_id: "question",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: "question-tool",
        input: {
          questions: [
            {
              question: "Which target?",
              header: "Target",
              multiSelect: false,
              options: [
                { label: "Desktop", description: "Use the desktop workspace" },
                { label: "CLI", description: "Use the command line" },
              ],
            },
          ],
        },
      },
    });
    continue;
  }
  if (incoming.type !== "control_response") continue;
  if (incoming.response.request_id === "permission-check") {
    if (incoming.response.response?.behavior !== "allow")
      throw new Error("Expected explicit approval");
    const message = {
      id: "manual-check-complete",
      role: "assistant",
      model,
      content: [{ type: "text", text: "Native thinking disabled" }],
      usage: { input_tokens: 12, output_tokens: 4 },
    };
    send({
      type: "assistant",
      session_id: sessionId,
      uuid: record("assistant", message),
      parent_tool_use_id: null,
      message,
    });
    result();
    continue;
  }
  if (incoming.response.request_id === "question") {
    const answer = incoming.response.response?.updatedInput?.answers?.["Which target?"];
    if (answer !== "Desktop") throw new Error("Expected the user's Desktop answer");
    if (permissionMode !== "bypassPermissions")
      send({
        type: "control_request",
        request_id: "approval",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          tool_use_id: "approval-tool",
          input: { command: "pwd" },
        },
      });
    if (permissionMode !== "bypassPermissions") continue;
  }
  if (incoming.response.request_id !== "approval" && incoming.response.request_id !== "question")
    continue;
  if (
    incoming.response.request_id === "approval" &&
    incoming.response.response?.behavior !== "allow"
  )
    throw new Error("Expected an explicit tool approval");
  const emitAssistant = (id, content, parent = null) => {
    const message = {
      id,
      role: "assistant",
      content: [content],
      model,
      usage: { input_tokens: 12, output_tokens: 4 },
    };
    const uuid = record(
      "assistant",
      message,
      parent ? { parent_tool_use_id: parent, isSidechain: true } : {},
    );
    send({ type: "assistant", session_id: sessionId, uuid, parent_tool_use_id: parent, message });
  };
  emitAssistant("assistant-final", {
    type: "thinking",
    thinking: "Inspecting workspace carefully",
  });
  emitAssistant("assistant-final", {
    type: "tool_use",
    id: "bash-workspace",
    name: "Bash",
    input: { command: "pwd" },
  });
  const toolMessage = {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "bash-workspace",
        content: [{ type: "text", text: "Workspace inspected" }],
      },
    ],
  };
  send({
    type: "user",
    session_id: sessionId,
    uuid: record("user", toolMessage),
    parent_tool_use_id: null,
    message: toolMessage,
    tool_use_result: { stdout: "Workspace inspected", stderr: "", exitCode: 0, interrupted: false },
  });
  emitAssistant("assistant-final", { type: "text", text: "Native Claude workflow complete" });
  emitAssistant("assistant-spawn", {
    type: "tool_use",
    id: "spawn-1",
    name: "Agent",
    input: { description: "Inspect workspace" },
  });
  send({
    type: "system",
    subtype: "task_started",
    session_id: sessionId,
    uuid: randomUUID(),
    task_id: "subtask-1",
    tool_use_id: "spawn-1",
    description: "Inspect workspace",
    task_type: "local_agent",
  });
  emitAssistant("child-answer", { type: "text", text: "Native child workspace report" }, "spawn-1");
  send({
    type: "system",
    subtype: "task_notification",
    session_id: sessionId,
    uuid: randomUUID(),
    task_id: "subtask-1",
    tool_use_id: "spawn-1",
    status: "completed",
    summary: "Workspace inspected",
    output_file: "",
  });
  send({
    type: "system",
    subtype: "task_started",
    session_id: sessionId,
    uuid: randomUUID(),
    task_id: "watch-build",
    description: "Watch build",
    task_type: "local_bash",
    is_backgrounded: true,
    ambient: true,
    skip_transcript: true,
  });
  send({
    type: "system",
    subtype: "background_tasks_changed",
    session_id: sessionId,
    uuid: randomUUID(),
    tasks: [
      {
        task_id: "watch-build",
        description: "Watch build",
        status: "running",
        ambient: true,
        skip_transcript: true,
      },
    ],
  });
  result();
}
