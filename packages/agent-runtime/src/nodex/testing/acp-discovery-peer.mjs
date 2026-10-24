import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id === undefined) continue;
  appendFileSync(process.env.ACP_DISCOVERY_LOG, `${method}\n`);
  const state = JSON.parse(readFileSync(process.env.ACP_DISCOVERY_STATE, "utf8"));
  if (method === "initialize")
    send({
      id,
      result: {
        protocolVersion: 2,
        info: { name: "discovery-fixture", version: "1" },
        capabilities: { session: { list: {}, load: {}, resume: {}, delete: {} }, providers: {} },
        authMethods: [
          {
            methodId: "key",
            name: "API key",
            type: "env_var",
            vars: [{ name: "MODEL_TOKEN" }],
            link: "https://example.test/keys",
          },
        ],
      },
    });
  else if (method === "session/new" && state.fail)
    send({
      id,
      error: { code: -32000, message: `Authentication required ${process.env.MODEL_TOKEN}` },
    });
  else if (method === "session/new")
    send({
      id,
      result: {
        sessionId: "discovery-session",
        ...(state.noModelApi
          ? {}
          : {
              configOptions: [
                {
                  configId: "model",
                  name: "Model",
                  type: "select",
                  category: "model",
                  currentValue: "first",
                  options: (state.models ?? ["first", "second"]).map((value) => ({
                    value,
                    name: state.echoSecret ? process.env.MODEL_TOKEN : value,
                  })),
                },
              ],
            }),
      },
    });
  else if (["session/delete", "session/close"].includes(method)) send({ id, result: {} });
  else send({ id, error: { code: -32601, message: "Unsupported method" } });
}
