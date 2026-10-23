/** Deterministic native HTTP/SSE peer; the production SDK owns its actual wire transport. */
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

if (process.argv.includes("--version")) {
  process.stdout.write("1.15.13\n");
  process.exit(0);
}
const root = join(process.env.XDG_DATA_HOME, "opencode");
mkdirSync(root, { recursive: true });
const statePath = join(root, "sessions.json");
const observationsPath = join(root, "observations.jsonl");
const state = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {});
const save = (sessions) => writeFileSync(statePath, JSON.stringify(sessions));
const observe = (value) => appendFileSync(observationsPath, `${JSON.stringify(value)}\n`);
const streams = new Set();
const pending = new Map();
const emit = (event) => {
  event = { id: `evt_${randomUUID().replaceAll("-", "")}`, ...event };
  for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`);
};
const json = (response, value, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
};
const model = {
  id: "kimi-k3",
  providerID: "moonshot",
  name: "Kimi K3",
  family: "kimi",
  release_date: "2026-09-01",
  status: "active",
  api: { id: "kimi-k3", url: "https://api.example.invalid", npm: "@ai-sdk/openai-compatible" },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1_000_000, output: 16_384 },
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, image: true, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  options: {},
  headers: {},
  variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
};
const providers = {
  all: [
    {
      id: "moonshot",
      name: "Moonshot",
      source: "env",
      env: ["MOONSHOT_API_KEY"],
      options: {},
      models: { "kimi-k3": model },
    },
  ],
  default: { moonshot: "kimi-k3" },
  connected: ["moonshot"],
};
const agents = ["build", "plan"].map((name) => ({
  name,
  description: name === "plan" ? "Plan changes" : "Make changes",
  mode: "primary",
  options: {},
  permission: [],
}));
const createSession = (sessions, permission = [], messages = [], directory = process.cwd()) => {
  const id = `ses_${randomUUID().replaceAll("-", "")}`;
  const session = {
    id,
    slug: "scripted-opencode",
    projectID: "scripted-project",
    directory,
    title: "Scripted OpenCode",
    version: "1.15.13",
    permission,
    time: { created: Date.now(), updated: Date.now() },
  };
  sessions[id] = { session, messages };
  observe({ kind: "createSession", sessionId: id, cwd: directory });
  save(sessions);
  return session;
};
const finish = (id, input) => {
  const sessions = state();
  const stored = sessions[id];
  if (!stored) return;
  const text = input.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const assistantID = `msg_${randomUUID().replaceAll("-", "")}`;
  const user = {
    id: input.messageID,
    sessionID: id,
    role: "user",
    time: { created: Date.now() },
    model: input.model,
    agent: input.agent ?? "build",
    variant: input.variant,
  };
  const assistant = {
    id: assistantID,
    sessionID: id,
    role: "assistant",
    parentID: input.messageID,
    time: { created: Date.now(), completed: Date.now() },
    providerID: input.model.providerID,
    modelID: input.model.modelID,
    mode: input.agent ?? "build",
    agent: input.agent ?? "build",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 12, output: 4, reasoning: 1, cache: { read: 0, write: 0 } },
    finish: "stop",
  };
  const answer = text.includes("OPEN_CODE_OK") ? "OPEN_CODE_OK" : "Scripted OpenCode completed.";
  const part = {
    id: `prt_${randomUUID().replaceAll("-", "")}`,
    sessionID: id,
    messageID: assistantID,
    type: "text",
    text: answer,
    time: { start: Date.now(), end: Date.now() },
  };
  stored.messages.push(
    {
      info: user,
      parts: input.parts.map((item, index) => ({
        ...item,
        id: `prt_user_${index}`,
        sessionID: id,
        messageID: input.messageID,
      })),
    },
    { info: assistant, parts: [part] },
  );
  save(sessions);
  emit({ type: "message.updated", properties: { info: user } });
  emit({ type: "message.updated", properties: { info: assistant } });
  emit({ type: "message.part.updated", properties: { part } });
  emit({ type: "session.status", properties: { sessionID: id, status: { type: "idle" } } });
};
const server = createServer(async (request, response) => {
  const auth = process.env.OPENCODE_SERVER_PASSWORD;
  if (
    auth &&
    request.headers.authorization !== `Basic ${Buffer.from(`opencode:${auth}`).toString("base64")}`
  ) {
    json(response, { message: "Unauthorized" }, 401);
    return;
  }
  const url = new URL(request.url, "http://127.0.0.1");
  const route = url.pathname;
  // Like the real server, one server process serves every directory a request names.
  const header = request.headers["x-opencode-directory"];
  const directory =
    url.searchParams.get("directory") ??
    (typeof header === "string" ? decodeURIComponent(header) : process.cwd());
  if (route === "/global/health") return json(response, { healthy: true, version: "1.15.13" });
  if (route === "/event") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    streams.add(response);
    response.write(
      `data: ${JSON.stringify({ id: `evt_${randomUUID().replaceAll("-", "")}`, type: "server.connected", properties: {} })}\n\n`,
    );
    request.on("close", () => streams.delete(response));
    return;
  }
  if (route === "/provider") return json(response, providers);
  if (route === "/agent") return json(response, agents);
  if (route === "/command" || route === "/skill") return json(response, []);
  if (route === "/config")
    return json(response, { model: "moonshot/kimi-k3", default_agent: "build" });
  if (route === "/permission" || route === "/question") return json(response, []);
  if (route === "/session/status") return json(response, {});
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  const sessions = state();
  if (route === "/session" && request.method === "POST")
    return json(response, createSession(sessions, body.permission, [], directory));
  // Like the real server, an added MCP server reports its connection status by name.
  if (route === "/mcp" && request.method === "POST") {
    observe({ kind: "addMcp", name: body.name, directory });
    return json(response, { [body.name]: { status: "connected" } });
  }
  const segments = route.split("/").filter(Boolean);
  if (segments[0] === "permission" && segments[2] === "reply") {
    const turn = pending.get(segments[1]);
    pending.delete(segments[1]);
    json(response, true);
    if (turn && body.reply === "once") setTimeout(() => finish(turn.id, turn.input), 20);
    return;
  }
  const id = segments[1];
  const stored = sessions[id];
  if (segments[0] !== "session" || !stored)
    return json(
      response,
      { name: "NotFoundError", data: { message: "Native session not found" } },
      404,
    );
  if (segments.length === 2 && request.method === "GET") return json(response, stored.session);
  if (segments.length === 2 && request.method === "PATCH") {
    stored.session = { ...stored.session, ...body };
    save(sessions);
    return json(response, stored.session);
  }
  if (segments[2] === "children") return json(response, []);
  if (segments[2] === "message") {
    if (segments[3]) {
      const message = stored.messages.find((entry) => entry.info.id === segments[3]);
      return message
        ? json(response, message)
        : json(response, { message: "Message not found" }, 404);
    }
    const before = url.searchParams.get("before");
    const end = before
      ? stored.messages.findIndex((entry) => entry.info.id === before)
      : stored.messages.length;
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const start = Math.max(0, end - limit);
    if (start > 0)
      response.setHeader(
        "X-Next-Cursor",
        Buffer.from(JSON.stringify({ end: start })).toString("base64url"),
      );
    return json(response, stored.messages.slice(start, end));
  }
  if (segments[2] === "prompt_async") {
    observe({
      kind: "prompt",
      sessionId: id,
      cwd: stored.session.directory,
      model: body.model,
      variant: body.variant,
      agent: body.agent,
      priorPromptTexts: stored.messages
        .filter((entry) => entry.info.role === "user")
        .map((entry) =>
          entry.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        ),
      text: body.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    });
    response.writeHead(204);
    response.end();
    emit({ type: "session.status", properties: { sessionID: id, status: { type: "busy" } } });
    const text = body.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text.includes("WAIT_FOR_CANCEL")) return;
    if (text.includes("APPROVE")) {
      const requestId = `per_${randomUUID().replaceAll("-", "")}`;
      pending.set(requestId, { id, input: body });
      emit({
        type: "permission.asked",
        properties: {
          id: requestId,
          sessionID: id,
          permission: "bash",
          patterns: ["echo OPEN_CODE_OK"],
          always: [],
          metadata: {},
        },
      });
      return;
    }
    setTimeout(() => finish(id, body), 40);
    return;
  }
  if (segments[2] === "abort") {
    observe({ kind: "abort", sessionId: id });
    json(response, true);
    emit({ type: "session.idle", properties: { sessionID: id } });
    return;
  }
  if (segments[2] === "fork") {
    const at = body.messageID
      ? stored.messages.findIndex((entry) => entry.info.id === body.messageID)
      : stored.messages.length - 1;
    return json(
      response,
      createSession(
        sessions,
        stored.session.permission,
        stored.messages.slice(0, at + 1),
        stored.session.directory,
      ),
    );
  }
  if (segments[2] === "summarize") return json(response, true);
  return json(response, { message: `Unsupported scripted route ${request.method} ${route}` }, 404);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`opencode server listening on http://127.0.0.1:${address.port}\n`);
});
process.on("SIGTERM", () => {
  for (const response of streams) response.end();
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
