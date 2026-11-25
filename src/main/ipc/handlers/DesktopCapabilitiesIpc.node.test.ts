import { describe, vi, expect } from "vite-plus/test";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import type { IpcMainInvokeEvent } from "electron";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import { live, pluginCommandSchemas, pluginQuerySchemas } from "./PluginManagerIpc";
import { PluginManager } from "../../codex-application/PluginManager";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import {
  testLayer,
  testLayer as mainConfigLayer,
  MainConfig,
  testLayer as testMainConfig,
} from "../../app/MainConfig";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import type { PluginManagementChanged } from "../../../shared/codex-plugin-management";
import { live as liveMcpAppDataIpc } from "./McpAppDataIpc";
import { McpAppSandboxRuntime } from "../../host-runtime/McpAppSandboxRuntime";
import { McpAppSandboxDataError } from "../../mcp-app/mcp-app-sandbox-host";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { AppComponentsState } from "../../../shared/app-components";
import { isSpaceIpcChannel } from "../../../shared/space-ipc-policy";
import { AppComponents } from "../../app-components/AppComponents";
import { live as liveAppComponentsIpc } from "./AppComponentsIpc";
import type { OpenCodeSetupState } from "../../../shared/opencode-setup";
import { OpenCodeSetup } from "../../host-runtime/OpenCodeSetup";
import { live as liveOpenCodeSetupIpc } from "./OpenCodeSetupIpc";
import { hostCapabilities } from "../../../shared/host-capabilities";
import {
  ChromeControlRuntime,
  ChromeControlRuntimeError,
} from "../../host-runtime/ChromeControlRuntime";
import {
  live as liveChromeControlSettingsIpc,
  ChromeControlSettingsIpcError,
} from "./ChromeControlSettingsIpc";
import { CHANGELOG_PAGE_URL, type ChangelogFeed } from "../../../shared/changelog-feed";
import { ChangelogFeedRuntime } from "../../host-runtime/ChangelogFeedRuntime";
import { live as liveChangelogFeedIpc } from "./ChangelogFeedIpc";

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  protocol: {},
  BrowserWindow: { fromWebContents: () => ({}) },
}));

