import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "./Interface.ts";

const call = <M extends AgentRuntimeMethod>(method: M, input: AgentRuntimeOperations[M]["input"]) =>
  AgentRuntime.use((runtime) => runtime.handle({ id: method, method, input })).pipe(
    Effect.map((output) => output as AgentRuntimeOperations[M]["output"]),
  );

const connectAcpInstance = Effect.fnUntraced(function* (home: string, instanceId: string) {
  yield* call("acp.connection.start", { instanceId, cwd: home, operationId: "connect" });
  const connected = yield* call("acp.operation.read", { operationId: "connect" }).pipe(
    Effect.repeat({
      until: (value) => value.phase !== "running",
      schedule: Schedule.spaced("20 millis"),
    }),
    Effect.timeout("10 seconds"),
  );
  expect(connected.phase).toBe("succeeded");
});

const startThread = Effect.fnUntraced(function* (
  home: string,
  instanceId: string,
  title: string,
  text: string,
  model = "fixture",
) {
  yield* call("project.upsert", { id: "project", title, workspaceRoot: home });
  yield* call("command.dispatch", {
    command: {
      type: "thread.create",
      commandId: "create",
      threadId: "thread",
      projectId: "project",
      title,
      modelSelection: { instanceId, model },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: home,
      createdBy: "user",
      creationSource: "web",
    },
  });
  yield* call("command.dispatch", {
    command: {
      type: "message.dispatch",
      commandId: "send",
      threadId: "thread",
      messageId: "message",
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "start_immediately" },
    },
  });
});

