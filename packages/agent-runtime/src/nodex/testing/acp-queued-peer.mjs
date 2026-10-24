import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.ACP_QUEUE_LOG;
const release = process.env.ACP_QUEUE_RELEASE;
let ordinal = 0;
let held;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const finish = (id) => {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "queue-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "QUEUE_OK" } },
    },
  });
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
};
const timer = setInterval(() => {
  if (held === undefined || !existsSync(release)) return;
  finish(held);
  held = undefined;
}, 10);
const lines = createInterface({ input: process.stdin });
lines.on("close", () => clearInterval(timer));
lines.on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  appendFileSync(log, `${JSON.stringify({ method, version: process.env.ACP_QUEUE_VERSION })}\n`);
  const result = (value) => send({ jsonrpc: "2.0", id, result: value });
  switch (method) {
    case "initialize":
      result({
        protocolVersion: 1,
        agentInfo: { name: "queue-peer", version: "1" },
        agentCapabilities: { loadSession: true },
        authMethods: [],
      });
      return;
    case "session/new":
    case "session/load":
      result({
        sessionId: "queue-session",
        configOptions: [
          {
            id: "model",
            type: "select",
            category: "model",
            name: "Model",
            currentValue: "model-a",
            options: [{ value: "model-a", name: "Model A" }],
          },
        ],
      });
      return;
    case "session/prompt":
      ordinal += 1;
      appendFileSync(
        log,
        `${JSON.stringify({ prompt: true, ordinal, version: process.env.ACP_QUEUE_VERSION })}\n`,
      );
      if (ordinal === 1 && !existsSync(release)) held = id;
      else finish(id);
      return;
    default:
      result({});
  }
});