describe("PluginManagerIpc", () => {
  type Handler = (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, unknown>;
  const event = (kind = "window"): IpcMainInvokeEvent => {
    const frame = { url: "http://localhost:5173" };
    return {
      senderFrame: frame,
      sender: { mainFrame: frame, getType: () => kind },
    } as unknown as IpcMainInvokeEvent;
  };
  it.effect("validates selector XOR and typed command booleans at ingress", () =>
    Effect.gen(function* () {
      const base = { hostId: "local", projectId: null, pluginName: "name" };
      assert.strictEqual(
        (yield* Schema.decodeUnknownEffect(pluginQuerySchemas["skill-contents"])({
          hostId: "local",
          projectId: null,
          recommendedSkillId: "sample",
        }).pipe(Effect.result))._tag,
        "Success",
      );
      assert.strictEqual(
        (yield* Schema.decodeUnknownEffect(pluginQuerySchemas["skill-contents"])({
          hostId: "local",
          projectId: null,
          recommendedSkillId: "sample",
          path: "/private/SKILL.md",
        }).pipe(Effect.result))._tag,
        "Failure",
      );
      for (const [command, input] of [
        ["folder-prepare", { folder: "relative" }],
        ["folder-install", { stagingId: "../unreviewed" }],
        ["folder-discard", { stagingId: "../unreviewed" }],
        [
          "set-project-scope",
          { pluginId: "fixture@local", scope: { kind: "projects", projectIds: [42] } },
        ],
      ] as const) {
        assert.equal(
          (yield* Schema.decodeUnknownEffect(pluginCommandSchemas[command])({
            ...base,
            ...input,
          }).pipe(Effect.result))._tag,
          "Failure",
        );
      }
      for (const input of [
        { ...base },
        { ...base, marketplacePath: "/catalog", remoteMarketplaceName: "remote" },
        { ...base, marketplacePath: null },
      ])
        assert.strictEqual(
          (yield* Schema.decodeUnknownEffect(pluginQuerySchemas.read)(input).pipe(Effect.result))
            ._tag,
          "Failure",
        );
      assert.strictEqual(
        (yield* Schema.decodeUnknownEffect(pluginQuerySchemas.read)({
          ...base,
          marketplacePath: "/catalog",
        }).pipe(Effect.result))._tag,
        "Success",
      );
      assert.strictEqual(
        (yield* Schema.decodeUnknownEffect(pluginCommandSchemas["set-enabled"])({
          hostId: "local",
          projectId: null,
          pluginId: "p",
          enabled: "false",
        }).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* Schema.decodeUnknownEffect(pluginCommandSchemas["plugin-mcp-enabled"])({
          ...base,
          marketplacePath: "/catalog",
          name: "server",
          enabled: true,
        }).pipe(Effect.result))._tag,
        "Success",
      );
      assert.strictEqual(
        (yield* Schema.decodeUnknownEffect(pluginCommandSchemas["plugin-mcp-enabled"])({
          ...base,
          marketplacePath: "/catalog",
          name: "server",
          enabled: "true",
        }).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* Schema.decodeUnknownEffect(pluginCommandSchemas["plugin-hooks-trust"])({
          ...base,
          marketplacePath: "/catalog",
          remoteMarketplaceName: "remote",
        }).pipe(Effect.result))._tag,
        "Failure",
      );
    }),
  );
  it.effect(
    "rejects untrusted senders before the owner and fans out host-qualified events to every window",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handlers = new Map<string, Handler>();
          const delivered: unknown[][] = [];
          const events = yield* PubSub.unbounded<PluginManagementChanged>();
          let reads = 0;
          let commands = 0;
          const missingSkill = {
            status: "failed",
            contents: null,
            files: [],
            error: {
              code: "not_found",
              message: "The skill was not found in the current inventory.",
              retryable: false,
            },
          } satisfies import("../../../shared/codex-plugin-settings").SkillContentsResult;
          const manager = PluginManager.of({
            loadCatalog: () => Effect.die("Unexpected Session plugin catalog read"),
            catalogInvalidations: Stream.empty,
            changes: Stream.fromPubSub(events),
            query: (name) =>
              Effect.sync(() => {
                reads++;
                if (name === "skill-contents") return missingSkill as never;
                return {} as never;
              }),
            command: () =>
              Effect.sync(() => {
                commands++;
                return {} as never;
              }),
          });
          const ipc = makeTestElectronIpc({
            handle: (channel, handler) =>
              Effect.sync(() => {
                handlers.set(channel, handler as Handler);
              }),
            on: () => Effect.void,
          });
          const window = () => ({
            isDestroyed: () => false,
            webContents: {
              isDestroyed: () => false,
              send: (...args: unknown[]) => delivered.push(args),
            },
          });
          yield* Layer.build(
            live.pipe(
              Layer.provide(
                Layer.mergeAll(
                  testLayer({ rendererUrl: "http://localhost:5173" }),
                  Layer.succeed(ElectronIpc, ipc),
                  Layer.succeed(PluginManager, manager),
                  Layer.succeed(ElectronDesktop, {} as ElectronDesktop["Service"]),
                  Layer.succeed(WindowRuntime, {
                    all: () => [window(), window()],
                  } as unknown as WindowRuntime["Service"]),
                ),
              ),
            ),
          );
          assert.strictEqual(
            (yield* handlers.get("codex:plugins:installed")!(event("webview"), {
              hostId: "local",
              projectId: null,
            }).pipe(Effect.result))._tag,
            "Failure",
          );
          assert.strictEqual(reads, 0);
          yield* handlers.get("codex:plugins:installed")!(event(), {
            hostId: "local",
            projectId: null,
          });
          assert.strictEqual(reads, 1);
          assert.deepEqual(
            yield* handlers.get("codex:plugins:skill-contents")!(event(), {
              hostId: "local",
              projectId: null,
              path: "/unknown/SKILL.md",
            }),
            missingSkill,
          );
          const command = handlers.get("codex:plugins:mcp-enabled")!;
          const invalid = yield* command(event(), {
            hostId: "local",
            projectId: null,
            name: "server",
            enabled: "false",
          });
          assert.strictEqual((invalid as { error: { code: string } }).error.code, "invalid_input");
          const denied = yield* command(event("webview"), {
            hostId: "local",
            projectId: null,
            name: "server",
            enabled: false,
          });
          assert.strictEqual((denied as { error: { code: string } }).error.code, "policy_denied");
          assert.strictEqual(commands, 0);
          const change: PluginManagementChanged = {
            hostId: "local",
            accountEpoch: 1,
            kind: "skills",
          };
          yield* PubSub.publish(events, change);
          yield* Effect.yieldNow;
          assert.deepStrictEqual(delivered, [
            ["codex:plugins:changed", change],
            ["codex:plugins:changed", change],
          ]);
        }),
      ),
  );
});

