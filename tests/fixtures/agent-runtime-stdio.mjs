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
send({ type: "ready", identity });

for await (const line of createInterface({ input: process.stdin })) {
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
    if (request.input.projectId === "exit") process.exit(9);
    setTimeout(() => success(request.id, {
      id: request.input.projectId,
      title: request.input.projectId,
      workspaceRoot: "/tmp",
    }), request.input.projectId === "first" ? 30 : 1);
    continue;
  }
  if (request.method === "events.observe") {
    for (let sequence = 1; sequence <= 1_024; sequence += 1) {
      send({ type: "event", subscriptionId: request.id, event: { sequence, event: {} } });
    }
    success(request.id, { subscribed: true, afterSequence: 0 });
    continue;
  }
  if (request.method === "command.dispatch") {
    pendingHosts.set(request.id, request.id);
    send({ type: "host.request", id: request.id, operation: "turn.prepare", identity: {
      ...identity, threadId: "thread", runId: "run",
    } });
    continue;
  }
  if (request.method === "runtime.identity") success(request.id, identity);
}
