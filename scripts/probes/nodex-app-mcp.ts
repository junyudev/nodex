import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as Effect from "effect/Effect";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type { ThreadStartResponse, TurnStartResponse } from "@nodex/codex-app-server-protocol/v2";
import { ScopedCallbackRuntime } from "../../src/main/app/ScopedCallbackRuntime";
import {
  runCodexProbeMain,
  withCodexProbeSession,
  type CodexProbeClient,
} from "../codex-probe-session";
import { ScriptedModelServer, responses } from "../scenarios/runtime/scripted-model-server";

const repository = resolve(".");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const waitFor = (
  client: CodexProbeClient,
  match: (notification: ServerNotification) => boolean,
): { result: Promise<ServerNotification>; dispose: () => void } => {
  let dispose = () => {};
  const result = new Promise<ServerNotification>((accept, reject) => {
    const timer = setTimeout(() => {
      dispose();
      reject(new Error("Timed out waiting for MCP probe notification"));
    }, 30_000);
    const listener = (notification: ServerNotification) => {
      if (!match(notification)) return;
      dispose();
      accept(notification);
    };
    dispose = () => {
      clearTimeout(timer);
      client.off("notification", listener);
    };
    client.on("notification", listener);
  });
  return { result, dispose: () => dispose() };
};

const waitForJournal = async (journal: string, event: string, name: string, attempts = 500) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const records: unknown[] = (await readFile(journal, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (
      records.some((record) => isRecord(record) && record.event === event && record.name === name)
    )
      return true;
    await delay(20);
  }
  return false;
};

