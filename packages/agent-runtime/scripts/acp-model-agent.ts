#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import { createInterface } from "node:readline";

// A real stdio peer for model negotiation. v1 and v2 intentionally advertise
// different wire shapes so the numeric version cannot select the wrong codec.
const api = process.env.NODEX_ACP_MODEL_API ?? "config";
const protocol = process.env.NODEX_ACP_MODEL_PROTOCOL ?? "v1";
const modelIds = ["default", "auto", "model-a", "model-b"];
let model = "model-a";
let option = "nonempty";

const configOptions = () =>
  api === "legacy" || api === "none"
    ? []
    : [
        {
          ...(protocol === "v2" ? { configId: "model" } : { id: "model" }),
          name: "Model",
          type: "select",
          category: "model",
          currentValue: model,
          options: modelIds.map((value) => ({ value, name: value })),
        },
        {
          ...(protocol === "v2" ? { configId: "context" } : { id: "context" }),
          name: "Context",
          type: "select",
          currentValue: option,
          options: [
            { value: "", name: "Empty" },
            { value: "nonempty", name: "Nonempty" },
            { value: " nonempty ", name: "Padded" },
          ],
        },
      ];

const setup = () => ({
  sessionId: "model-session",
  configOptions: configOptions(),
  ...(api === "legacy" || api === "both"
    ? {
        models: {
          currentModelId: model,
          availableModels: modelIds.map((modelId) => ({ modelId, name: modelId })),
        },
      }
    : {}),
});

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line) as {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (request.id === undefined) return;
  const result = (value: unknown) => send({ jsonrpc: "2.0", id: request.id, result: value });
  const invalid = () =>
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "model rejected" } });
  switch (request.method) {
    case "initialize":
      result({
        protocolVersion: protocol === "v1" ? 1 : 2,
        ...(protocol === "v2"
          ? { capabilities: {}, info: { name: "model-peer", version: "1.0.0" } }
          : {
              agentCapabilities: { loadSession: true },
              agentInfo: { name: "model-peer", version: "1.0.0" },
            }),
        authMethods: [],
      });
      return;
    case "authenticate":
    case "auth/login":
    case "session/close":
    case "session/delete":
      result({});
      return;
    case "session/new":
    case "session/load":
    case "session/resume":
      result(setup());
      return;
    case "session/set_model":
      if (api !== "legacy" && api !== "both") return invalid();
      if (request.params?.modelId === "rejected") return invalid();
      model = String(request.params?.modelId);
      result({});
      return;
    case "session/set_config_option": {
      if (api === "legacy" || api === "none") return invalid();
      const configId = request.params?.configId;
      const value = request.params?.value;
      if (value === "rejected") return invalid();
      if (configId === "model") model = String(value);
      if (configId === "context") option = String(value);
      result({ configOptions: configOptions() });
      return;
    }
    case "session/prompt":
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "model-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: JSON.stringify({ model, option }) },
          },
        },
      });
      result(protocol === "v2" ? {} : { stopReason: "end_turn" });
      if (protocol === "v2") {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "model-session",
            update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
          },
        });
      }
      return;
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "unsupported method" },
      });
  }
});