describe("McpAppDataIpc", () => {
  type Handler = (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, unknown>;
  const event = (kind = "window"): IpcMainInvokeEvent => {
    const frame = { url: "http://localhost:5173" };
    return {
      sender: { getType: () => kind, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
  };
  const make = Effect.fn("McpAppDataIpcTest.make")(function* (failure?: "failed" | "unavailable") {
    const handlers = new Map<string, Handler>();
    let clears = 0;
    const ipc = makeTestElectronIpc({
      handle: (channel: string, handler: Handler) =>
        Effect.sync(() => {
          handlers.set(channel, handler);
        }),
      on: () => Effect.void,
    });
    yield* Layer.build(
      liveMcpAppDataIpc.pipe(
        Layer.provide(
          Layer.mergeAll(
            testLayer({ rendererUrl: "http://localhost:5173" }),
            Layer.succeed(ElectronIpc, ipc),
            Layer.succeed(McpAppSandboxRuntime, {
              appDataAvailable: () => failure !== "unavailable",
              clearAppData: Effect.suspend(() => {
                clears++;
                return failure
                  ? Effect.fail(new McpAppSandboxDataError({ reason: failure }))
                  : Effect.void;
              }),
            } as unknown as McpAppSandboxRuntime["Service"]),
          ),
        ),
      ),
    );
    return { handlers, clears: () => clears };
  });
  const context = { hostId: "local", projectId: null };
  it.effect(
    "clears Profile-wide app data through trusted typed IPC without requiring agent authentication",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* make();
          const capability = h.handlers.get("mcp-app:data:capabilities")!;
          const clear = h.handlers.get("mcp-app:data:clear")!;
          assert.deepEqual(yield* capability(event(), context), { available: true });
          assert.deepEqual(yield* capability(event(), { ...context, hostId: "remote" }), {
            available: false,
          });
          assert.deepEqual(yield* clear(event(), context), {
            status: "success",
            value: undefined,
            refreshFailures: [],
          });
          assert.strictEqual(h.clears(), 1);
          for (const [sender, input, code] of [
            [event("webview"), context, "policy_denied"],
            [event(), { ...context, hostId: "remote" }, "unsupported"],
            [event(), {}, "invalid_input"],
          ] as const) {
            const result = yield* clear(sender, input) as Effect.Effect<
              import("../../../shared/codex-plugin-management").PluginMutationResult,
              unknown
            >;
            assert.ok("error" in result);
            if ("error" in result) assert.strictEqual(result.error.code, code);
          }
          assert.strictEqual(h.clears(), 1);
        }),
      ),
  );
  it.effect("exposes unavailable capability and returns typed clearing failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const failure of ["failed", "unavailable"] as const) {
          const h = yield* make(failure);
          assert.deepEqual(yield* h.handlers.get("mcp-app:data:capabilities")!(event(), context), {
            available: failure !== "unavailable",
          });
          const result = yield* h.handlers.get("mcp-app:data:clear")!(
            event(),
            context,
          ) as Effect.Effect<
            import("../../../shared/codex-plugin-management").PluginMutationResult,
            unknown
          >;
          assert.strictEqual(result.status, "failed");
          if ("error" in result)
            assert.strictEqual(
              result.error.code,
              failure === "failed" ? "service_unavailable" : "unsupported",
            );
        }
      }),
    ),
  );
});

