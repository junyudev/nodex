import { createInterface } from "node:readline";

const identity = {
  runtimeId: "fixture-runtime",
  runtimeGeneration: String(process.pid),
  schemaVersion: 1,
  databasePath: "/tmp/fixture.sqlite",
  mcpEndpoint: "http://127.0.0.1:1/mcp",
  lastSequence: 7,
};
const send = (value, onWritten) => process.stdout.write(`${JSON.stringify(value)}\n`, onWritten);
const success = (id, output) => send({ id, success: true, output });
const pendingHosts = new Map();
let executionSubscription;
const blocked = [];
const releasedObservers = [];
process.on("SIGUSR1", () => {
  const id = blocked.shift();
  if (id) success(id, { id: "released", title: "released", workspaceRoot: "/tmp" });
});
const utilityTimers = new Map();
let cancelledUtilities = 0;
let pings = 0;
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const first = await lines.next();
const bootstrap = first.done ? null : JSON.parse(first.value);
// Provider configuration arrives only as the first stdin frame.
if (bootstrap?.type !== "bootstrap") process.exit(3);
// Simulates startup work, such as an imported execution store, finishing before readiness.
const readyDelayMs = Number(process.env.NODEX_FIXTURE_READY_DELAY_MS ?? 0);
if (readyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, readyDelayMs));
send({ type: "ready", identity });

for await (const line of { [Symbol.asyncIterator]: () => lines }) {
  const request = JSON.parse(line);
  if (request.type === "ping") {
    pings++;
    send({ type: "pong" });
    continue;
  }
  if (request.type === "request.cancel") {
    if (utilityTimers.has(request.id)) {
      clearTimeout(utilityTimers.get(request.id));
      utilityTimers.delete(request.id);
      cancelledUtilities++;
      send({ id: request.id, success: false, error: { message: "Cancelled" } });
    }
    continue;
  }
  if (request.type === "host.result") {
    const id = pendingHosts.get(request.id);
    if (id) success(id, request.output);
    pendingHosts.delete(request.id);
    continue;
  }
  if (request.method === "shutdown") {
    send({ id: request.id, success: true, output: { stopped: true } }, () => process.exit(0));
    break;
  }
  if(request.method === "sessions.search"){
    send({id:request.id,success:false,error:{tag:"SessionSearchError",reason:request.input.query,message:"Restart search"}});
    continue;
  }
  if (request.method === "acp.auth.logout") {
    send({ id: request.id, success: false, error: {
      message: "Stop active work first.", tag: "AcpManagementError",
      acp: { reason: "busy", message: "Stop active work first.", affectedThreadIds: ["thread:root"], cause: "must-not-cross-transport" },
    } });
    continue;
  }
  if (request.method === "project.read" && request.input.projectId === "released-observers") {
    success(request.id, { releasedObservers });
    continue;
  }
  if (request.method === "project.read") {
    if (request.input.projectId === "ping-count") {
      success(request.id, { id: "ping-count", title: String(pings), workspaceRoot: "/tmp" });
      continue;
    }
    if (request.input.projectId === "cancelled-utilities") {
      success(request.id, { cancelledUtilities, activeUtilities: utilityTimers.size });
      continue;
    }
    if (request.input.projectId.startsWith("host-wait:")) {
      send({ type: "host.request", id: request.id, operation: "tool.call",
        tool: "wait_sessions", input: { targets: [{sessionId: request.input.projectId}], timeoutMs: 3600000 },
        identity: { runtimeId: identity.runtimeId, runtimeGeneration: identity.runtimeGeneration,
          threadId: "thread", source: "native-session", runId: null, attemptId: null,
          incarnationId: "incarnation", providerSessionId: "acp-session", nativeGeneration: 1 } });
      success(request.id, { hostId: request.id });
      continue;
    }
    if (request.input.projectId.startsWith("host-cancel:") || request.input.projectId.startsWith("host-cancel-wrong:")) {
      const wrong = request.input.projectId.startsWith("host-cancel-wrong:");
      const id = request.input.projectId.slice(wrong ? "host-cancel-wrong:".length : "host-cancel:".length);
      send({ type: "host.cancel", id, runtimeId: identity.runtimeId,
        runtimeGeneration: wrong ? "retired-generation" : identity.runtimeGeneration });
      success(request.id, null);
      continue;
    }
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
    if (request.input.projectId === "exit") process.exit(9);
    if (request.input.projectId === "bootstrap") {
      success(request.id, {
        providers: bootstrap.providers,
        agentsRunningAtOnce: bootstrap.agentsRunningAtOnce,
        pausedThreadIds: bootstrap.pausedThreadIds,
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
    if (request.input.projectId === "held") {
      blocked.push(request.id);
      send({ type: "event", subscriptionId: "held", event: { sequence: 1, event: {} } });
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
  if (request.method === "events.unobserve") {
    releasedObservers.push(request.input.subscriptionId);
    success(request.id, { unsubscribed: true });
    continue;
  }
  if (request.method === "events.observe" && request.input.threadId === "held-observe") {
    send({ type: "event", subscriptionId: request.id, event: { sequence: 1, event: {} } });
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
    // Model work answers inside its own budget.
    const timer = setTimeout(() => {
      utilityTimers.delete(request.id);
      success(request.id, { title: "Generated" });
    }, request.input.timeoutMs - 200);
    utilityTimers.set(request.id, timer);
    continue;
  }
  if (request.method === "thread.snapshot") {
    blocked.push(request.id);
    send({ type: "event", subscriptionId: "held", event: { sequence: 1, event: {} } });
    continue;
  }
  if (request.method === "runtime.identity") success(request.id, identity);
}