it.live.each(["v1", "v2"])(
  "buffers a partial %s paragraph and publishes it before the native prompt settles",
  (protocol) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-streaming-" });
      const log = `${home}/requests.log`;
      const paragraphRelease = `${home}/release-paragraph`;
      const assistantText = "Continued native answer\n\n";
      yield* fs.writeFileString(log, "");
      const instanceId = "streaming";
      yield* Effect.gen(function* () {
        yield* connectAcpInstance(home, instanceId);
        yield* startThread(home, instanceId, "Streaming", "Start the response, then wait");
        yield* fs.readFileString(log).pipe(
          Effect.repeat({
            until: (value) => value.includes("prompt-held:"),
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        const partial = yield* call("thread.snapshot", { threadId: "thread" });
        expect(partial.projection.runs[0]?.status).toBe("running");
        expect(partial.projection.messages.some((message) => message.role === "assistant")).toBe(
          false,
        );
        expect(
          partial.projection.visibleTurnItems.some((row) => row.item.type === "assistant_message"),
        ).toBe(false);
        yield* fs.writeFileString(paragraphRelease, "release");
        // The peer now finishes the paragraph, but never sends the prompt result
        // or terminal state. This proves live ingestion rather than completion hydration.
        const live = yield* call("thread.snapshot", { threadId: "thread" }).pipe(
          Effect.repeat({
            until: (value) =>
              value.projection.messages.some(
                (message) => message.role === "assistant" && message.text === assistantText,
              ),
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        const run = live.projection.runs.find((run) => run.userMessageId === "message")!;
        expect(run).toMatchObject({ status: "running", completedAt: null });
        const message = live.projection.messages.find((message) => message.role === "assistant")!;
        expect(message).toMatchObject({
          runId: run.id,
          text: assistantText,
          streaming: true,
        });
        const item = live.projection.visibleTurnItems
          .map((row) => row.item)
          .find((item) => item.type === "assistant_message" && item.messageId === message.id);
        expect(item).toMatchObject({
          type: "assistant_message",
          runId: run.id,
          status: "running",
          streaming: true,
          text: assistantText,
          providerThreadId: run.providerThreadId,
        });
        const held = (yield* fs.readFileString(log))
          .split("\n")
          .find((line) => line.startsWith("paragraph-sent:"));
        expect(held).toBeDefined();
        const observedDelayMs = Date.now() - Number(held!.slice("paragraph-sent:".length));
        yield* Effect.logInfo("ACP pre-cancel streaming verified", {
          protocol,
          runStatus: run.status,
          messageRunIdMatches: message.runId === run.id,
          transcriptItemPresent: item !== undefined,
          streaming: message.streaming,
          observedDelayMs,
        });
        yield* call("command.dispatch", {
          command: {
            type: "run.interrupt",
            commandId: "stop",
            threadId: "thread",
            runId: run.id,
            holdQueue: true,
          },
        });
        const stopped = yield* call("run.outcome", {
          threadId: "thread",
          messageId: "message",
        }).pipe(
          Effect.repeat({
            until: (value) => value?.status === "interrupted",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        expect(stopped?.status).toBe("interrupted");
      }).pipe(
        Effect.provide(
          Application.layer(
            {
              home,
              cwd: home,
              providers: {
                [instanceId]: {
                  driver: "acpRegistry",
                  config: {
                    source: "local",
                    discovery: "explicit",
                    commandPath: process.execPath,
                    commandArgs: [
                      fileURLToPath(
                        new URL("./testing/acp-native-history-peer.mjs", import.meta.url),
                      ),
                    ],
                  },
                  environment: [
                    { name: "ACP_HISTORY_PROTOCOL", value: protocol, sensitive: false },
                    { name: "ACP_HISTORY_LOG", value: log, sensitive: false },
                    { name: "ACP_HISTORY_HOLD_PROMPT", value: "1", sensitive: false },
                    {
                      name: "ACP_HISTORY_PARAGRAPH_RELEASE",
                      value: paragraphRelease,
                      sensitive: false,
                    },
                  ],
                },
              },
            },
            () => Effect.void,
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

const fakeAntigravity = Effect.fnUntraced(function* (
  home: string,
  environment: Readonly<Record<string, string>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const executable = `${home}/agy`;
  const peer = fileURLToPath(new URL("../../scripts/acp-mock-agent.ts", import.meta.url));
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  yield* fs.writeFileString(
    executable,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  printf "agy %s\\n" "$NODEX_ACP_AGENT_VERSION"',
      "  exit 0",
      "fi",
      `exec ${quote(process.execPath)} ${quote(peer)} "$@"`,
      "",
    ].join("\n"),
  );
  yield* fs.chmod(executable, 0o755);
  return {
    driver: "antigravity" as const,
    enabled: true,
    config: { binaryPath: executable, authMethod: "gemini-api-key", apiKey: "fixture-key" },
    environment: Object.entries({
      HOME: home,
      NODEX_ACP_ANTIGRAVITY: "1",
      NODEX_ACP_AGENT_VERSION: "1.5.13",
      ...environment,
    }).map(([name, value]) => ({ name, value, sensitive: false })),
  };
});

it.live.skipIf(process.platform === "win32")(
  "projects Antigravity's shell and namespaced MCP calls through its built-in driver",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-antigravity-" });
      const instanceId = "antigravity";
      const provider = yield* fakeAntigravity(home, { NODEX_ACP_EMIT_TOOL_CALLS: "1" });
      yield* Effect.gen(function* () {
        yield* call("providers.models.refresh", { instanceId });
        yield* startThread(
          home,
          instanceId,
          "Antigravity tools",
          "Run the shell and MCP tools",
          "gemini-test-low",
        );
        const outcome = yield* call("run.outcome", {
          threadId: "thread",
          messageId: "message",
        }).pipe(
          Effect.repeat({
            until: (value) => value?.status === "completed" || value?.status === "failed",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        expect(outcome?.status).toBe("completed");
        const snapshot = yield* call("thread.snapshot", { threadId: "thread" });
        const readItem = (nativeId: string) => {
          const row = snapshot.projection.visibleTurnItems.find(
            ({ item }) => item.nativeItemRef?.nativeId === nativeId,
          );
          expect(row, nativeId).toBeDefined();
          return call("thread.item.full", { threadId: "thread", itemId: row!.item.id });
        };
        expect(yield* readItem("antigravity-shell")).toMatchObject({
          type: "command_execution",
          status: "completed",
          input: "ls -a",
          output: ".\t..\r\n",
          exitCode: 0,
        });
        expect(yield* readItem("antigravity-shell-without-preamble")).toMatchObject({
          type: "command_execution",
          status: "failed",
          input: "cat missing.txt",
          output: "  missing.txt: No such file\r\n",
          exitCode: 1,
        });
        const projects = yield* readItem("antigravity-list-projects");
        expect(projects).toMatchObject({
          type: "dynamic_tool",
          status: "completed",
          title: null,
          toolName: "nodex_app.list_projects",
        });
        expect(projects).toHaveProperty("input", {});
        const desktop = yield* readItem("antigravity-desktop");
        expect(desktop).toMatchObject({
          type: "dynamic_tool",
          status: "completed",
          toolName: "node_repl.js",
        });
        expect(desktop).toHaveProperty("input", { code: "console.log(42)" });
      }).pipe(
        Effect.provide(
          Application.layer(
            {
              home,
              cwd: home,
              providers: { [instanceId]: provider },
            },
            () => Effect.void,
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.skipIf(process.platform === "win32")(
  "connects an Antigravity key profile and signs it out while a chat is running",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-antigravity-account-" });
      const instanceId = "antigravity";
      const log = `${home}/requests.log`;
      const provider = yield* fakeAntigravity(home, {
        NODEX_ACP_AUTH_METHOD_ID: "gemini-api-key",
        NODEX_ACP_HANG_PROMPT_FOREVER: "1",
        NODEX_ACP_REQUEST_LOG_PATH: log,
      });
      yield* fs.writeFileString(log, "");
      yield* Effect.gen(function* () {
        const target = { instanceId, ownerId: "settings" };
        yield* call("providers.auth.start", target);
        const auth = yield* call("providers.auth.read", target).pipe(
          Effect.repeat({
            until: ({ phase }) => phase === "succeeded" || phase === "failed",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        expect(auth).toMatchObject({ phase: "succeeded" });
        const readCatalog = () =>
          call("providers.read", { instanceIds: [instanceId], refresh: true });
        expect((yield* readCatalog())[0]?.auth.status).toBe("authenticated");
        yield* startThread(
          home,
          instanceId,
          "Antigravity account",
          "Wait for sign-out",
          "gemini-test-low",
        );
        yield* fs.readFileString(log).pipe(
          Effect.repeat({
            until: (value) => value.includes('"method":"session/prompt"'),
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        const before = yield* call("thread.snapshot", { threadId: "thread" });
        expect(before.projection.runs[0]?.status).toBe("running");

        yield* call("providers.auth.logout", { instanceId });
        const signedOut = (yield* readCatalog())[0];
        expect(signedOut).toMatchObject({ auth: { status: "unauthenticated" }, models: [] });
        const stopped = yield* call("thread.snapshot", { threadId: "thread" }).pipe(
          Effect.repeat({
            until: (value) => value.projection.runs.every(({ status }) => status !== "running"),
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        expect(stopped.projection.messages.some(({ text }) => text === "Wait for sign-out")).toBe(
          true,
        );
      }).pipe(
        Effect.provide(
          Application.layer(
            {
              home,
              cwd: home,
              providers: { [instanceId]: provider },
            },
            () => Effect.void,
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
