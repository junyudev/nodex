import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "./Interface.ts";

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
        const call = <M extends AgentRuntimeMethod>(
          method: M,
          input: AgentRuntimeOperations[M]["input"],
        ) =>
          AgentRuntime.use((runtime) => runtime.handle({ id: method, method, input })).pipe(
            Effect.map((output) => output as AgentRuntimeOperations[M]["output"]),
          );
        yield* call("project.upsert", { id: "project", title: "Streaming", workspaceRoot: home });
        yield* call("acp.connection.start", { instanceId, cwd: home, operationId: "connect" });
        const connected = yield* call("acp.operation.read", { operationId: "connect" }).pipe(
          Effect.repeat({
            until: (value) => value.phase !== "running",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        expect(connected.phase).toBe("succeeded");
        yield* call("command.dispatch", {
          type: "thread.create",
          commandId: "create",
          threadId: "thread",
          projectId: "project",
          title: "Streaming",
          modelSelection: { instanceId, model: "fixture" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: home,
          createdBy: "user",
          creationSource: "web",
        });
        yield* call("command.dispatch", {
          type: "message.dispatch",
          commandId: "send",
          threadId: "thread",
          messageId: "message",
          text: "Start the response, then wait",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        yield* fs
          .readFileString(log)
          .pipe(
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
          type: "run.interrupt",
          commandId: "stop",
          threadId: "thread",
          runId: run.id,
          holdQueue: true,
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
  30_000,
);
