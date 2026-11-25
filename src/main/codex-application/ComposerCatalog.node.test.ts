import { live as nativeOperationsLive } from "./PluginNativeOperations";
import { buildAppHostAssetUrl } from "../../shared/app-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { AppProtocolRuntime } from "../host-runtime/AppProtocolRuntime";
import { ComposerCatalog, live as composerCatalogLive } from "./ComposerCatalog";

const makeGateway = (
  requestLocal: CodexGateway["Service"]["requestLocal"],
): CodexGateway["Service"] => {
  const unsupported = () => Effect.die(new Error("Unsupported test operation"));
  return CodexGateway.of({
    promoteQueuedCatalogPage: Effect.succeed(false),
    localHostId: "local",
    requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
    requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
    events: Stream.empty,
    requestLocal,
    requestOnHost: (hostId, method, params) => {
      assert.strictEqual(hostId, "local");
      return requestLocal(method, params);
    },
    requestForThread: (_threadId, method, params) => requestLocal(method, params),
    notifyLocal: unsupported,
    connection: () => unsupported(),
    connectionChanges: () => Stream.empty,
    awaitReady: (hostId) => Effect.sync(() => assert.strictEqual(hostId, "local")),
    reconcileHost: unsupported,
    removeHost: unsupported,
    restartHost: unsupported,
  });
};

const testProtocol = AppProtocolRuntime.of({
  installed: true,
  authorizeHostFile: () => buildAppHostAssetUrl("authorized-host-image"),
  registerHostFileReader: () => Effect.void,
});

import { nodexDesktopToolMarketplaceName } from "../codex/bundled-desktop-tool-marketplace";

const runtimeStateHome = "/tmp/nodex-composer-test";
const managedBrowserPluginId = `browser@${nodexDesktopToolMarketplaceName(runtimeStateHome)}`;

const catalogLayer = (gateway: CodexGateway["Service"]) =>
  composerCatalogLive({ runtimeStateHome }).pipe(
    Layer.provide(
      Layer.merge(
        nativeOperationsLive({ runtimeStateHome }).pipe(
          Layer.provideMerge(Layer.succeed(CodexGateway, gateway)),
        ),
        Layer.succeed(AppProtocolRuntime, testProtocol),
      ),
    ),
  );

