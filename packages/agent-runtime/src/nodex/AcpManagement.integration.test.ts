import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { fileURLToPath } from "node:url";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "./Interface.ts";
import { acpFailure } from "./AcpFailures.ts";

it.live(
  "rejects uninstall during installation and while the prepared files await configuration",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-install-lease-" });
      const downloadStarted = Promise.withResolvers<void>();
      const releaseDownload = Promise.withResolvers<void>();
      const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
      const registry = JSON.stringify({
        version: "1.0.0",
        agents: [
          {
            id: "fixture",
            name: "Fixture",
            description: "Installation",
            version: "1",
            distribution: {
              binary: { [target]: { archive: "https://fixture.test/agent.bin", cmd: "agent" } },
            },
          },
        ],
      });
      const fetch: typeof globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.endsWith("/registry.json")) return new Response(registry);
        if (url !== "https://fixture.test/agent.bin") throw new Error("Unexpected test request");
        downloadStarted.resolve();
        await releaseDownload.promise;
        return new Response("#!/bin/sh\nexit 0\n");
      };
      yield* Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const install = yield* runtime.handle({
          id: "install",
          method: "acp.install.start",
          input: { operationId: "install", agentId: "fixture", distribution: "binary" },
        });
        expect(install).toMatchObject({
          phase: "running",
          runtimeGeneration: expect.any(String),
          configurationRevision: null,
          revision: expect.any(Number),
          cancellable: true,
        });
        yield* Effect.promise(() => downloadStarted.promise).pipe(Effect.timeout("5 seconds"));
        const uninstall = runtime.handle({
          id: "uninstall",
          method: "acp.registry.uninstall",
          input: { agentId: "fixture" },
        });
        const busy = yield* uninstall.pipe(Effect.flip, Effect.timeout("1 second"));
        expect(acpFailure(busy).reason).toBe("busy");
        releaseDownload.resolve();
        const completed = yield* runtime
          .handle({ id: "read", method: "acp.operation.read", input: { operationId: "install" } })
          .pipe(
            Effect.repeat({
              until: (result) => (result as { phase: string }).phase !== "running",
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("5 seconds"),
          );
        expect(completed).toMatchObject({
          phase: "succeeded",
          runtimeGeneration: expect.any(String),
          configurationRevision: null,
          cancellable: false,
          result: { prepared: true },
        });
        expect(acpFailure(yield* uninstall.pipe(Effect.flip)).reason).toBe("busy");
        expect(yield* fs.exists(`${home}/tools/fixture`)).toBe(true);
        expect(
          yield* runtime.handle({
            id: "absent",
            method: "acp.registry.uninstall",
            input: { agentId: "missing" },
          }),
        ).toEqual({ agentId: "missing", removed: false });
      }).pipe(
        Effect.provide(Application.layer({ home, cwd: home, providers: {} }, () => Effect.void)),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.ensuring(Effect.sync(() => releaseDownload.resolve())),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  20_000,
);

