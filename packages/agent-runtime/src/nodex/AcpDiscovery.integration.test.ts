import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "./Interface.ts";

it.live(
  "keeps authoritative discovery across Runtime restarts without probing during passive reads",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-discovery-" });
      const log = `${home}/requests.log`;
      const state = `${home}/fixture.json`;
      const token = "private-discovery-token";
      yield* fs.writeFileString(log, "");
      yield* fs.writeFileString(state, "{}");
      const instanceId = "discovery-fixture";
      const configuration = {
        home,
        cwd: home,
        providers: {
          [instanceId]: {
            driver: "acpRegistry",
            enabled: true,
            config: {
              source: "local",
              discovery: "explicit",
              inheritEnvironment: false,
              commandPath: process.execPath,
              commandArgs: [
                fileURLToPath(new URL("./testing/acp-discovery-peer.mjs", import.meta.url)),
              ],
              customModels: ["custom"],
            },
            environment: [
              { name: "HOME", value: home, sensitive: false },
              { name: "ACP_DISCOVERY_LOG", value: log, sensitive: false },
              { name: "ACP_DISCOVERY_STATE", value: state, sensitive: false },
              { name: "MODEL_TOKEN", value: token, sensitive: true },
            ],
          },
        },
      };
      const run = <A, E>(body: Effect.Effect<A, E, AgentRuntime>, config = configuration) =>
        Effect.scoped(body.pipe(Effect.provide(Application.layer(config, () => Effect.void))));
      const call = <M extends AgentRuntimeMethod>(
        method: M,
        input: AgentRuntimeOperations[M]["input"],
      ) =>
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          return (yield* runtime.handle({
            id: method,
            method,
            input,
          })) as AgentRuntimeOperations[M]["output"];
        });
      const read = call("providers.read", { instanceIds: [instanceId] }).pipe(
        Effect.map((providers) => providers[0]!),
      );
      const connect = Effect.gen(function* () {
        const operation = yield* call("acp.connection.start", {
          instanceId,
          cwd: home,
          operationId: crypto.randomUUID(),
        });
        return yield* call("acp.operation.read", { operationId: operation.operationId }).pipe(
          Effect.repeat({
            until: (value) => value.phase !== "running",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
      });
      const first = yield* run(read);
      expect(first).toMatchObject({
        installed: true,
        auth: { status: "unknown" },
        discovery: { status: "unknown" },
        models: [],
      });
      expect(yield* fs.readFileString(log)).toBe("");
      yield* run(
        Effect.gen(function* () {
          expect((yield* connect).phase).toBe("succeeded");
          const provider = yield* read;
          expect(provider.discovery).toMatchObject({
            status: "ready",
            supportsModelSelection: true,
          });
          expect(provider.auth.status).toBe("unknown");
          expect(provider.models.map((model) => model.slug)).toEqual(["first", "second", "custom"]);
          expect(provider.nativeSessions).toMatchObject({
            canList: true,
            canResume: true,
            canDelete: true,
          });
          expect(provider.configurableProviders).toBe(true);
        }),
      );
      const callsAfterConnect = yield* fs.readFileString(log);
      const restored = yield* run(read);
      expect(restored.discovery?.status).toBe("ready");
      expect(restored.models.map((model) => model.slug)).toEqual(["first", "second", "custom"]);
      expect(restored.nativeSessions?.canList).toBe(true);
      expect(restored.configurableProviders).toBe(true);
      expect(yield* fs.readFileString(log)).toBe(callsAfterConnect);

      yield* fs.writeFileString(state, JSON.stringify({ models: ["first"] }));
      yield* run(connect);
      expect((yield* run(read)).models.map((model) => model.slug)).toEqual(["first", "custom"]);
      yield* run(
        Effect.gen(function* () {
          yield* call("acp.auth.start", { instanceId, ownerId: "settings", methodId: "key" });
          const signedIn = yield* call("acp.auth.read", { instanceId, ownerId: "settings" }).pipe(
            Effect.repeat({
              until: (value) => value.phase === "succeeded" || value.phase === "failed",
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("10 seconds"),
          );
          expect(signedIn.phase).toBe("succeeded");
          expect((yield* read).auth.status).toBe("authenticated");
        }),
      );
      yield* run(
        Effect.gen(function* () {
          // Native credentials can expire without the Nodex launch configuration changing.
          expect((yield* read).auth.status).toBe("authenticated");
          yield* fs.writeFileString(state, JSON.stringify({ fail: true }));
          const failure = yield* connect;
          expect(failure).toMatchObject({
            phase: "failed",
            error: {
              reason: "authentication_failed",
              authMethods: [{ id: "key", envVarNames: ["MODEL_TOKEN"] }],
            },
          });
          const provider = yield* read;
          expect(provider).toMatchObject({
            discovery: { status: "failed" },
            auth: { status: "unauthenticated", type: "env_var", label: "API key" },
            models: [],
          });
          expect(JSON.stringify(provider)).not.toContain(token);
          expect(
            (yield* call("providers.read", { refresh: true, instanceIds: [instanceId] }))[0],
          ).toMatchObject({
            discovery: { status: "failed" },
            auth: { status: "unauthenticated", label: "API key" },
          });
        }),
      );
      const callsAfterFailure = yield* fs.readFileString(log);
      yield* run(
        Effect.gen(function* () {
          expect(yield* read).toMatchObject({
            discovery: { status: "failed" },
            auth: { status: "unauthenticated" },
            models: [],
          });
          expect(
            (yield* call("acp.auth.read", { instanceId, ownerId: "settings" })).methods,
          ).toMatchObject([
            {
              id: "key",
              type: "credentials",
              envVarNames: ["MODEL_TOKEN"],
              link: "https://example.test/keys",
            },
          ]);
        }),
      );
      expect(yield* fs.readFileString(log)).toBe(callsAfterFailure);

      const instance = configuration.providers![instanceId]!;
      const changed = {
        ...configuration,
        providers: {
          [instanceId]: {
            ...instance,
            environment: instance.environment!.map((entry) =>
              entry.name === "MODEL_TOKEN" ? { ...entry, value: "different-private-token" } : entry,
            ),
          },
        },
      };
      expect(yield* run(read, changed)).toMatchObject({
        discovery: { status: "unknown" },
        auth: { status: "unknown" },
        models: [],
      });
      expect(yield* fs.readFileString(log)).toBe(callsAfterFailure);
      // Reverting configuration cannot revive an invalidated connection.
      expect((yield* run(read)).discovery?.status).toBe("unknown");
      // An executable/argument change is launch identity, even under the same instance ID.
      const changedLaunch = {
        ...configuration,
        providers: {
          [instanceId]: {
            ...instance,
            config: {
              ...instance.config,
              commandArgs: ["--no-warnings", ...(instance.config!.commandArgs as string[])],
            },
          },
        },
      };
      expect((yield* run(read, changedLaunch)).discovery?.status).toBe("unknown");
      const changedHome = {
        ...configuration,
        providers: {
          [instanceId]: {
            ...instance,
            environment: instance.environment!.map((entry) =>
              entry.name === "HOME" ? { ...entry, value: `${home}/other` } : entry,
            ),
          },
        },
      };
      expect((yield* run(read, changedHome)).discovery?.status).toBe("unknown");
      expect(yield* fs.readFileString(log)).toBe(callsAfterFailure);

      yield* fs.writeFileString(state, JSON.stringify({ models: ["first"], echoSecret: true }));
      yield* run(
        Effect.gen(function* () {
          const connected = yield* connect;
          expect(JSON.stringify(connected)).not.toContain(token);
          expect(JSON.stringify(yield* read)).not.toContain(token);
          expect(
            JSON.stringify(
              yield* call("providers.read", { refresh: true, instanceIds: [instanceId] }),
            ),
          ).not.toContain(token);
        }),
      );
      const sanitized = yield* run(read);
      expect(sanitized.models.map((model) => model.slug)).toEqual(["first", "custom"]);
      expect(JSON.stringify(sanitized)).not.toContain(token);
      const files = (directory: string): Effect.Effect<string[]> =>
        fs.readDirectory(directory).pipe(
          Effect.flatMap((names) =>
            Effect.forEach(names, (name) => {
              const file = `${directory}/${name}`;
              return fs
                .stat(file)
                .pipe(
                  Effect.flatMap((info) =>
                    info.type === "Directory" ? files(file) : Effect.succeed([file]),
                  ),
                );
            }),
          ),
          Effect.map((nested) => nested.flat()),
          Effect.orDie,
        );
      for (const file of yield* files(home)) {
        if (!file.endsWith(".json")) continue;
        const contents = yield* fs.readFileString(file);
        expect(contents).not.toContain(token);
        expect(contents).not.toContain("different-private-token");
      }
      yield* fs.writeFileString(state, JSON.stringify({ noModelApi: true }));
      yield* run(connect);
      expect(yield* run(read)).toMatchObject({
        discovery: { status: "ready", supportsModelSelection: false },
        models: [{ slug: "default", name: "Default" }],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  40_000,
);