it.effect(
  "fails instead of looping or returning a partial catalog when a model cursor repeats",
  () =>
    Effect.gen(function* () {
      const requests: unknown[] = [];
      const requestLocal = ((method: string, params: unknown) => {
        if (method !== "model/list") return Effect.die(new Error(`Unexpected request: ${method}`));
        requests.push(params);
        return Effect.succeed({
          data: [
            {
              id: `model-${requests.length}`,
              model: `model-${requests.length}`,
              displayName: `Model ${requests.length}`,
              description: "Agent model",
              hidden: false,
              supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
              defaultReasoningEffort: "medium",
              inputModalities: ["text"],
              multiAgentVersion: "disabled",
              serviceTiers: [],
              defaultServiceTier: null,
              isDefault: requests.length === 1,
            },
          ],
          nextCursor: "models:repeated",
        });
      }) as CodexGateway["Service"]["requestLocal"];
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(catalogLayer(makeGateway(requestLocal)), scope);
      const result = yield* Context.get(context, ComposerCatalog).listModels.pipe(Effect.result);

      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(requests.length, 2);
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect("uninstalls only an unambiguous user plugin and verifies the installed inventory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const removed: string[] = [];
      let unavailable = false;
      const plugins = [
        { id: "same@one", name: "Same", installed: true },
        { id: "same@two", name: "Same", installed: true },
        { id: managedBrowserPluginId, name: "Browser", installed: true },
        { id: "browser@openai-bundled", name: "External Browser", installed: true },
      ];
      const request = ((method: string, params: unknown) =>
        Effect.sync(() => {
          if (method === "plugin/installed")
            return {
              marketplaces: [
                {
                  name: "test",
                  path: null,
                  interface: null,
                  plugins: plugins.filter((plugin) => !removed.includes(plugin.id)),
                },
              ],
              marketplaceLoadErrors: unavailable ? [{ message: "unavailable" }] : [],
            };
          if (method === "skills/list") return { data: [] };
          if (method === "plugin/uninstall") {
            removed.push((params as { pluginId: string }).pluginId);
            return {};
          }
          throw new Error(`Unexpected method ${method}`);
        })) as CodexGateway["Service"]["requestLocal"];
      const context = yield* Layer.build(catalogLayer(makeGateway(request)));
      const catalog = Context.get(context, ComposerCatalog);
      const input = { plugin: "Same", cwds: [], isCurrent: Effect.succeed(true) };
      assert.strictEqual((yield* catalog.uninstallPlugin(input)).status, "selection_required");
      assert.strictEqual(
        (yield* catalog.uninstallPlugin({ ...input, plugin: "Browser" })).status,
        "protected",
      );
      assert.strictEqual(
        (yield* catalog.uninstallPlugin({
          ...input,
          plugin: "same@one",
          isCurrent: Effect.succeed(false),
        })).status,
        "cancelled",
      );
      assert.deepStrictEqual(removed, []);
      assert.deepStrictEqual(yield* catalog.uninstallPlugin({ ...input, plugin: "same@one" }), {
        status: "uninstalled",
        pluginId: "same@one",
      });
      assert.strictEqual(
        (yield* catalog.uninstallPlugin({ ...input, plugin: "same@one" })).status,
        "not_installed",
      );
      assert.deepStrictEqual(
        yield* catalog.uninstallPlugin({ ...input, plugin: "browser@openai-bundled" }),
        {
          status: "uninstalled",
          pluginId: "browser@openai-bundled",
        },
      );
      unavailable = true;
      assert.strictEqual((yield* catalog.uninstallPlugin(input)).status, "inventory_unavailable");
      assert.deepStrictEqual(removed, ["same@one", "browser@openai-bundled"]);
    }),
  ),
);

it.effect("routes skill inventory and its icon paths to the selected host", () =>
  Effect.gen(function* () {
    const calls: Array<{ hostId: string; method: string; params: unknown }> = [];
    const remotePath = "C:\\skills\\PDF\\SKILL.md";
    const iconPath = "C:\\skills\\PDF\\icon.svg";
    const gateway = makeGateway(() => Effect.die("must not read local inventory"));
    const remoteGateway = CodexGateway.of({
      ...gateway,
      awaitReady: (hostId) => Effect.sync(() => assert.strictEqual(hostId, "remote-a")),
      requestOnHost: ((hostId: string, method: string, params: unknown) => {
        calls.push({ hostId, method, params });
        return Effect.succeed({
          data: [
            {
              cwd: "C:\\repo",
              errors: [],
              skills: [
                {
                  name: "PDF",
                  description: "Read PDFs",
                  path: remotePath,
                  scope: "user",
                  enabled: true,
                  interface: { iconSmall: iconPath },
                },
              ],
            },
          ],
        });
      }) as CodexGateway["Service"]["requestOnHost"],
    });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(catalogLayer(remoteGateway), scope);
    const catalog = Context.get(context, ComposerCatalog);
    const skills = yield* catalog.listSkills({
      hostId: "remote-a",
      cwds: ["C:\\repo"],
      forceReload: true,
    });
    assert.deepEqual(calls, [
      {
        hostId: "remote-a",
        method: "skills/list",
        params: { cwds: ["C:\\repo"], forceReload: true },
      },
    ]);
    assert.strictEqual(skills[0]?.path, remotePath);
    assert.strictEqual(skills[0]?.iconUrl, buildAppHostAssetUrl("authorized-host-image"));
    yield* Scope.close(scope, Exit.void);
  }),
);
