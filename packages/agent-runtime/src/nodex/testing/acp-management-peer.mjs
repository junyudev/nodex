import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const log = process.env.ACP_MANAGEMENT_LOG;
const stateFile = process.env.ACP_MANAGEMENT_STATE;
const write = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const { id, method, params } = request;
  appendFileSync(
    log,
    JSON.stringify({
      method,
      sessionId: params?.sessionId,
      providerId: params?.providerId,
      apiType: params?.apiType,
    }) + "\n",
  );
  if (method === "initialize")
    write(id, {
      protocolVersion: 2,
      info: { name: "management-fixture", version: "1" },
      capabilities: { session: { delete: {} }, providers: {}, auth: { logout: {} } },
      authMethods: [
        { methodId: "login", name: "Sign in", type: "agent" },
        {
          methodId: "env",
          name: "API key",
          type: "env_var",
          vars: [{ name: "MODEL_TOKEN" }],
          link: "https://example.test/keys",
        },
      ],
    });
  else if (method === "auth/login") {
    if (process.env.ACP_MANAGEMENT_AUTH_SUCCESS === "1") write(id, {});
  } else if (method === "session/new")
    write(id, {
      sessionId: "probe-session",
      configOptions: [
        {
          configId: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: "fixture",
          options: [{ value: "fixture", name: "Fixture" }],
        },
      ],
    });
  else if (method === "session/list")
    write(id, {
      sessions: [
        {
          sessionId: params?.cursor ? "native-b" : "native-a",
          cwd: process.cwd(),
          title: params?.cursor ? "Second chat" : "Original chat",
        },
      ],
      ...(params?.cursor ? {} : { nextCursor: "page-two" }),
    });
  else if (method === "providers/list")
    write(id, {
      providers: [
        { providerId: "required", supported: ["openai"], required: true, current: null },
        {
          providerId: "optional",
          supported: ["openai", "anthropic"],
          required: false,
          current: existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null,
        },
      ],
    });
  else if (method === "providers/set") {
    writeFileSync(stateFile, JSON.stringify({ apiType: params.apiType, baseUrl: params.baseUrl }));
    write(id, {});
  } else if (method === "providers/disable") {
    writeFileSync(stateFile, "null");
    write(id, {});
  } else if (["session/close", "session/delete", "auth/logout"].includes(method)) write(id, {});
  else
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unsupported ${method}` },
      }) + "\n",
    );
}
