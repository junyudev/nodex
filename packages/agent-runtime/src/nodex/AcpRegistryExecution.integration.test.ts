import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type {
  AgentCommand,
  AgentRuntimeConfiguration,
  AgentRuntimeMethod,
  AgentRuntimeOperations,
} from "./Interface.ts";

it.live.skipIf(process.platform === "win32")(
  "executes an approved Registry installation and reopens its pinned conversation offline",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-registry execution-" });
      const log = `${home}/requests.jsonl`;
      const release = `${home}/release`;
      yield* fs.writeFileString(log, "");
      yield* fs.writeFileString(release, "ready");
      const peer = yield* fs.readFileString(
        fileURLToPath(new URL("./testing/acp-queued-peer.mjs", import.meta.url)),
      );
      const bytes = `#!/usr/bin/env node\n${peer}`;
      const archive = "https://registry.test/agent.bin";
      const target = `${process.platform}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
      const registry = JSON.stringify({
        version: "1.0.0",
        agents: [
          {
            id: "execution-fixture",
            name: "Execution fixture",
            description: "Offline installation contract",
            version: "1.0.0",
            distribution: {
              binary: {
                [target]: {
                  archive,
                  cmd: "agent",
                  sha256: createHash("sha256").update(bytes).digest("hex"),
                },
              },
            },
          },
        ],
      });
      let online = true;
      const requests: string[] = [];
      const fetch: typeof globalThis.fetch = async (input) => {
        const url = String(input);
        requests.push(url);
        if (!online) throw new Error("A pinned offline conversation requested the network");
        if (url.endsWith("/registry.json")) return new Response(registry);
        if (url === archive) return new Response(bytes);
        throw new Error("Unexpected network request");
      };
      let providers: AgentRuntimeConfiguration["providers"] = {};
      const instanceId = "installed-agent";
      const call = <M extends AgentRuntimeMethod>(
        method: M,
        input: AgentRuntimeOperations[M]["input"],
      ) =>
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          return (yield* runtime.handle({
            id: crypto.randomUUID(),
            method,
            input,
          })) as AgentRuntimeOperations[M]["output"];
        });
      const withRuntime = <A, E>(body: Effect.Effect<A, E, AgentRuntime>) =>
        Effect.scoped(
          body.pipe(
            Effect.provide(Application.layer({ home, cwd: home, providers }, () => Effect.void)),
            Effect.provideService(FetchHttpClient.Fetch, fetch),
          ),
        );
      const waitOperation = (operationId: string) =>
        call("acp.operation.read", { operationId }).pipe(
          Effect.repeat({
            until: (value) => value.phase !== "running",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
      const send = (messageId: string) =>
        Effect.gen(function* () {
          const command: AgentCommand = {
            type: "message.dispatch",
            commandId: `send-${messageId}`,
            threadId: "installed-thread",
            messageId,
            text: messageId,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          };
          yield* call("command.dispatch", { command: command });
          const outcome = yield* call("run.outcome", {
            threadId: "installed-thread",
            messageId,
          }).pipe(
            Effect.repeat({
              until: (value) => value?.status === "completed" || value?.status === "failed",
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("10 seconds"),
          );
          expect(outcome?.status).toBe("completed");
          return yield* call("thread.snapshot", { threadId: "installed-thread" });
        });
      const first = yield* withRuntime(
        Effect.gen(function* () {
          const found = yield* call("acp.registry.search", { query: "execution-fixture" });
          expect(found.agents.map((agent) => agent.id)).toEqual(["execution-fixture"]);
          expect(yield* fs.readFileString(log)).toBe("");
          const preview = yield* call("acp.install.preview", { agentId: "execution-fixture" });
          expect(preview.available).toBe(true);
          const installation = yield* call("acp.install.start", {
            operationId: "install",
            agentId: "execution-fixture",
            expectedInstallationId: preview.installationId,
          });
          const installed = yield* waitOperation(installation.operationId);
          expect(installed.phase).toBe("succeeded");
          if (!installed.result || !("installationId" in installed.result))
            throw new Error("The installation did not publish a receipt");
          providers = {
            [instanceId]: {
              driver: "acpRegistry",
              enabled: true,
              config: {
                source: "registry",
                agentId: "execution-fixture",
                installationId: installed.result.installationId,
                discovery: "explicit",
                inheritEnvironment: false,
                nativeStorageScope: home,
              },
              environment: [
                { name: "HOME", value: home, sensitive: false },
                { name: "PATH", value: dirname(process.execPath), sensitive: false },
                { name: "ACP_QUEUE_LOG", value: log, sensitive: false },
                { name: "ACP_QUEUE_RELEASE", value: release, sensitive: false },
                { name: "ACP_QUEUE_VERSION", value: "installed", sensitive: false },
              ],
            },
          };
          expect((yield* call("providers.configure", { providers })).applied).toBe(true);
          const connection = yield* call("acp.connection.start", {
            instanceId,
            cwd: home,
            operationId: "connect",
          });
          expect((yield* waitOperation(connection.operationId)).phase).toBe("succeeded");
          yield* call("project.upsert", { id: "project", title: "Project", workspaceRoot: home });
          yield* call("command.dispatch", {
            command: {
              type: "thread.create",
              commandId: "create",
              threadId: "installed-thread",
              projectId: "project",
              title: "Installed conversation",
              modelSelection: { instanceId, model: "model-a" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: home,
              createdBy: "user",
              creationSource: "web",
            },
          });
          return yield* send("first");
        }),
      );
      expect(first.projection.messages.filter((message) => message.role === "assistant")).toEqual([
        expect.objectContaining({ text: "QUEUE_OK" }),
      ]);
      const nativeId = first.projection.providerThreads[0]?.nativeThreadRef?.nativeId;
      expect(nativeId).toBe("queue-session");
      expect(requests.filter((url) => url === archive)).toHaveLength(1);
      const onlineRequests = requests.length;
      const beforeRestart = yield* fs.readFileString(log);
      online = false;
      yield* fs.remove(`${home}/caches/acp-registry/registry.json`);
      const second = yield* withRuntime(send("second"));
      expect(second.projection.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(nativeId);
      expect(second.projection.messages.filter((message) => message.role === "assistant")).toEqual([
        expect.objectContaining({ text: "QUEUE_OK" }),
        expect.objectContaining({ text: "QUEUE_OK" }),
      ]);
      expect(requests).toHaveLength(onlineRequests);
      const restarted = (yield* fs.readFileString(log)).slice(beforeRestart.length);
      const methods = restarted
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { method?: string }).method);
      expect(methods.filter((method) => method === "session/load")).toHaveLength(1);
      expect(methods.filter((method) => method === "session/prompt")).toHaveLength(1);
      expect(methods).not.toContain("session/new");
    }).pipe(Effect.provide(NodeServices.layer)),
  30_000,
);
