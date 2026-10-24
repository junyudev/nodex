import { createInterface } from "node:readline";

const identity = {
  runtimeId: "fixture-runtime",
  runtimeGeneration: String(process.pid),
  schemaVersion: 1,
  databasePath: "/tmp/fixture.sqlite",
  mcpEndpoint: "http://127.0.0.1:1/mcp",
  lastSequence: 7,
};
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const success = (id, output) => send({ id, success: true, output });
const pendingHosts = new Map();
let executionSubscription;
const blocked = [];
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const first = await lines.next();
const bootstrap = first.done ? null : JSON.parse(first.value);
// Provider configuration arrives only as the first stdin frame.
if (bootstrap?.type !== "bootstrap") process.exit(3);
send({ type: "ready", identity });

for await (const line of { [Symbol.asyncIterator]: () => lines }) {
  const request = JSON.parse(line);
  if (request.type === "host.result") {
    const id = pendingHosts.get(request.id);
    if (id) success(id, request.output);
    pendingHosts.delete(request.id);
    continue;
  }
  if (request.method === "shutdown") {
    success(request.id, { stopped: true });
    process.exitCode = 0;
    break;
  }
  if (request.method === "project.read") {
    if (request.input.projectId === "host-native-session" || request.input.projectId === "invalid-native-prepare") {
      pendingHosts.set(request.id, request.id);
      send({type: "host.request", id: request.id,
        operation: request.input.projectId === "invalid-native-prepare" ? "turn.prepare" : "tool.call",
        tool: "get_session_context", input: {}, identity: {runtimeId: identity.runtimeId,
          runtimeGeneration: identity.runtimeGeneration, threadId: "thread", source: "native-session",
          runId: null, attemptId: null, incarnationId: "incarnation", providerSessionId: "acp-session", nativeGeneration: 1}});
      continue;
    }
    if (request.input.projectId === "activity") {
      send({ type: "activity", rootThreadId: "thread:root", sequence: 12 });
      success(request.id, null);
      continue;
    }
    if (request.input.projectId === "native-session-closed") {
      send({type: "execution.native-session.closed", runtimeId: identity.runtimeId,
        runtimeGeneration: identity.runtimeGeneration, providerSessionId: "acp-session", nativeGeneration: 1, incarnationId: "incarnation"});
      success(request.id, null);
      continue;
    }
    if (request.input.projectId === "host-auth") {
      pendingHosts.set(request.id, request.id);
      send({ type: "host.request", id: request.id, operation: "provider.auth",
        identity: { runtimeId: identity.runtimeId, runtimeGeneration: identity.runtimeGeneration, providerInstanceId: "codex" },
        refresh: true, previousAccountId: "account" });
      continue;
    }
    if (request.input.projectId === "exit") process.exit(9);
    if (request.input.projectId === "bootstrap") {
      success(request.id, {
        providers: bootstrap.providers,
        hostTools: bootstrap.hostTools ?? null,
        environment: process.env,
        execArgv: process.execArgv,
      });
      continue;
    }
    if (request.input.projectId === "reject") {
      send({
        id: request.id,
        success: false,
        error: { message: "Execution is busy", tag: "OrchestratorDispatchError" },
      });
      continue;
    }
    if (request.input.projectId.startsWith("blocked:")) {
      blocked.push(request.id);
      if (blocked.length === 64) send({ type: "event", subscriptionId: "pressure-ready", event: { sequence: 1, event: {} } });
      continue;
    }
    setTimeout(() => success(request.id, {
      id: request.input.projectId,
      title: request.input.projectId,
      workspaceRoot: "/tmp",
    }), request.input.projectId === "first" ? 30 : 1);
    continue;
  }
  if (request.method === "storage.snapshot.release") {
    success(request.id, { released: true });
    for (const id of blocked.splice(0)) success(id, null);
    continue;
  }
  if (request.method === "events.observe") {
    for (let sequence = 1; sequence <= 1_024; sequence += 1) {
      send({ type: "event", subscriptionId: request.id, event: { sequence, event: {} } });
    }
    success(request.id, { subscribed: true, afterSequence: 0 });
    continue;
  }
  if (request.method === "execution.observe") {
    executionSubscription = request.id;
    send({ type: "execution.lifecycle", subscriptionId: executionSubscription,
      runtimeGeneration: identity.runtimeGeneration, sequence: 1, threadId: "thread",
      eventType: "run.updated", runId: "run", runStatus: "running" });
    success(request.id, { subscribed: true, subscriptionId: executionSubscription, afterSequence: 0 });
    continue;
  }
  if (request.method === "thread.read") {
    send({ type: "execution.lifecycle", subscriptionId: executionSubscription,
      runtimeGeneration: identity.runtimeGeneration, sequence: 1_026, threadId: "thread",
      eventType: "run.updated", runId: "run", runStatus: "completed" });
    success(request.id, null);
    continue;
  }
  if (request.method === "command.dispatch") {
    pendingHosts.set(request.id, request.id);
    send({ type: "host.request", id: request.id, operation: "turn.prepare", identity: {
      ...identity, threadId: "thread", runId: "run",
    } });
    continue;
  }
  if (request.method === "thread.import-native") {
    setTimeout(() => success(request.id, { threadId: request.input.threadId }), 500);
    continue;
  }
  if (request.method === "text.generate-structured") {
    // Model work answers well after the transport default but inside its own budget.
    setTimeout(() => success(request.id, { title: "Generated" }), request.input.timeoutMs - 200);
    continue;
  }
  if (request.method === "runtime.identity") success(request.id, identity);
}
