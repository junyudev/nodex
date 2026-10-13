import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { makeAcpRegistryAdapterV2 } from "@t3tools/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

it.live("launches an isolated ACP child without ambient credentials or proxy variables", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-environment-" });
    const script = path.join(directory, "isolated.mjs");
    const observedPath = path.join(directory, "observed.json");
    const fixture = new URL("../../scripts/acp-mock-agent.ts", import.meta.url).href;
    yield* fs.writeFileString(
      script,
      `import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({
        ambientCredential: process.env.NODEX_TEST_AMBIENT_CREDENTIAL,
        proxy: process.env.HTTPS_PROXY, selected: process.env.NODEX_TEST_SELECTED,
        home: process.env.HOME, config: process.env.XDG_CONFIG_HOME
      }));
      await import(${JSON.stringify(fixture)});`,
    );
    const ambient = {
      credential: process.env.NODEX_TEST_AMBIENT_CREDENTIAL,
      proxy: process.env.HTTPS_PROXY,
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.NODEX_TEST_AMBIENT_CREDENTIAL = "ambient-value";
        process.env.HTTPS_PROXY = "https://ambient-proxy.invalid";
      }),
      () =>
        Effect.sync(() => {
          if (ambient.credential === undefined) delete process.env.NODEX_TEST_AMBIENT_CREDENTIAL;
          else process.env.NODEX_TEST_AMBIENT_CREDENTIAL = ambient.credential;
          if (ambient.proxy === undefined) delete process.env.HTTPS_PROXY;
          else process.env.HTTPS_PROXY = ambient.proxy;
        }),
    );
    const settings = Schema.decodeUnknownSync(AcpRegistrySettings)({
      source: "local",
      inheritEnvironment: false,
      commandPath: process.execPath,
      commandArgs: [script],
      authMethodId: "test",
    });
    const environment = {
      PATH: process.env.PATH,
      HOME: directory,
      XDG_CONFIG_HOME: directory,
      NODEX_TEST_SELECTED: "selected",
    };
    const instanceId = ProviderInstanceId.make("isolated-acp");
    const adapter = yield* makeAcpRegistryAdapterV2({
      instanceId,
      settings,
      environment,
      selfInvocation: yield* resolveSelfInvocation(),
    }).pipe(
      Effect.provide(
        Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
          resolve: (_settings, cwd, selected) =>
            Effect.succeed({
              distribution: "local" as const,
              spawn: {
                command: process.execPath,
                args: [script],
                cwd,
                ...(selected === undefined ? {} : { env: selected }),
              },
            }),
        }),
      ),
    );
    yield* adapter.openSession({
      threadId: ThreadId.make("isolated-thread"),
      providerSessionId: ProviderSessionId.make("isolated-session"),
      modelSelection: { instanceId, model: "default" },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: process.cwd() },
    });
    const observed = JSON.parse(yield* fs.readFileString(observedPath));
    expect(observed).toEqual({ selected: "selected", home: directory, config: directory });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        IdAllocator.layer,
        McpSessions.layer,
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  ),
);
