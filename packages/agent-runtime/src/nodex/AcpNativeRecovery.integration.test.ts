import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "./Interface.ts";

it.live(
  "recovers a lost native import response after reopening and deletes only unmapped history",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-native-recovery-" });
      const cwd = yield* fs.realPath(home);
      const log = path.join(home, "requests.jsonl");
      yield* fs.writeFileString(log, "");
      const instanceId = "native_recovery";
      const providers = {
        [instanceId]: {
          driver: "acpRegistry",
          config: {
            source: "local",
            discovery: "explicit",
            commandPath: process.execPath,
            commandArgs: [
              fileURLToPath(new URL("./testing/acp-management-peer.mjs", import.meta.url)),
            ],
            nativeStorageScope: home,
            agentIdentity: "fixture",
          },
          environment: [
            { name: "ACP_MANAGEMENT_LOG", value: log, sensitive: false },
            {
              name: "ACP_MANAGEMENT_STATE",
              value: path.join(home, "provider.json"),
              sensitive: false,
            },
          ],
        },
      };
      const call = <M extends AgentRuntimeMethod>(
        method: M,
        input: AgentRuntimeOperations[M]["input"],
      ) =>
        AgentRuntime.use((runtime) => runtime.handle({ id: method, method, input })).pipe(
          Effect.map((output) => output as AgentRuntimeOperations[M]["output"]),
        );
      const imported = yield* Effect.gen(function* () {
        yield* call("project.upsert", { id: "project", title: "Project", workspaceRoot: cwd });
        yield* call("acp.connection.start", { instanceId, cwd, operationId: "connect" });
        const connected = yield* call("acp.operation.read", { operationId: "connect" }).pipe(
          Effect.repeat({
            until: (operation) => operation.phase !== "running",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
        expect(connected.phase).toBe("succeeded");
        yield* fs.writeFileString(log, "");
        const source = yield* call("acp.sessions.prepareImport", {
          instanceId,
          cwd,
          sessionId: "native-a",
        });
        const input = {
          instanceId,
          cwd,
          sessionId: "native-a",
          commandId: "import-original",
          threadId: source.threadId,
          projectId: "project",
          title: source.title,
          sourceFingerprint: source.sourceFingerprint,
          model: "fixture",
        };
        // The durable transaction commits, but its caller never receives the answer.
        expect(
          Exit.isFailure(
            yield* call("acp.sessions.import", input).pipe(
              Effect.andThen(Effect.fail(new Error("Import response lost"))),
              Effect.exit,
            ),
          ),
        ).toBe(true);
        return input;
      }).pipe(Effect.provide(Application.layer({ home, cwd, providers }, () => Effect.void)));

      yield* Effect.gen(function* () {
        expect(yield* call("acp.sessions.import", imported)).toEqual({
          threadId: imported.threadId,
        });
        expect(
          yield* call("acp.sessions.import", { ...imported, commandId: "retry-after-reopen" }),
        ).toEqual({ threadId: imported.threadId });
        expect((yield* call("project.roots", { projectId: "project" })).threadIds).toEqual([
          imported.threadId,
        ]);
        const snapshot = yield* call("thread.snapshot", { threadId: imported.threadId });
        expect(snapshot.projection.runs).toHaveLength(0);
        expect(snapshot.projection.providerThreads).toHaveLength(1);
        expect(snapshot.projection.providerThreads[0]?.nativeThreadRef).toMatchObject({
          nativeId: "native-a",
          strength: "strong",
        });
        expect(
          (yield* call("acp.sessions.list", { instanceId, cwd })).sessions[0]?.importedThreadId,
        ).toBe(imported.threadId);
        expect(
          yield* call("acp.sessions.delete", { instanceId, cwd, sessionId: "native-b" }),
        ).toEqual({ deleted: true });
        expect(
          Exit.isFailure(
            yield* call("acp.sessions.delete", { instanceId, cwd, sessionId: "native-a" }).pipe(
              Effect.exit,
            ),
          ),
        ).toBe(true);
        yield* call("acp.modelProviders.set", {
          instanceId,
          cwd,
          providerId: "optional",
          apiType: "openai",
          baseUrl: "https://models.example.test/v1",
          headers: {},
        });
        const disabled = yield* call("acp.modelProviders.disable", {
          instanceId,
          cwd,
          providerId: "optional",
        });
        expect(
          disabled.providers.find((provider) => provider.providerId === "optional")?.current,
        ).toBeNull();
      }).pipe(Effect.provide(Application.layer({ home, cwd, providers }, () => Effect.void)));

      const requests = (yield* fs.readFileString(log))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; sessionId?: string });
      expect(
        requests
          .filter((request) => request.method === "session/delete")
          .map((request) => request.sessionId),
      ).toEqual(["native-b"]);
      expect(
        requests.some(
          (request) => request.method === "session/prompt" || request.method === "session/new",
        ),
      ).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
);
