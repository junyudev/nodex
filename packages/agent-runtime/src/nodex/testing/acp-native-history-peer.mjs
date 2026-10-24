import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const canLoad = process.env.ACP_HISTORY_CAN_LOAD === "1";
const v2 = process.env.ACP_HISTORY_PROTOCOL === "v2";
const sessionId = "native-history";
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const message = (text, role = "agent") =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: `${role}_message_chunk`, content: { type: "text", text } },
    },
  });
const setup = {
  configOptions: [
    {
      ...(v2 ? { configId: "model" } : { id: "model" }),
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "fixture",
      options: [{ value: "fixture", name: "Fixture" }],
    },
  ],
};
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  appendFileSync(process.env.ACP_HISTORY_LOG, `${method}\n`);
  if (method === "initialize")
    send({
      id,
      result: {
        protocolVersion: v2 ? 2 : 1,
        ...(v2
          ? {
              info: { name: "native-history-fixture", version: "1" },
              capabilities: { session: {} },
            }
          : {
              agentInfo: { name: "native-history-fixture", version: "1" },
              agentCapabilities: {
                loadSession: canLoad,
                sessionCapabilities: { list: {}, resume: {} },
              },
            }),
        authMethods: [],
      },
    });
  else if (method === "session/new") send({ id, result: { sessionId: "probe-session", ...setup } });
  else if (method === "session/list")
    send({
      id,
      result: {
        sessions: [{ sessionId, cwd: process.cwd(), title: "Original chat" }],
      },
    });
  else if (["session/load", "session/resume"].includes(method)) {
    if (params.sessionId !== sessionId) throw new Error("Wrong native session");
    if (method === "session/load" || params.replayFrom) {
      message("Earlier native question", "user");
      message("Earlier native answer");
    }
    send({ id, result: setup });
  } else if (method === "session/prompt") {
    if (params.sessionId !== sessionId) throw new Error("Wrong prompt destination");
    appendFileSync(process.env.ACP_HISTORY_LOG, `prompt:${JSON.stringify(params.prompt)}\n`);
    message("Continued native answer");
    send({ id, result: v2 ? {} : { stopReason: "end_turn" } });
    if (v2)
      send({
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
        },
      });
  } else if (method === "session/set_config_option") send({ id, result: setup });
  else send({ id, result: {} });
}