describe("AppComponentsIpc", () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Effect.Effect<unknown, unknown>;
  const event = (url = "app://-/index.html", subframe = false) => {
    const frame = { url };
    return {
      sender: { getType: () => "window", mainFrame: frame },
      senderFrame: subframe ? { ...frame } : frame,
    } as unknown as IpcMainInvokeEvent;
  };

  const snapshot: AppComponentsState = {
    revision: 1,
    components: [],
  };

  it.effect("authorizes component requests before admission and scope-owns the handlers", () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const calls: string[] = [];
      const scope = yield* Scope.make();
      const action = (name: string) =>
        Effect.sync(() => {
          calls.push(name);
          return snapshot;
        });
      const ipc = makeTestElectronIpc({
        handle: (channel: string, handler: Handler) =>
          Effect.acquireRelease(
            Effect.sync(() => handlers.set(channel, handler)),
            () => Effect.sync(() => handlers.delete(channel)),
          ).pipe(Effect.asVoid),
        on: () => Effect.void,
      });
      yield* Layer.buildWithScope(
        liveAppComponentsIpc.pipe(
          Layer.provide(
            Layer.mergeAll(
              mainConfigLayer(),
              Layer.succeed(ElectronIpc, ipc),
              Layer.succeed(
                AppComponents,
                AppComponents.of({
                  prefetchUpdate: () => Effect.void,
                  ensure: () => Effect.die("unexpected ensure"),
                  request: () => Effect.die("unexpected request"),
                  read: action("read"),
                  setEnabled: () => action("set-enabled"),
                  retry: () => action("retry"),
                  changes: Stream.empty,
                }),
              ),
              Layer.succeed(
                WindowRuntime,
                WindowRuntime.of({ all: () => [] } as unknown as WindowRuntime["Service"]),
              ),
            ),
          ),
        ),
        scope,
      );
      try {
        const operations = [
          ["read", []],
          ["set-enabled", [{ id: "desktop-tools", enabled: false }]],
          ["retry", ["desktop-tools"]],
        ] as const;
        for (const [operation, args] of operations) {
          const channel = `app-components:${operation}` as const;
          assert.isFalse(isSpaceIpcChannel(channel));
          const handler = handlers.get(channel);
          assert.isDefined(handler);
          for (const untrusted of [event("https://example.com"), event(undefined, true)]) {
            assert.isTrue(Exit.isFailure(yield* Effect.exit(handler!(untrusted, ...args))));
          }
          assert.deepEqual(yield* handler!(event(), ...args), snapshot);
        }
        for (const [operation, invalid] of [
          ["set-enabled", { id: "desktop-tools", enabled: "false" }],
          ["retry", "unknown-component"],
        ] as const) {
          const handler = handlers.get(`app-components:${operation}`)!;
          assert.isTrue(Exit.isFailure(yield* Effect.exit(handler(event(), invalid))));
        }
        assert.deepEqual(calls, ["read", "set-enabled", "retry"]);
      } finally {
        yield* Scope.close(scope, Exit.void);
      }
      assert.strictEqual(handlers.size, 0);
    }),
  );
});

describe("OpenCodeSetupIpc", () => {
  type Handler = (event: IpcMainInvokeEvent) => Effect.Effect<unknown, unknown>;
  const event = (url = "app://-/index.html", subframe = false) => {
    const frame = { url };
    return {
      sender: { getType: () => "window", mainFrame: frame },
      senderFrame: subframe ? { ...frame } : frame,
    } as unknown as IpcMainInvokeEvent;
  };

  const snapshot: OpenCodeSetupState = {
    revision: 1,
    supported: true,
    command: "official-installer",
    executable: { status: "missing" },
    installation: { phase: "idle" },
  };

  it.effect("authorizes every setup action before admission and scope-owns the handlers", () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const calls: string[] = [];
      const scope = yield* Scope.make();
      const action = (name: string) =>
        Effect.sync(() => {
          calls.push(name);
          return snapshot;
        });
      const ipc = makeTestElectronIpc({
        handle: (channel: string, handler: Handler) =>
          Effect.acquireRelease(
            Effect.sync(() => handlers.set(channel, handler)),
            () => Effect.sync(() => handlers.delete(channel)),
          ).pipe(Effect.asVoid),
        on: () => Effect.void,
      });
      yield* Layer.buildWithScope(
        liveOpenCodeSetupIpc.pipe(
          Layer.provide(
            Layer.mergeAll(
              mainConfigLayer(),
              Layer.succeed(ElectronIpc, ipc),
              Layer.succeed(
                OpenCodeSetup,
                OpenCodeSetup.of({
                  read: action("read"),
                  install: action("install"),
                  cancel: action("cancel"),
                  changes: Stream.empty,
                }),
              ),
              Layer.succeed(
                WindowRuntime,
                WindowRuntime.of({ all: () => [] } as unknown as WindowRuntime["Service"]),
              ),
            ),
          ),
        ),
        scope,
      );
      try {
        for (const operation of ["read", "install", "cancel"]) {
          const handler = handlers.get(`opencode-setup:${operation}`);
          assert.isDefined(handler);
          for (const untrusted of [event("https://example.com"), event(undefined, true)]) {
            assert.isTrue(Exit.isFailure(yield* Effect.exit(handler!(untrusted))));
          }
          assert.deepEqual(yield* handler!(event()), snapshot);
        }
        assert.deepEqual(calls, ["read", "install", "cancel"]);
      } finally {
        yield* Scope.close(scope, Exit.void);
      }
      assert.strictEqual(handlers.size, 0);
    }),
  );
});

