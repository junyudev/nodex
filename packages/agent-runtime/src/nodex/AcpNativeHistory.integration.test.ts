import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "./Interface.ts";

it.live.each([
  { protocol: "v1", canLoad: true, nativeSessionId: " x " },
  { protocol: "v1", canLoad: false, nativeSessionId: "n".repeat(1024) },
  { protocol: "v2", canLoad: true, nativeSessionId: " " },
])(
  "retains $protocol native import capabilities without loading history until Continue (canLoad=$canLoad)",
  ({ protocol, canLoad, nativeSessionId }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-native-history-" });
      const log = `${home}/requests.log`;
      yield* fs.writeFileString(log, "");
      const instanceId = "history";
      const config = {
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
                fileURLToPath(new URL("./testing/acp-native-history-peer.mjs", import.meta.url)),
              ],
            },
            environment: [
              { name: "ACP_HISTORY_CAN_LOAD", value: canLoad ? "1" : "0", sensitive: false },
              { name: "ACP_HISTORY_LOG", value: log, sensitive: false },
              { name: "ACP_HISTORY_PROTOCOL", value: protocol, sensitive: false },
              { name: "ACP_HISTORY_SESSION_ID", value: nativeSessionId, sensitive: false },
            ],
          },
        },
      };
      const run = <A, E>(body: Effect.Effect<A, E, AgentRuntime>) =>
        Effect.scoped(body.pipe(Effect.provide(Application.layer(config, () => Effect.void))));
      const call = <M extends AgentRuntimeMethod>(
        method: M,
        input: AgentRuntimeOperations[M]["input"],
      ) =>
        AgentRuntime.use((runtime) => runtime.handle({ id: method, method, input })).pipe(
          Effect.map((output) => output as AgentRuntimeOperations[M]["output"]),
        );
      const nativeRow = (snapshot: AgentRuntimeOperations["thread.snapshot"]["output"]) =>
        snapshot.projection.providerThreads.find(
          (row) => row.id === snapshot.projection.thread.activeProviderThreadId,
        );
      const threadId = yield* run(
        Effect.gen(function* () {
          yield* call("project.upsert", { id: "project", title: "Project", workspaceRoot: home });
          yield* call("acp.connection.start", { instanceId, cwd: home, operationId: "connect" });
          const connected = yield* call("acp.operation.read", { operationId: "connect" }).pipe(
            Effect.repeat({
              until: (value) => value.phase !== "running",
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("10 seconds"),
          );
          expect(connected.phase).toBe("succeeded");
          yield* fs.writeFileString(log, "");
          const prepared = yield* call("acp.sessions.prepareImport", {
            instanceId,
            cwd: home,
            sessionId: nativeSessionId,
          });
          expect(prepared).toMatchObject({ canLoad, canResume: true });
          yield* call("acp.sessions.import", {
            instanceId,
            cwd: prepared.cwd,
            sessionId: nativeSessionId,
            commandId: "import",
            threadId: prepared.threadId,
            projectId: "project",
            title: prepared.title,
            sourceFingerprint: prepared.sourceFingerprint,
            model: "fixture",
          });
          const snapshot = yield* call("thread.snapshot", { threadId: prepared.threadId });
          expect(snapshot.projection.runs).toHaveLength(0);
          expect(snapshot.projection.messages).toHaveLength(0);
          expect(nativeRow(snapshot)).toMatchObject({
            status: "not_loaded",
            nativeMetadata: { nativeImport: { canLoad, canResume: true } },
          });
          expect(yield* fs.readFileString(log)).not.toMatch(/session\/(load|resume|new|prompt)/);
          return prepared.threadId;
        }),
      );
      const beforeReopen = yield* fs.readFileString(log);
      yield* run(
        Effect.gen(function* () {
          const snapshot = yield* call("thread.snapshot", { threadId });
          expect(nativeRow(snapshot)).toMatchObject({
            status: "not_loaded",
            nativeMetadata: { nativeImport: { canLoad, canResume: true } },
          });
          yield* call("thread.read", { threadId });
          expect(yield* fs.readFileString(log)).toBe(beforeReopen);
          yield* call("command.dispatch", {
            type: "message.dispatch",
            commandId: "continue",
            threadId,
            messageId: "message",
            text: "Continue",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
          const outcome = yield* call("run.outcome", { threadId, messageId: "message" }).pipe(
            Effect.repeat({
              until: (value) => value?.status === "completed" || value?.status === "failed",
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("15 seconds"),
          );
          expect(outcome?.status).toBe("completed");
          const loaded = yield* call("thread.snapshot", { threadId });
          expect(nativeRow(loaded)?.status).toBe("idle");
          expect(nativeRow(loaded)?.nativeThreadRef?.nativeId).toBe(nativeSessionId);
          expect(nativeRow(loaded)?.nativeMetadata?.nativeImport).toEqual({
            canLoad,
            canResume: true,
          });
          const requests = (yield* fs.readFileString(log))
            .slice(beforeReopen.length)
            .trim()
            .split("\n");
          expect(
            requests.filter(
              (method) =>
                method === (canLoad && protocol === "v1" ? "session/load" : "session/resume"),
            ),
          ).toHaveLength(1);
          expect(requests).toContain("session/prompt");
          expect(requests).not.toContain("session/new");
          expect(
            requests.filter((request) => request.startsWith("prompt:")).join("\n"),
          ).not.toContain("Earlier native question");
          expect(JSON.stringify(loaded.projection.messages).includes("Earlier native answer")).toBe(
            canLoad,
          );
          const ancestry = loaded.projection.messages.filter((entry) => entry.runId === null);
          expect(ancestry).toHaveLength(canLoad ? 2 : 0);
          const ancestryItems = loaded.projection.visibleTurnItems
            .map((entry) => entry.item)
            .filter((entry) => entry.runId === null);
          expect(ancestryItems).toHaveLength(canLoad ? 2 : 0);
          expect(
            ancestryItems.every((entry) => entry.providerThreadId === nativeRow(loaded)?.id),
          ).toBe(true);
          expect(loaded.projection.thread.historyOrigin).toBe("native_import");
        }),
      );
      const afterContinue = yield* fs.readFileString(log);
      yield* run(
        Effect.gen(function* () {
          const restored = yield* call("thread.snapshot", { threadId });
          const original = restored.projection.messages.filter((entry) => entry.runId === null);
          expect(original).toHaveLength(canLoad ? 2 : 0);
          expect(nativeRow(restored)?.status).toBe("idle");
          expect(yield* fs.readFileString(log)).toBe(afterContinue);
          yield* call("command.dispatch", {
            type: "message.dispatch",
            commandId: "continue-again",
            threadId,
            messageId: "second-message",
            text: "Continue again",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
          const outcome = yield* call("run.outcome", {
            threadId,
            messageId: "second-message",
          }).pipe(
            Effect.repeat({
              until: (value) => value?.status === "completed" || value?.status === "failed",
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("15 seconds"),
          );
          expect(outcome?.status).toBe("completed");
          const continued = yield* call("thread.snapshot", { threadId });
          expect(continued.projection.runs).toHaveLength(2);
          expect(continued.projection.messages.filter((entry) => entry.runId === null)).toEqual(
            original,
          );
          expect(continued.projection.providerThreads).toHaveLength(1);
          expect(nativeRow(continued)?.nativeThreadRef?.nativeId).toBe(nativeSessionId);
          expect((yield* fs.readFileString(log)).slice(afterContinue.length)).not.toContain(
            "session/new",
          );
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  30_000,
);
