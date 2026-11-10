import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@nodex/runtime-contracts";
import * as IdAllocator from "@nodex/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@nodex/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@nodex/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@nodex/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@nodex/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@nodex/provider-core/server/ProviderLatestVersions";
import { writeFakeCli } from "@nodex/provider-testing/fakeCli";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient } from "effect/http";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import { ClaudeAgentSdkQueryRunner } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ClaudeProvider from "../ClaudeProvider.ts";
import { parseClaudeModelLineup } from "../ClaudeModelCatalog.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";

vi.mock("../ClaudeProvider.ts", { spy: true });

const settings = { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false };
const layer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "nodex-claude-model-discovery-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
  IdAllocator.layer,
  McpProviderSessions.layer,
  ModelManifest.layerTest,
  ProviderLatestVersions.layer,
  Layer.mock(ClaudeAgentSdkQueryRunner)({}),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Discovery must not make HTTP requests")),
  ),
  Layer.mock(ProviderHost.ProviderHost)({
    paths: {
      cwd: process.cwd(),
      baseDir: "unused",
      stateDir: "unused",
      providerStatusCacheDir: "unused",
      attachmentsDir: "unused",
    },
    resolveAttachmentPath: () => null,
    settings: {
      get: Effect.succeed(settings),
      withSnapshot: (use) => use(settings),
      changes: Stream.empty,
      subscribe: Effect.succeed(Stream.empty),
    },
    shouldRunBackgroundWork: () => Effect.succeed(false),
  }),
);

it.effect(
  "retains discovered models across probe expiry, failure and empty answers, then replaces the lineup",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("claude-discovery");
      const probe = vi.spyOn(ClaudeProvider, "probeClaudeCapabilities");
      yield* Effect.addFinalizer(() => Effect.sync(() => probe.mockRestore()));
      const capabilities = (model: string | undefined) => ({
        email: "ada@example.test",
        subscriptionType: "max",
        tokenSource: "claude.ai",
        apiKeySource: undefined,
        apiProvider: "firstParty",
        slashCommands: [],
        modelLineup: parseClaudeModelLineup(
          model ? [{ value: "fable", resolvedModel: model }] : [],
        ),
      });
      probe.mockReturnValue(Effect.succeed(capabilities("claude-fable-5-3")));
      const instance = yield* ClaudeDriver.create({
        instanceId,
        displayName: "Claude discovery",
        enabled: true,
        environment: [],
        config: {
          ...ClaudeDriver.defaultConfig(),
          homePath: path.join(config.stateDir, "claude-home"),
          binaryPath: writeFakeCli({
            directory: config.stateDir,
            name: "claude",
            source: 'console.log("2.1.322 (Claude Code)");',
          }),
        },
      });
      yield* instance.snapshot.initialCheck;
      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.equal(snapshot.models.find(({ isDefault }) => isDefault)?.slug, "claude-fable-5-3");

      const contextWindow = Effect.fnUntraced(function* (model: string) {
        const session = yield* instance.orchestrationAdapter.openSession({
          threadId: ThreadId.make("discovered-model-thread"),
          providerSessionId: ProviderSessionId.make("discovered-model-session"),
          modelSelection: { instanceId, model },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: config.stateDir,
          }),
        });
        return session.getModelContextWindow?.({ instanceId, model });
      }, Effect.scoped);
      assert.equal(yield* contextWindow("claude-fable-5-3"), 1_000_000);
      yield* TestClock.adjust("6 minutes");
      assert.equal(probe.mock.calls.length, 1);
      assert.equal(yield* contextWindow("claude-fable-5-3"), 1_000_000);

      probe.mockReturnValue(Effect.succeed(undefined));
      yield* instance.snapshot.refresh;
      assert.equal(probe.mock.calls.length, 2);
      assert.equal(yield* contextWindow("claude-fable-5-3"), 1_000_000);

      yield* instance.invalidateCaches!;
      probe.mockReturnValue(Effect.succeed(capabilities(undefined)));
      yield* instance.snapshot.refresh;
      assert.equal(yield* contextWindow("claude-fable-5-3"), 1_000_000);

      yield* instance.invalidateCaches!;
      probe.mockReturnValue(Effect.succeed(capabilities("claude-fable-5-4")));
      const refreshed = yield* instance.snapshot.refresh;
      assert.equal(refreshed.models.find(({ isDefault }) => isDefault)?.slug, "claude-fable-5-4");
      assert.equal(yield* contextWindow("claude-fable-5-4"), 1_000_000);
      assert.isUndefined(yield* contextWindow("claude-fable-5-3"));
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