describe("ChromeControlSettingsIpc", () => {
  type Handler = (
    event: IpcMainInvokeEvent,
  ) => Effect.Effect<unknown, ChromeControlRuntimeError | ChromeControlSettingsIpcError>;

  it.effect("scope-owns Chrome settings IPC and rejects an untrusted sender before refresh", () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const ipc = makeTestElectronIpc({
        handle: (channel, handler) =>
          Effect.acquireRelease(
            Effect.sync(() => handlers.set(channel, handler as Handler)),
            () => Effect.sync(() => handlers.delete(channel)),
          ).pipe(Effect.asVoid),
        on: () => Effect.void,
      });
      let refreshCount = 0;
      const snapshot = {
        bundleSupported: true,
        extensionConnected: true,
        nativeHostInstalled: true,
        providerReady: true,
        reason: null,
        requested: true,
        revision: 1,
        status: "ready" as const,
      };
      const chrome = ChromeControlRuntime.of({
        available: () => true,
        changes: Stream.empty,
        focusPresentation: () => Effect.void,
        isConnectedInstance: () => true,
        refresh: Effect.sync(() => {
          refreshCount += 1;
          return snapshot;
        }),
        resolveBrowserIconPath: () => null,
        snapshot: () => snapshot,
      });
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        liveChromeControlSettingsIpc.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ElectronIpc, ipc),
              Layer.succeed(
                MainConfig,
                MainConfig.of({
                  capabilities: hostCapabilities("darwin", "arm64"),
                  assistantStreamingDebug: false,
                  appVersion: "test",
                  arch: "arm64",
                  argv: [],
                  composerAppshotHelperPath: null,
                  documentsPath: "/tmp/Documents",
                  environment: {},
                  environmentPath: null,
                  homeDirectory: "/tmp",
                  projectsDirectory: null,
                  isolatedRunId: null,
                  isDefaultApp: false,
                  isPackaged: false,
                  markdownModulePath: "/tmp/nodex_markdown_bg.wasm",
                  nodexHome: "/tmp/nodex-test",
                  profileSettingsPath: "/tmp/nodex-test/config.toml",
                  platform: "darwin",
                  projectRootPath: "/repo",
                  rendererUrl: "http://localhost:5173",
                  resourcesPath: "/resources",
                  runtimeBinaryPath: "/electron",
                }),
              ),
              Layer.succeed(ChromeControlRuntime, chrome),
              Layer.succeed(
                WindowRuntime,
                WindowRuntime.of({ all: () => [] } as unknown as WindowRuntime["Service"]),
              ),
            ),
          ),
        ),
        scope,
      );

      const handler = handlers.get("chrome-control-settings-get");
      assert.isDefined(handler);
      const unauthorized = yield* Effect.exit(handler!({} as IpcMainInvokeEvent));
      assert.isTrue(Exit.isFailure(unauthorized));
      assert.strictEqual(refreshCount, 0);

      yield* Scope.close(scope, Exit.void);
      assert.isFalse(handlers.has("chrome-control-settings-get"));
    }),
  );
});

describe("ChangelogFeedIpc", () => {
  function event(url: string, subframe = false): IpcMainInvokeEvent {
    const frame = { url };
    return {
      sender: { getType: () => "window", mainFrame: frame },
      senderFrame: subframe ? { ...frame } : frame,
    } as unknown as IpcMainInvokeEvent;
  }

  it.effect("reads the feed only for a trusted top-level renderer", () =>
    Effect.gen(function* () {
      type Handler = (event: IpcMainInvokeEvent) => Effect.Effect<unknown, unknown>;
      const handlers = new Map<string, Handler>();
      const ipc = makeTestElectronIpc({
        handle: (channel: string, handler: Handler) =>
          Effect.sync(() => {
            handlers.set(channel, handler);
          }),
        on: () => Effect.void,
      });
      const feed: ChangelogFeed = { schemaVersion: 1, url: CHANGELOG_PAGE_URL, releases: [] };
      const read = vi.fn(() => feed);
      yield* Layer.build(
        liveChangelogFeedIpc.pipe(
          Layer.provide(
            Layer.mergeAll(
              testMainConfig(),
              Layer.succeed(ElectronIpc, ipc),
              Layer.succeed(ChangelogFeedRuntime, { read: Effect.sync(read) }),
            ),
          ),
        ),
      );

      const handler = handlers.get("app:changelog:read")!;
      const trustedUrl = "app://-/index.html";
      expect(Exit.isFailure(yield* Effect.exit(handler(event("https://untrusted.test"))))).toBe(
        true,
      );
      expect(Exit.isFailure(yield* Effect.exit(handler(event(trustedUrl, true))))).toBe(true);
      expect(read).not.toHaveBeenCalled();
      expect(yield* handler(event(trustedUrl))).toEqual(feed);
    }),
  );
});