it.live("refuses uninstall while even a disabled saved instance owns the installation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-uninstall-" });
    yield* Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const blocked = yield* runtime
        .handle({ id: "blocked", method: "acp.registry.uninstall", input: { agentId: "fixture" } })
        .pipe(Effect.flip);
      expect(acpFailure(blocked)).toMatchObject({ reason: "busy", affectedThreadIds: [] });
      yield* runtime.handle({
        id: "remove",
        method: "providers.configure",
        input: { providers: {} },
      });
      expect(
        yield* runtime.handle({
          id: "unused",
          method: "acp.registry.uninstall",
          input: { agentId: "fixture" },
        }),
      ).toEqual({ agentId: "fixture", removed: false });
    }).pipe(
      Effect.provide(
        Application.layer(
          {
            home,
            cwd: home,
            providers: {
              saved: {
                driver: "acpRegistry",
                enabled: false,
                config: { source: "registry", agentId: "fixture", discovery: "explicit" },
              },
            },
          },
          () => Effect.void,
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "keeps passive discovery prompt-free and imports native identity without creating work",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-management-" });
      const workspace = path.join(home, "original workspace");
      yield* fs.makeDirectory(workspace);
      const cwd = yield* fs.realPath(workspace);
      const log = path.join(home, "requests.jsonl");
      const state = path.join(home, "provider.json");
      yield* fs.writeFileString(log, "");
      const instanceId = "fixture_agent";
      const providers = {
        [instanceId]: {
          driver: "acpRegistry",
          enabled: true,
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
            { name: "ACP_MANAGEMENT_STATE", value: state, sensitive: false },
            { name: "ACP_MANAGEMENT_AUTH_SUCCESS", value: "1", sensitive: false },
          ],
        },
      };
      yield* Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        let serial = 0;
        const call = <M extends AgentRuntimeMethod>(
          method: M,
          input: AgentRuntimeOperations[M]["input"],
        ) =>
          runtime
            .handle({ id: String(++serial), method, input })
            .pipe(Effect.map((output) => output as AgentRuntimeOperations[M]["output"]));
        const methods = () =>
          fs.readFileString(log).pipe(
            Effect.map((text) =>
              text
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => (JSON.parse(line) as { method: string }).method),
            ),
          );
        yield* call("providers.read", {});
        expect(yield* methods()).not.toContain("session/new");
        const operation = yield* call("acp.connection.start", {
          operationId: "connect",
          instanceId,
          cwd,
        });
        const settled = yield* call("acp.operation.read", {
          operationId: operation.operationId,
        }).pipe(
          Effect.repeat({
            until: (value) => value.phase !== "running",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        expect(settled.phase).toBe("succeeded");
        const authDetails = yield* call("acp.auth.read", { instanceId, ownerId: "window" });
        expect(authDetails.methods?.find((method) => method.id === "env")).toMatchObject({
          type: "credentials",
          envVarNames: ["MODEL_TOKEN"],
          link: "https://example.test/keys",
        });
        expect(settled.result).toMatchObject({
          protocolGeneration: 2,
          agentInfo: { name: "management-fixture", version: "1" },
        });
        expect(yield* call("acp.activity", {})).toEqual({
          activeOperations: 0,
          activeAuthentication: 0,
        });
        expect((yield* methods()).filter((method) => method === "session/delete")).toHaveLength(1);
        const first = yield* call("acp.sessions.list", { instanceId, cwd });
        expect(first.nextCursor).toBe("page-two");
        const second = yield* call("acp.sessions.list", {
          instanceId,
          cwd,
          cursor: first.nextCursor!,
        });
        expect(second.sessions[0]?.sessionId).toBe("native-b");
        yield* call("project.upsert", { id: "project", title: "Project", workspaceRoot: cwd });
        const source = yield* call("acp.sessions.prepareImport", {
          instanceId,
          cwd,
          sessionId: "native-a",
        });
        expect(source.cwd).toBe(cwd);
        const imported = {
          commandId: "import-native",
          threadId: source.threadId,
          projectId: "project",
          title: source.title,
          instanceId,
          cwd: source.cwd,
          sessionId: "native-a",
          sourceFingerprint: source.sourceFingerprint,
          model: "fixture",
        };
        expect(yield* call("acp.sessions.import", imported)).toEqual({ threadId: source.threadId });
        expect(yield* call("acp.sessions.import", imported)).toEqual({ threadId: source.threadId });
        const snapshot = yield* call("thread.snapshot", { threadId: source.threadId });
        expect(snapshot.projection.runs).toHaveLength(0);
        expect(snapshot.projection.providerThreads[0]?.status).toBe("not_loaded");
        expect(snapshot.projection.providerThreads[0]?.nativeThreadRef?.nativeId).toBe("native-a");
        expect(yield* methods()).not.toContain("session/prompt");
        const blockedDelete = yield* call("acp.sessions.delete", {
          instanceId,
          cwd,
          sessionId: "native-a",
        }).pipe(Effect.flip);
        expect(acpFailure(blockedDelete)).toMatchObject({
          reason: "busy",
          affectedThreadIds: [source.threadId],
        });
        const before = yield* methods();
        expect(
          Exit.isFailure(
            yield* call("acp.modelProviders.disable", {
              instanceId,
              cwd,
              providerId: "required",
            }).pipe(Effect.exit),
          ),
        ).toBe(true);
        expect((yield* methods()).filter((method) => method === "providers/disable")).toHaveLength(
          before.filter((method) => method === "providers/disable").length,
        );
        yield* fs.writeFileString(
          state,
          JSON.stringify({
            apiType: "openai",
            baseUrl: "https://user:private-token@models.example.test/v1",
          }),
        );
        const credentialUrl = yield* call("acp.modelProviders.list", { instanceId, cwd });
        expect(
          credentialUrl.providers.find((provider) => provider.providerId === "optional")?.current,
        ).toBeNull();
        expect(JSON.stringify(credentialUrl)).not.toContain("private-token");
        const changed = yield* call("acp.modelProviders.set", {
          instanceId,
          cwd,
          providerId: "optional",
          apiType: "openai",
          baseUrl: "https://models.example.test/v1",
          headers: { Authorization: "Bearer TEST_SECRET" },
        });
        expect(
          changed.providers.find((provider) => provider.providerId === "optional")?.current,
        ).toEqual({ apiType: "openai", baseUrl: "https://models.example.test/v1" });
        expect(JSON.stringify(changed)).not.toContain("TEST_SECRET");
        yield* call("acp.auth.start", { instanceId, ownerId: "window", methodId: "login" });
        const signedIn = yield* call("acp.auth.read", { instanceId, ownerId: "window" }).pipe(
          Effect.repeat({
            until: (state) => state.phase === "succeeded" || state.phase === "failed",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
        expect(signedIn.phase).toBe("succeeded");
        const verificationMethods = yield* methods();
        expect(verificationMethods.filter((method) => method === "session/new")).toHaveLength(2);
        expect(verificationMethods.filter((method) => method === "session/delete")).toHaveLength(2);
        const renamed = {
          ...providers[instanceId],
          displayName: "Renamed Agent",
          config: { ...providers[instanceId].config, customModels: ["custom-model"] },
        };
        expect(
          (yield* call("providers.configure", { providers: { [instanceId]: renamed } })).applied,
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* call("providers.configure", {
              providers: {
                [instanceId]: {
                  ...renamed,
                  config: { ...renamed.config, nativeStorageScope: `${home}/other` },
                },
              },
            }).pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* call("providers.configure", {
              providers: {
                [instanceId]: {
                  ...renamed,
                  config: { ...renamed.config, agentIdentity: "other-agent" },
                },
              },
            }).pipe(Effect.exit),
          ),
        ).toBe(true);
        yield* call("providers.configure", {
          providers: { [instanceId]: { ...providers[instanceId], enabled: false } },
        });
        const beforeDisabled = yield* methods();
        expect((yield* call("acp.inspect", { instanceId })).status).toBe("ready");
        expect(
          Exit.isFailure(
            yield* call("acp.connection.start", { operationId: "disabled", instanceId, cwd }).pipe(
              Effect.exit,
            ),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* call("text.generate-structured", {
              cwd,
              prompt: "Do not execute",
              modelSelection: { instanceId, model: "fixture" },
              outputSchema: {},
            }).pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(yield* methods()).toEqual(beforeDisabled);
      }).pipe(Effect.provide(Application.layer({ home, cwd, providers }, () => Effect.void)));
    }).pipe(Effect.provide(NodeServices.layer)),
  30_000,
);

it.live.each([true, false])(
  "coordinates shared sign-ins independently of native roots with projected scope: %s",
  (projectedScope) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-auth-owner-" });
      const log = `${home}/requests.jsonl`;
      yield* fs.writeFileString(log, "");
      const common = {
        driver: "acpRegistry",
        enabled: true,
        config: {
          source: "local",
          discovery: "explicit",
          commandPath: process.execPath,
          commandArgs: [
            fileURLToPath(new URL("./testing/acp-management-peer.mjs", import.meta.url)),
          ],
          nativeStorageScope: home,
          ...(projectedScope ? { credentialStorageScopes: [home] } : {}),
          agentIdentity: "same-logical-agent",
        },
        environment: [
          { name: "HOME", value: home, sensitive: false },
          { name: "ACP_MANAGEMENT_LOG", value: log, sensitive: false },
          { name: "ACP_MANAGEMENT_STATE", value: `${home}/state.json`, sensitive: false },
        ],
      };
      const providers = {
        first: common,
        second: {
          ...common,
          config: {
            ...common.config,
            agentIdentity: "another-local-definition",
            nativeStorageScope: `${home}/different-tool-roots`,
          },
          environment: [
            ...common.environment,
            { name: "CARGO_HOME", value: `${home}/cargo-other`, sensitive: false },
          ],
        },
        mixed: {
          ...common,
          config: {
            ...common.config,
            agentIdentity: "claude-agent-acp",
            ...(projectedScope ? { credentialStorageScopes: [home, `${home}/.claude`] } : {}),
          },
        },
        isolated: {
          ...common,
          config: {
            ...common.config,
            nativeStorageScope: `${home}/isolated`,
            ...(projectedScope ? { credentialStorageScopes: [`${home}/isolated`] } : {}),
          },
          environment: common.environment.map((entry) =>
            entry.name === "HOME" ? { ...entry, value: `${home}/isolated` } : entry,
          ),
        },
      };
      yield* Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        let serial = 0;
        const call = <M extends AgentRuntimeMethod>(
          method: M,
          input: AgentRuntimeOperations[M]["input"],
        ) =>
          runtime
            .handle({ id: String(++serial), method, input })
            .pipe(Effect.map((output) => output as AgentRuntimeOperations[M]["output"]));
        const first = yield* call("acp.auth.start", {
          instanceId: "first",
          ownerId: "window-one",
          methodId: "login",
        });
        expect(first.flowId).not.toBeNull();
        expect((yield* call("acp.activity", {})).activeAuthentication).toBe(1);
        expect(
          Exit.isFailure(
            yield* call("acp.auth.start", {
              instanceId: "second",
              ownerId: "window-two",
              methodId: "login",
            }).pipe(Effect.exit),
          ),
        ).toBe(true);
        const mixed = yield* call("acp.auth.start", {
          instanceId: "mixed",
          ownerId: "window-mixed",
          methodId: "login",
        }).pipe(Effect.flip);
        expect(acpFailure(mixed).reason).toBe("busy");
        const isolated = yield* call("acp.auth.start", {
          instanceId: "isolated",
          ownerId: "window-three",
          methodId: "login",
        });
        expect(isolated.flowId).not.toBeNull();
        expect((yield* call("acp.activity", {})).activeAuthentication).toBe(2);
        yield* fs.readFileString(log).pipe(
          Effect.repeat({
            until: (text) =>
              text.split("\n").filter((line) => line.includes('"method":"auth/login"')).length ===
              2,
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
        expect(
          (yield* call("acp.auth.read", { instanceId: "first", ownerId: "window-one" })).phase,
        ).not.toBe("failed");
        const hidden = yield* call("acp.auth.read", {
          instanceId: "first",
          ownerId: "window-two",
        });
        expect(hidden.flowId).toBeNull();
        expect(
          Exit.isFailure(
            yield* call("acp.auth.cancel", {
              instanceId: "first",
              ownerId: "window-two",
              flowId: first.flowId!,
            }).pipe(Effect.exit),
          ),
        ).toBe(true);
        yield* call("acp.auth.cancel", {
          instanceId: "first",
          ownerId: "window-one",
          flowId: first.flowId!,
        });
        const resumed = yield* call("acp.auth.start", {
          instanceId: "mixed",
          ownerId: "window-mixed",
          methodId: "login",
        });
        expect(resumed.flowId).not.toBeNull();
        yield* call("acp.auth.cancel", {
          instanceId: "mixed",
          ownerId: "window-mixed",
          flowId: resumed.flowId!,
        });
        yield* call("acp.auth.cancel", {
          instanceId: "isolated",
          ownerId: "window-three",
          flowId: isolated.flowId!,
        });
        expect((yield* call("acp.activity", {})).activeAuthentication).toBe(0);
      }).pipe(Effect.provide(Application.layer({ home, cwd: home, providers }, () => Effect.void)));
    }).pipe(Effect.provide(NodeServices.layer)),
  20_000,
);
