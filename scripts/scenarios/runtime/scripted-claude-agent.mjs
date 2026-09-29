/** Deterministic native stream-json peer. The production SDK owns all transport behavior. */
import { createInterface } from "node:readline";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
let parentUuid = null;
let model = argument("--model") ?? "claude-opus-5";
let effort = argument("--effort") ?? null;
const observe = (event) =>
  appendFileSync(
    join(process.env.CLAUDE_CONFIG_DIR, "observations.jsonl"),
    `${JSON.stringify(event)}\n`,
  );
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const record = (type, message) => {
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
    version: "2.1.283",
  };
  appendFileSync(join(directory, `${sessionId}.jsonl`), `${JSON.stringify(entry)}\n`);
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
          },
          {
            value: "sonnet",
            resolvedModel: "claude-sonnet-5",
            displayName: "Sonnet",
            description: "Sonnet model",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
          },
        ],
      });
      continue;
    }
    if (request.subtype === "set_model") model = request.model;
    if (request.subtype === "apply_flag_settings") {
      if ("model" in request.settings) model = request.settings.model ?? "claude-opus-5";
      if ("effortLevel" in request.settings) effort = request.settings.effortLevel;
      observe({ type: "settings", model, effort });
    }
    respond(incoming);
    if (request.subtype === "interrupt") result();
    continue;
  }
  if (incoming.type === "user") {
    record("user", incoming.message);
    observe({
      type: "prompt",
      model,
      effort,
      content: incoming.message.content,
      environment: {
        baseUrl: process.env.ANTHROPIC_BASE_URL,
        tokenMatches: process.env.ANTHROPIC_AUTH_TOKEN === "e2e-environment-token",
        apiKeyEmpty: process.env.ANTHROPIC_API_KEY === "",
      },
    });
    if (incoming.message.content === "Wait for cancellation") continue;
    send({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      uuid: randomUUID(),
      model,
      effort,
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
  if (incoming.response.request_id === "question") {
    const answer = incoming.response.response?.updatedInput?.answers?.["Which target?"];
    if (answer !== "Desktop") throw new Error("Expected the user's Desktop answer");
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
    continue;
  }
  if (incoming.response.request_id !== "approval") continue;
  if (incoming.response.response?.behavior !== "allow")
    throw new Error("Expected an explicit tool approval");
  const message = {
    id: "assistant-final",
    role: "assistant",
    content: [{ type: "text", text: "Native Claude workflow complete" }],
    model,
    usage: { input_tokens: 12, output_tokens: 4 },
  };
  const uuid = record("assistant", message);
  send({ type: "assistant", session_id: sessionId, uuid, parent_tool_use_id: null, message });
  send({
    type: "system",
    subtype: "task_started",
    session_id: sessionId,
    uuid: randomUUID(),
    task_id: "subtask-1",
    description: "Inspect workspace",
  });
  send({
    type: "system",
    subtype: "task_notification",
    session_id: sessionId,
    uuid: randomUUID(),
    task_id: "subtask-1",
    status: "completed",
    summary: "Workspace inspected",
    output_file: "",
  });
  result();
}