const probe = async (callbacks: ScopedCallbackRuntime["Service"]) => {
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 0 || (args.length === 2 && args[0] === "--home"),
    "Usage: probe:app-tools-mcp [--home runs.local/NAME]",
  );
  const parent = resolve(args[1] ?? "runs.local/app-tools-probe");
  assert.ok(parent.startsWith(resolve("runs.local") + sep), "Probe home must be under runs.local");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, "run-"));
  const home = join(root, "codex");
  await mkdir(home, { mode: 0o700 });
  const journal = join(root, "mcp.jsonl");
  const events: ServerNotification[] = [];
  const model = await ScriptedModelServer.start({
    exchanges: ["direct", "code", "cancel"].map((mode) => ({
      name: `native MCP ${mode} call`,
      match: (request) => request.hasUserInputText(`NODEX_${mode}`),
      expectedCalls: mode === "cancel" ? 1 : 2,
      maximumCalls: mode === "cancel" ? 1 : 2,
      respond: (request, index) => {
        if (index === 1) {
          assert.ok(request.hasToolCallOutput("nodex-direct"));

          return responses.stream([
            responses.created("direct-done"),
            responses.assistantMessage("done", "Nodex MCP verified."),
            responses.completed("direct-done"),
          ]);
        }
        if (mode === "direct") {
          const target = request.toolInvocation("mcp__nodex_app", "probe_context");
          assert.ok(target, "Direct MCP tool absent");
          return responses.stream([
            responses.created("direct-call"),
            responses.functionCall("nodex-direct", target.name, {}, target.namespace),
            responses.completed("direct-call"),
          ]);
        }
        const target = request.toolInvocation("functions", "exec");
        assert.ok(target, "Code mode tool absent");
        return responses.stream([
          responses.created("code-call"),
          responses.customToolCall(
            "nodex-direct",
            target.name,
            mode === "cancel"
              ? "text(await tools.mcp__nodex_app__probe_wait({}));"
              : "text(await tools.mcp__nodex_app__probe_context({}));",
            target.namespace,
          ),
          responses.completed("code-call"),
        ]);
      },
    })),
  });
  try {
    await callbacks.runPromise(
      withCodexProbeSession(
        callbacks,
        {
          binaryPath: resolve(".generated/codex-runtime/agent-runtime/bin/codex-app-server"),
          expectedCodexHome: home,
          env: {
            ...process.env,
            ...model.loopbackEnvironment(),
            CODEX_HOME: home,
            NODEX_MCP_PROBE_API_KEY: "isolated-probe",
          },
          clientInfo: { name: "nodex-app-mcp-probe", title: "Nodex App MCP Probe", version: "1" },
          requestTimeout: "30 seconds",
        },
        async (client) => {
          const observe = (notification: ServerNotification) => events.push(notification);
          client.on("notification", observe);
          try {
            for (const mode of ["direct", "code", "cancel"] as const) {
              const firstEvent = events.length;
              const started = await client.request<ThreadStartResponse>("thread/start", {
                cwd: root,
                model: "gpt-5.6-sol",
                modelProvider: "nodex-probe",
                sandbox: "danger-full-access",
                approvalPolicy: "never",
                dynamicTools: [],
                config: {
                  "model_providers.nodex-probe": {
                    ...model.providerConfig("nodex-probe"),
                    env_key: "NODEX_MCP_PROBE_API_KEY",
                  },
                  "features.plugins": false,
                  "features.code_mode": {
                    direct_only_tool_namespaces: mode === "direct" ? ["mcp__nodex_app"] : [],
                  },
                  "features.code_mode_only": false,
                  "mcp_servers.nodex_app": {
                    command: process.execPath,
                    args: [
                      "--import",
                      resolve("node_modules/tsx/dist/loader.mjs"),
                      resolve("scripts/probes/nodex-app-mcp-fixture.ts"),
                    ],
                    cwd: repository,
                    env: { NODEX_MCP_PROBE_JOURNAL: journal },
                    enabled_tools: ["probe_context", "probe_wait"],
                    startup_timeout_sec: 15,
                    tool_timeout_sec: 30,
                  },
                },
              });
              const status = await client.request("mcpServerStatus/list", {
                threadId: started.thread.id,
              });
              assert.ok(
                isRecord(status) &&
                  Array.isArray(status.data) &&
                  status.data.some(
                    (server) =>
                      isRecord(server) &&
                      server.name === "nodex_app" &&
                      server.runtimeStatus === "connected",
                  ),
                "MCP server failed to connect",
              );
              const completed = waitFor(
                client,
                (event) =>
                  event.method === "turn/completed" && event.params.threadId === started.thread.id,
              );
              try {
                const turn = await client.request<TurnStartResponse>("turn/start", {
                  threadId: started.thread.id,
                  input: [{ type: "text", text: `NODEX_${mode}`, text_elements: [] }],
                });
                if (mode === "cancel") {
                  assert.ok(
                    await waitForJournal(journal, "call", "probe_wait"),
                    "MCP wait was not admitted",
                  );
                  await client.request("turn/interrupt", {
                    threadId: started.thread.id,
                    turnId: turn.turn.id,
                  });
                  await completed.result;
                  const forwarded = await waitForJournal(journal, "cancelled", "probe_wait", 100);
                  process.stdout.write(
                    JSON.stringify({
                      server: "nodex_app",
                      turnInterrupt: "pass",
                      mcpCancellationForwarded: forwarded,
                      hostTurnCancellationRequired: !forwarded,
                    }) + "\n",
                  );
                  continue;
                }
                const completion = await completed.result;
                assert.equal(completion.method, "turn/completed");
                if (completion.method === "turn/completed")
                  assert.equal(
                    completion.params.turn.status,
                    "completed",
                    JSON.stringify(completion.params.turn.error) + "\n" + model.transcript(),
                  );
                const calls = events
                  .slice(firstEvent)
                  .filter(
                    (event) =>
                      event.method === "item/completed" && event.params.item.type === "mcpToolCall",
                  );
                assert.equal(
                  calls.length,
                  1,
                  "A native call must produce exactly one MCP item: " +
                    JSON.stringify(events.filter((e) => e.method === "item/completed")),
                );
                const call = calls[0];
                assert.ok(
                  call.method === "item/completed" && call.params.item.type === "mcpToolCall",
                );
                assert.equal(call.params.item.server, "nodex_app");
                assert.equal(call.params.item.status, "completed");
                const records: unknown[] = (await readFile(journal, "utf8"))
                  .trim()
                  .split("\n")
                  .map((line) => JSON.parse(line));
                const record = records.findLast(
                  (entry) => isRecord(entry) && entry.event === "call",
                );
                assert.ok(isRecord(record) && isRecord(record.metadata));
                assert.equal(typeof record.metadata.callId, "string");
                const metadata = record.metadata["x-codex-turn-metadata"];
                assert.ok(isRecord(metadata));
                assert.equal(metadata.thread_id, started.thread.id);
                assert.equal(metadata.turn_id, turn.turn.id);
                assert.equal(
                  call.params.item.id,
                  record.metadata.callId,
                  "MCP request identity must match app-server's authoritative item",
                );
                assert.equal(
                  events.some(
                    (event) =>
                      event.method === "item/completed" &&
                      event.params.item.type === "dynamicToolCall",
                  ),
                  false,
                );
                const report = {
                  server: "nodex_app",
                  item: "mcpToolCall",
                  mode,
                  status: "pass",
                  metadata: "verified",
                  callItemCorrelation: "pass",
                  dynamicTools: 0,
                };
                await writeFile(
                  join(root, `${mode}-report.json`),
                  JSON.stringify(report, null, 2) + "\n",
                );
                process.stdout.write(JSON.stringify(report) + "\n");
              } finally {
                completed.dispose();
              }
            }
          } finally {
            client.off("notification", observe);
          }
        },
      ),
    );
    model.verify();
  } finally {
    await model.close();
  }
};

runCodexProbeMain(
  Effect.gen(function* () {
    const callbacks = yield* ScopedCallbackRuntime;
    yield* Effect.tryPromise(() => probe(callbacks));
  }),
);
