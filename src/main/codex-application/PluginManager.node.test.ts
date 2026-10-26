import * as PubSub from "effect/PubSub";
import * as Fiber from "effect/Fiber";
import { StandaloneSkills } from "./StandaloneSkills";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import { PluginManager, live } from "./PluginManager";
import { live as nativeLive } from "./PluginNativeOperations";
import { PluginService } from "./PluginService";
import { ChatGptDesktop } from "./ChatGptDesktop";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexExecutionHostAuthState } from "../codex-runtime/CodexExecutionHostAuthState";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { AppProtocolRuntime } from "../host-runtime/AppProtocolRuntime";
import { pluginSummary } from "../../shared/test-fixtures/plugins";
import type { PluginSummary } from "../../shared/codex-plugin-management";
import type { Project } from "../../shared/types";
import { createPluginInventoryPolicy } from "./PluginInventoryPolicy";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";

const home = "/tmp/plugin-manager-tests";
const policy = createPluginInventoryPolicy(home);
const context = { hostId: "local", projectId: null } as const;
const unavailable = () => Effect.die("Unexpected test capability");
const make = (
  options: {
    plugins?: PluginSummary[];
    omitInventory?: boolean;
    failSkills?: boolean;
    failUninstall?: string;
    remoteSearch?: boolean;
    marketplaceName?: string;
    service?: PluginService["Service"];
    detailSkillPath?: string;
    detailSkills?: import("@nodex/codex-app-server-protocol/v2/SkillSummary").SkillSummary[];
    localSkills?: import("@nodex/codex-app-server-protocol/v2/SkillMetadata").SkillMetadata[];
    detailMcpServers?: string[];
    detailHooks?: import("@nodex/codex-app-server-protocol/v2/PluginHookSummary").PluginHookSummary[];
    configOverridden?: boolean;
    directoryErrors?: boolean;
    upgradePartial?: boolean;
    abortInstall?: boolean;
    config?: unknown;
    mcpStatuses?: unknown[];
    configWriteOk?: boolean;
    oauthUrl?: string;
    runtimeApps?: { id: string; runtimeName: string | null; enabled: boolean; callable: boolean }[];
    detailApps?: {
      id: string;
      name: string;
      description: string | null;
      installUrl: string | null;
      category: string | null;
    }[];
    accountMetadata?: unknown;
    events?: Stream.Stream<import("../codex-runtime/CodexEventHub").CodexEndpointEvent>;
    hooks?: import("@nodex/codex-app-server-protocol/v2/HookMetadata").HookMetadata[];
  } = {},
) => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const contentReads: string[] = [];
  const controller = new AbortController();
  let plugins = options.plugins ?? [
    pluginSummary({ id: "a@custom", name: "a" }),
    pluginSummary({ id: "b@custom", name: "b" }),
  ];
  let failUninstall = options.failUninstall;
  let interruptedInstall = false;
  let project: Pick<Project, "id" | "lifecycle" | "bindingRevision" | "sources"> | null = {
    id: "p",
    lifecycle: "active",
    bindingRevision: 3,
    sources: [
      { root: "/b", order: 2 },
      { root: "/a", order: 1 },
      { root: "/a", order: 3 },
    ],
  };
  let onRead: (() => void) | undefined;
  const inventory = () => ({
    marketplaces: options.omitInventory
      ? []
      : [
          {
            name: options.marketplaceName ?? "custom",
            path: "/marketplace.json",
            interface: null,
            plugins,
          },
        ],
    marketplaceLoadErrors: [],
  });
  const request = ((method: string, raw: unknown) =>
    Effect.suspend(() => {
      const params = raw as Record<string, unknown>;
      calls.push({ method, params });
      if (method === "plugin/installed") {
        onRead?.();
        return Effect.succeed(inventory());
      }
      if (method === "plugin/list")
        return Effect.succeed({
          ...inventory(),
          marketplaceLoadErrors: options.directoryErrors
            ? [{ marketplaceName: "broken", message: "Unavailable" }]
            : [],
          featuredPluginIds: [],
        });
      if (method === "plugin/read")
        return Effect.succeed({
          plugin: {
            summary:
              plugins.find(
                (plugin) =>
                  plugin.name === params.pluginName || plugin.remotePluginId === params.pluginName,
              ) ?? plugins[0],
            marketplaceName: "custom",
            marketplacePath: "/marketplace.json",
            description: "Description",
            skills:
              options.detailSkills ??
              (options.detailSkillPath
                ? [
                    {
                      name: "sample",
                      path: options.detailSkillPath,
                      description: "Sample",
                      shortDescription: null,
                      interface: null,
                      enabled: false,
                    },
                  ]
                : []),
            apps: options.detailApps ?? [],
            hooks: options.detailHooks ?? [],
            mcpServers: options.detailMcpServers ?? [],
            appTemplates: [],
            scheduledTasks: null,
            onboardingSkill: null,
            shareUrl: null,
          },
        });
      if (method === "plugin/install") {
        if (options.abortInstall) {
          controller.abort();
          return Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                interruptedInstall = true;
              }),
            ),
          );
        }
        plugins = plugins.map((plugin) =>
          plugin.name === params.pluginName
            ? { ...plugin, installed: true, enabled: true }
            : plugin,
        );
        return Effect.succeed({ authPolicy: "ON_USE", appsNeedingAuth: [] });
      }
      if (method === "plugin/uninstall") {
        if (params.pluginId === failUninstall)
          return Effect.fail(
            codexRuntimeError({ operation: "uninstall", reason: "request", retryable: false }),
          );
        plugins = plugins.filter((plugin) => plugin.id !== params.pluginId);
        return Effect.succeed({});
      }
      if (method === "skills/list")
        return options.failSkills
          ? Effect.fail(
              codexRuntimeError({ operation: "skills", reason: "request", retryable: false }),
            )
          : Effect.succeed({
              data: [
                {
                  cwd: "/",
                  errors: [],
                  skills: options.localSkills ?? [
                    {
                      name: "managed",
                      path: "/managed/SKILL.md",
                      scope: "user",
                      enabled: true,
                      description: "managed",
                      pluginId: `browser@${policy.marketplaceName}`,
                    },
                  ],
                },
              ],
            });
      if (method === "plugin/search")
        return Effect.succeed({
          data: [{ marketplaceName: "custom", marketplacePath: null, plugin: plugins[0] }],
          nextCursor: "opaque-next",
        });
      if (method === "plugin/skill/read") return Effect.succeed({ contents: "remote skill" });
      if (method === "app/installed") return Effect.succeed({ apps: options.runtimeApps ?? [] });
      if (method === "app/read")
        return Effect.succeed({
          apps: (params.appIds as string[]).map((id) => ({
            id,
            name: id,
            description: null,
            iconUrl: null,
            iconUrlDark: null,
            distributionChannel: null,
            installUrl: null,
            pluginDisplayNames: [],
            toolSummaries: null,
          })),
          missingAppIds: [],
        });
      if (method === "hooks/list")
        return Effect.succeed({
          data: [{ cwd: "/", hooks: options.hooks ?? [], warnings: [], errors: [] }],
        });
      if (method === "mcpServerStatus/list")
        return Effect.succeed({ data: options.mcpStatuses ?? [], nextCursor: null });
      if (method === "mcpServer/oauth/login")
        return Effect.succeed({
          authorizationUrl: options.oauthUrl ?? "https://example.com/oauth",
          loginId: "native-login",
        });
      if (method === "config/read")
        return Effect.succeed(
          options.config ?? {
            config: {
              marketplaces: { custom: { source_type: "git", source: "https://example.com/repo" } },
            },
            origins: {},
            layers: [
              {
                name: { type: "user", file: "/config.toml" },
                version: "v42",
                config: {
                  marketplaces: {
                    custom: { source_type: "git", source: "https://example.com/repo" },
                  },
                },
              },
            ],
          },
        );
      if (
        (method === "config/batchWrite" || method === "config/value/write") &&
        options.configWriteOk
      )
        return Effect.succeed({
          status: "ok",
          version: "next",
          filePath: "/config.toml",
          overriddenMetadata: null,
        });
      if (
        (method === "config/batchWrite" || method === "config/value/write") &&
        options.configOverridden
      )
        return Effect.succeed({
          status: "okOverridden",
          version: "v43",
          filePath: "/config.toml",
          overriddenMetadata: null,
        });
      if (method === "config/batchWrite" || method === "config/value/write")
        return Effect.fail(
          codexRuntimeError({ operation: "write", reason: "request", retryable: false }),
        );
      if (method === "marketplace/upgrade")
        return Effect.succeed({
          errors: [{ marketplaceName: "custom", message: "unavailable" }],
          selectedMarketplaces: ["custom"],
          upgradedRoots: options.upgradePartial ? ["/marketplaces/changed"] : [],
        });
      return Effect.succeed({});
    })) as CodexGateway["Service"]["requestLocal"];
  const gateway = CodexGateway.of({
    localHostId: "local",
    events: options.events ?? Stream.empty,
    promoteQueuedCatalogPage: Effect.succeed(false),
    requestLocal: request,
    requestOnHost: (_host, method, params) => request(method, params),
    awaitReady: () => Effect.void,
    connection: unavailable,
    connectionChanges: () => Stream.empty,
    requestRawOnHost: unavailable,
    requestRawForThread: unavailable,
    requestForThread: unavailable,
    notifyLocal: unavailable,
    reconcileHost: unavailable,
    removeHost: unavailable,
    restartHost: unavailable,
  });
  const capabilities = CodexAppServerCapabilities.of({
    forThread: unavailable,
    isCurrent: () => Effect.succeed(true),
    forHost: () =>
      Effect.succeed({
        hostId: "local",
        generation: 1,
        userAgent: "test",
        version: options.remoteSearch ? "0.0.0" : "0.146.0",
        nativeAppTools: false,
        flags: {} as never,
      }),
  });
  const service =
    options.service ??
    PluginService.of({
      access: Effect.succeed({
        publicHome: false,
        category: false,
        personal: false,
        shared: false,
        remoteToggle: false,
        workspace: false,
        workspaceCreated: false,
      }),
      home: unavailable(),
      category: unavailable,
      page: unavailable,
      setEnabled: unavailable,
    });
  const services = Layer.mergeAll(
    Layer.succeed(StandaloneSkills, {
      list: unavailable,
      install: unavailable,
      uninstall: unavailable,
      contents: (path: string) =>
        Effect.sync(() => {
          contentReads.push(path);
          return { contents: "contents", files: ["SKILL.md"] };
        }),
    }),
    Layer.succeed(CodexGateway, gateway),
    Layer.succeed(CodexAppServerCapabilities, capabilities),
    Layer.succeed(PluginService, service),
    Layer.succeed(CodexExecutionHostAuthState, {
      backendLease: () => Effect.succeed(controller.signal),
    } as unknown as CodexExecutionHostAuthState["Service"]),
    Layer.succeed(ProjectWorkspace, {
      getProject: () => Effect.sync(() => project as Project | null),
    } as unknown as ProjectWorkspace["Service"]),
    Layer.succeed(ChatGptDesktop, {
      authStatus: () =>
        Effect.succeed({
          authMethod: options.accountMetadata ? "chatgpt" : "apikey",
          authToken: options.accountMetadata
            ? `x.${Buffer.from(JSON.stringify({ exp: 9999999999, "https://api.openai.com/auth": { chatgpt_account_id: "account", user_id: "user" } })).toString("base64url")}.x`
            : null,
          requiresOpenaiAuth: true,
        }),
      request: () => Effect.succeed(Response.json(options.accountMetadata ?? {})),
    } as unknown as ChatGptDesktop["Service"]),
    Layer.succeed(AppProtocolRuntime, {
      installed: true,
      authorizeHostFile: () => "app://authorized",
      registerHostFileReader: () => Effect.void,
    }),
    Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.makeNoop({ readFileString: () => Effect.succeed("contents") }),
    ),
  );
  const layer = live({ runtimeStateHome: home, codexHome: "/native-home" }).pipe(
    Layer.provide(
      Layer.merge(services, nativeLive({ runtimeStateHome: home }).pipe(Layer.provide(services))),
    ),
  );
  return {
    layer,
    calls,
    contentReads,
    controller,
    setProject: (value: typeof project) => {
      project = value;
    },
    setOnRead: (callback: () => void) => {
      onRead = callback;
    },
    installInterrupted: () => interruptedInstall,
    allowUninstall: () => {
      failUninstall = undefined;
    },
    addPlugin: (plugin: PluginSummary) => {
      plugins.push(plugin);
    },
  };
};
const withManager = <A>(
  harness: ReturnType<typeof make>,
  run: (manager: PluginManager["Service"]) => Effect.Effect<A, unknown>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(harness.layer);
      return yield* run(Context.get(services, PluginManager));
    }),
  );

it.effect(
  "resolves ordered durable Project roots and rejects unavailable Projects and nonlocal hosts",
  () => {
    const h = make();
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        const result = yield* manager.query("installed", { ...context, projectId: "p" });
        assert.deepStrictEqual(result.context.cwds, ["/a", "/b"]);
        assert.deepStrictEqual(
          h.calls.find((call) => call.method === "plugin/installed")?.params.cwds,
          ["/a", "/b"],
        );
        h.setProject(null);
        assert.strictEqual(
          (yield* manager.query("installed", { ...context, projectId: "p" }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        const count = h.calls.length;
        assert.strictEqual(
          (yield* manager
            .query("installed", { hostId: "remote", projectId: null })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(h.calls.length, count);
      }),
    );
  },
);
it.effect("discards responses after Project revision or account lifetime changes", () => {
  const h = make();
  return withManager(h, (manager) =>
    Effect.gen(function* () {
      h.setOnRead(() => h.controller.abort());
      const result = yield* manager.query("installed", context).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure.code, "account_changed");
    }),
  );
});
it.effect(
  "protects managed plugins through IDs, alternate remote identities, skill paths and source marketplace removal",
  () => {
    const id = `browser@${policy.marketplaceName}`;
    const h = make({
      plugins: [pluginSummary({ id, name: "browser", remotePluginId: "alternate" })],
    });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        for (const pluginId of [id, "alternate"]) {
          assert.strictEqual(
            (yield* manager.command("uninstall", { ...context, pluginId })).status,
            "protected",
          );
          assert.strictEqual(
            (yield* manager.command("set-enabled", { ...context, pluginId, enabled: false }))
              .status,
            "protected",
          );
        }
        assert.strictEqual(
          (yield* manager.command("install", {
            ...context,
            marketplacePath: "/marketplace.json",
            pluginName: "browser",
            installAttemptId: "attempt",
          })).status,
          "protected",
        );
        assert.strictEqual(
          (yield* manager.command("skill-enabled", {
            ...context,
            path: "/managed/SKILL.md",
            enabled: false,
          })).status,
          "protected",
        );
        assert.strictEqual(
          (yield* manager.command("marketplace-remove", {
            ...context,
            marketplaceName: policy.marketplaceName,
          })).outcome.status,
          "protected",
        );
        assert.strictEqual(
          h.calls.some((call) =>
            [
              "plugin/install",
              "plugin/uninstall",
              "skills/config/write",
              "config/batchWrite",
              "marketplace/remove",
            ].includes(call.method),
          ),
          false,
        );
      }),
    );
  },
);
it.effect(
  "retains a successful install when the skills refresh fails and forwards the install attempt ID",
  () => {
    const h = make({
      failSkills: true,
      plugins: [pluginSummary({ name: "a", id: "a@custom", installed: false })],
    });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        const result = yield* manager.command("install", {
          ...context,
          marketplacePath: "/marketplace.json",
          pluginName: "a",
          installAttemptId: "attempt-42",
        });
        assert.strictEqual(result.status, "success-with-refresh-warning");
        if (result.status === "success-with-refresh-warning")
          assert.deepStrictEqual(result.refreshFailures, ["skills"]);
        assert.strictEqual(
          h.calls.find((call) => call.method === "plugin/install")?.params.installAttemptId,
          "attempt-42",
        );
        assert.strictEqual(
          (yield* manager.query("installed", context)).rows[0]?.summary.installed,
          true,
        );
      }),
    );
  },
);
it.effect(
  "stops sequential marketplace removal at a failure and resumes without repeating the completed prefix",
  () => {
    const h = make({ failUninstall: "b@custom" });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        const first = yield* manager.command("marketplace-remove", {
          ...context,
          marketplaceName: "custom",
        });
        assert.strictEqual(first.removed, false);
        assert.deepStrictEqual(first.completedPluginIds, ["a@custom"]);
        assert.deepStrictEqual(first.remainingPluginIds, ["b@custom"]);
        assert.strictEqual(
          h.calls.some((call) => call.method === "marketplace/remove"),
          false,
        );
        h.allowUninstall();
        const second = yield* manager.command("marketplace-remove", {
          ...context,
          marketplaceName: "custom",
          operationId: first.operationId,
        });
        assert.strictEqual(second.removed, true);
        assert.deepStrictEqual(second.completedPluginIds, ["a@custom", "b@custom"]);
        assert.deepStrictEqual(
          h.calls
            .filter((call) => call.method === "plugin/uninstall")
            .map((call) => call.params.pluginId),
          ["a@custom", "b@custom", "b@custom"],
        );
        assert.strictEqual(
          h.calls.at(-6)?.method === "marketplace/remove" ||
            h.calls.some((call) => call.method === "marketplace/remove"),
          true,
        );
      }),
    );
  },
);
it.effect(
  "uses the observed config version with omitted optional layer metadata and preserves conflicts",
  () => {
    const h = make();
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        const result = yield* manager.command("set-enabled", {
          ...context,
          pluginId: "a@custom",
          enabled: false,
        });
        assert.strictEqual(result.status, "failed");
        if (result.status === "failed") assert.strictEqual(result.error.code, "config_conflict");
        assert.strictEqual(
          h.calls.find((call) => call.method === "config/batchWrite")?.params.expectedVersion,
          "v42",
        );
      }),
    );
  },
);
it.effect(
  "uses native search only when auth and version allow it and forwards opaque cursors",
  () => {
    const h = make({ remoteSearch: true });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        const result = yield* manager.query("search", {
          ...context,
          term: " ranked ",
          cursor: "opaque-in",
          scope: "personal",
        });
        assert.strictEqual(result.nextCursor, "opaque-next");
        assert.strictEqual(
          h.calls.find((call) => call.method === "plugin/search")?.params.scope,
          "personal",
        );
        assert.strictEqual(
          h.calls.find((call) => call.method === "plugin/search")?.params.cursor,
          "opaque-in",
        );
      }),
    );
  },
);
it.effect(
  "falls back to truthful local sections and filtering when HTTP and native search are unavailable",
  () => {
    const h = make({
      marketplaceName: "codex-official",
      plugins: [
        pluginSummary({ id: "example@codex-official", name: "example", keywords: ["local-key"] }),
      ],
    });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        const home = yield* manager.query("public-home", context);
        assert.strictEqual(home.source, "local");
        assert.deepStrictEqual(
          home.sections.map((section) => section.title),
          ["Other"],
        );
        const results = yield* manager.query("search", { ...context, term: "local key" });
        assert.strictEqual(results.rows.length, 1);
        assert.strictEqual(
          h.calls.some((call) => call.method === "plugin/search"),
          false,
        );
      }),
    );
  },
);
it.effect("reports marketplace upgrade errors as a failed partial operation", () => {
  const h = make();
  return withManager(h, (manager) =>
    Effect.gen(function* () {
      const result = yield* manager.command("marketplace-upgrade", {
        ...context,
        marketplaceName: "custom",
      });
      assert.strictEqual(result.status, "failed");
    }),
  );
});

it.effect("keeps independent created-feed cursors and skips an exhausted user feed", () => {
  const calls: { feed: string; cursor?: string | null; limit: number }[] = [];
  const service = PluginService.of({
    access: Effect.succeed({
      publicHome: true,
      category: true,
      personal: true,
      shared: true,
      remoteToggle: true,
      workspace: true,
      workspaceCreated: true,
    }),
    home: unavailable(),
    category: unavailable,
    page: (input) =>
      Effect.sync(() => {
        calls.push(input);
        const workspace = input.feed === "workspace-created";
        return {
          plugins: [
            {
              id: workspace ? `workspace-${input.cursor ?? "first"}` : "user-first",
              display_name: "Plugin",
            },
          ],
          pagination: {
            next_page_token: workspace && input.cursor == null ? "workspace-next" : null,
          },
        };
      }),
    setEnabled: unavailable,
  });
  const h = make({ service });
  return withManager(h, (manager) =>
    Effect.gen(function* () {
      const first = yield* manager.query("personal-page", { ...context, feed: "created" });
      assert.deepStrictEqual(first.nextCursor, {
        workspaceCreatedPageToken: "workspace-next",
        userPageToken: null,
      });
      assert.deepStrictEqual(
        first.rows.map((row) => row.stableIdentity),
        ["workspace-first", "user-first"],
      );
      const second = yield* manager.query("personal-page", {
        ...context,
        feed: "created",
        cursor: first.nextCursor,
      });
      assert.strictEqual(second.nextCursor, null);
      assert.deepStrictEqual(calls, [
        { feed: "workspace-created", limit: 50, cursor: undefined },
        { feed: "user", limit: 50, cursor: undefined },
        { feed: "workspace-created", limit: 50, cursor: "workspace-next" },
      ]);
    }),
  );
});
it.effect("rejects responses whose Project binding revision changed during the native read", () => {
  const h = make();
  return withManager(h, (manager) =>
    Effect.gen(function* () {
      h.setOnRead(() =>
        h.setProject({
          id: "p",
          lifecycle: "active",
          bindingRevision: 4,
          sources: [{ root: "/new", order: 0 }],
        }),
      );
      const result = yield* manager
        .query("installed", { ...context, projectId: "p" })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure.code, "project_unavailable");
    }),
  );
});
it.effect(
  "blocks a resumed marketplace removal when a required plugin was installed in the meantime",
  () => {
    const h = make({ failUninstall: "b@custom" });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        const first = yield* manager.command("marketplace-remove", {
          ...context,
          marketplaceName: "custom",
        });
        h.addPlugin(pluginSummary({ id: `browser@${policy.marketplaceName}`, name: "browser" }));
        h.allowUninstall();
        const second = yield* manager.command("marketplace-remove", {
          ...context,
          marketplaceName: "custom",
          operationId: first.operationId,
        });
        assert.strictEqual(second.outcome.status, "protected");
        assert.deepStrictEqual(second.completedPluginIds, ["a@custom"]);
        assert.strictEqual(
          h.calls.some((call) => call.method === "marketplace/remove"),
          false,
        );
      }),
    );
  },
);

it.effect("authorizes disabled plugin skill previews through current plugin details", () => {
  const h = make({
    detailSkillPath: "/plugins/a/skills/sample/SKILL.md",
    plugins: [pluginSummary({ id: "a@custom", name: "a", enabled: false })],
  });
  return withManager(h, (manager) =>
    Effect.gen(function* () {
      yield* manager.query("read", {
        ...context,
        marketplacePath: "/marketplace.json",
        pluginName: "a",
      });
      const result = yield* manager.query("skill-contents", {
        ...context,
        path: "/plugins/a/skills/sample/SKILL.md",
      });
      assert.strictEqual(result.contents, "contents");
      assert.strictEqual(
        h.calls.some((call) => call.method === "plugin/read"),
        true,
      );
      const denied = yield* manager.query("skill-contents", {
        ...context,
        path: "/private/unrelated/SKILL.md",
      });
      assert.strictEqual(denied.status, "failed");
      if (denied.status === "failed") assert.strictEqual(denied.error.code, "not_found");
      assert.deepEqual(h.contentReads, ["/plugins/a/skills/sample/SKILL.md"]);
    }),
  );
});

it.effect(
  "forces skill reload for every observed Project root set after a home-wide installation",
  () => {
    const h = make({ plugins: [pluginSummary({ id: "a@custom", name: "a", installed: false })] });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        h.setProject({
          id: "one",
          lifecycle: "active",
          bindingRevision: 1,
          sources: [{ root: "/one", order: 0 }],
        });
        yield* manager.query("skills", { hostId: "local", projectId: "one" });
        h.setProject({
          id: "two",
          lifecycle: "active",
          bindingRevision: 1,
          sources: [{ root: "/two", order: 0 }],
        });
        yield* manager.query("skills", { hostId: "local", projectId: "two" });
        h.setProject({
          id: "one",
          lifecycle: "active",
          bindingRevision: 1,
          sources: [{ root: "/one", order: 0 }],
        });
        yield* manager.command("install", {
          hostId: "local",
          projectId: "one",
          marketplacePath: "/marketplace.json",
          pluginName: "a",
          installAttemptId: "a",
        });
        assert.deepStrictEqual(
          h.calls
            .filter((call) => call.method === "skills/list" && call.params.forceReload === true)
            .map((call) => call.params.cwds),
          [["/one"], ["/two"]],
        );
      }),
    );
  },
);

it.effect(
  "reports a policy denial when native configuration overrides the requested enablement",
  () => {
    const h = make({ configOverridden: true });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        const result = yield* manager.command("set-enabled", {
          ...context,
          pluginId: "a@custom",
          enabled: false,
        });
        assert.strictEqual(result.status, "policy_denied");
      }),
    );
  },
);

it.effect(
  "cannot mutate a marketplace whose protected desktop copies are hidden from presentation",
  () => {
    const h = make({ plugins: [pluginSummary({ id: "browser@openai-bundled", name: "browser" })] });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        assert.strictEqual((yield* manager.query("list", context)).rows.length, 0);
        assert.strictEqual(
          (yield* manager.command("marketplace-remove", { ...context, marketplaceName: "custom" }))
            .outcome.status,
          "protected",
        );
        assert.strictEqual(
          (yield* manager.command("marketplace-upgrade", { ...context, marketplaceName: "custom" }))
            .status,
          "protected",
        );
        assert.strictEqual(
          h.calls.some(
            (call) => call.method === "marketplace/remove" || call.method === "marketplace/upgrade",
          ),
          false,
        );
      }),
    );
  },
);

it.effect(
  "retains install success with a refresh warning when a marketplace cannot be loaded",
  () => {
    const h = make({
      directoryErrors: true,
      plugins: [pluginSummary({ name: "a", id: "a@custom", installed: false })],
    });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        const result = yield* manager.command("install", {
          ...context,
          marketplacePath: "/marketplace.json",
          pluginName: "a",
          installAttemptId: "a",
        });
        assert.strictEqual(result.status, "success-with-refresh-warning");
        if (result.status === "success-with-refresh-warning")
          assert.deepStrictEqual(result.refreshFailures, ["plugins"]);
      }),
    );
  },
);
it.effect(
  "refreshes skills after a partial upgrade while retaining structured upgrade failures",
  () => {
    const h = make({ upgradePartial: true });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        const result = yield* manager.command("marketplace-upgrade", {
          ...context,
          marketplaceName: "custom",
        });
        assert.strictEqual(result.status, "failed");
        if (result.status === "failed")
          assert.strictEqual(result.error.marketplaceErrors?.length, 1);
        assert.strictEqual(
          h.calls.some((call) => call.method === "skills/list" && call.params.forceReload === true),
          true,
        );
      }),
    );
  },
);

it.effect(
  "preserves service installation policy, auth policy and an explicit interstitial opt-out",
  () => {
    const service = PluginService.of({
      access: Effect.succeed({
        publicHome: true,
        category: true,
        personal: false,
        shared: false,
        remoteToggle: true,
        workspace: false,
        workspaceCreated: false,
      }),
      home: Effect.succeed({
        sections: [
          {
            id: "public",
            title: "Public",
            url_slug: null,
            plugins: [
              {
                id: "remote",
                display_name: "Remote",
                installation_policy: "INSTALLED_BY_DEFAULT",
                installation_policy_source: "IMPLICIT_CANONICAL_APP",
                must_show_installation_interstitial: false,
                authentication_policy: "ON_INSTALL",
                eligible_plan_types: ["pro"],
              },
            ],
          },
        ],
      }),
      category: unavailable,
      page: unavailable,
      setEnabled: unavailable,
    });
    const h = make({ service });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        const home = yield* manager.query("public-home", context);
        const summary = home.sections[0]!.plugins[0]!.summary;
        assert.strictEqual(summary.mustShowInstallationInterstitial, false);
        assert.strictEqual(summary.authPolicy, "ON_INSTALL");
        assert.strictEqual(summary.installPolicySource, "IMPLICIT_CANONICAL_APP");
        assert.deepStrictEqual(summary.eligiblePlanTypes, ["pro"]);
      }),
    );
  },
);

it.effect("cancels an in-flight native mutation when its captured account lease is revoked", () => {
  const h = make({
    abortInstall: true,
    plugins: [pluginSummary({ id: "a@custom", name: "a", installed: false })],
  });
  return withManager(h, (manager) =>
    Effect.gen(function* () {
      const result = yield* manager.command("install", {
        ...context,
        marketplacePath: "/marketplace.json",
        pluginName: "a",
        installAttemptId: "a",
      });
      assert.strictEqual(result.status, "failed");
      if (result.status === "failed") assert.strictEqual(result.error.code, "account_changed");
      assert.strictEqual(h.installInterrupted(), true);
      assert.strictEqual(h.calls.filter((call) => call.method === "plugin/install").length, 1);
    }),
  );
});

it.effect(
  "authorizes local skill previews before installation through the visible native catalog",
  () => {
    const path = "/plugins/a/skills/sample/SKILL.md";
    const h = make({
      detailSkillPath: path,
      omitInventory: true,
      plugins: [pluginSummary({ id: "a@custom", name: "a", installed: false })],
    });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        yield* manager.query("read", {
          ...context,
          remoteMarketplaceName: "custom",
          pluginName: "a",
        });
        assert.strictEqual(
          (yield* manager.query("skill-contents", { ...context, path })).contents,
          "contents",
        );
        assert.deepEqual(h.contentReads, [path]);
        assert.strictEqual(h.calls.filter((call) => call.method === "plugin/read").length, 2);
        assert.deepEqual(h.calls.filter((call) => call.method === "plugin/read").at(-1)?.params, {
          marketplacePath: null,
          remoteMarketplaceName: "custom",
          pluginName: "a",
        });
        assert.strictEqual(
          h.calls.some(
            (call) => call.method === "plugin/list" || call.method === "plugin/installed",
          ),
          false,
        );
      }),
    );
  },
);

const settingsConfig = (mcp: Record<string, unknown> = {}) => ({
  config: {
    mcp_servers: mcp,
    marketplaces: {
      custom: { source_type: "git", source: "https://example.com/plugins", ref: "stable" },
      "openai-bundled": { source_type: "local", source: "/bundled" },
    },
  },
  origins: {},
  layers: [
    {
      name: { type: "user", file: "/config.toml" },
      version: "observed",
      config: {
        mcp_servers: mcp,
        marketplaces: {
          custom: { source_type: "git", source: "https://example.com/plugins" },
          "openai-bundled": { source_type: "local", source: "/bundled" },
        },
      },
    },
  ],
});
it.effect("derives configured marketplace sources and protects built-in catalogs", () => {
  const h = make({ config: settingsConfig() });
  return Effect.gen(function* () {
    const manager = yield* PluginManager;
    const view = yield* manager.query("marketplaces", context);
    assert.deepEqual(
      view.marketplaces.map((m) => [
        m.name,
        m.sourceType,
        m.canRemove,
        m.canUpgrade,
        m.pluginCount,
      ]),
      [
        ["custom", "git", true, true, 2],
        ["openai-bundled", "local", false, false, 0],
      ],
    );
    assert.strictEqual(view.marketplaces[0]?.refName, "stable");
    const removal = yield* manager.query("marketplace-removal-preview", {
      ...context,
      marketplaceName: "custom",
      marketplacePath: "/marketplace.json",
    });
    assert.deepEqual(
      removal.plugins?.map((plugin) => plugin.nativeId),
      ["a@custom", "b@custom"],
    );
    assert.strictEqual(
      (yield* manager.command("marketplace-remove", {
        ...context,
        marketplaceName: "openai-bundled",
      })).outcome.status,
      "protected",
    );
  }).pipe(Effect.provide(h.layer));
});
it.effect(
  "writes MCP edits against the observed user config version and retains unrelated servers",
  () => {
    const h = make({
      config: settingsConfig({
        existing: { command: "node", args: ["server.js"] },
        unrelated: { url: "https://other.test/mcp" },
      }),
      configWriteOk: true,
    });
    return Effect.gen(function* () {
      const manager = yield* PluginManager;
      const result = yield* manager.command("mcp-save", {
        ...context,
        previousName: "existing",
        name: "renamed.with.dot",
        declaration: { command: "python", args: ["server.py"], env: { TOKEN_ENV: "from-config" } },
      });
      assert.strictEqual(result.status, "success");
      const write = h.calls.find((call) => call.method === "config/batchWrite");
      assert.strictEqual(write?.params.expectedVersion, "observed");
      assert.deepEqual(write?.params.edits, [
        {
          keyPath: "mcp_servers",
          mergeStrategy: "replace",
          value: {
            unrelated: { url: "https://other.test/mcp" },
            "renamed.with.dot": {
              command: "python",
              args: ["server.py"],
              env: { TOKEN_ENV: "from-config" },
            },
          },
        },
      ]);
      assert.strictEqual(
        (yield* manager.command("mcp-enabled", { ...context, name: "unrelated", enabled: false }))
          .status,
        "success",
      );
    }).pipe(Effect.provide(h.layer));
  },
);
it.effect("keeps plugin MCP declarations read-only and validates OAuth authorization URLs", () => {
  const h = make({
    config: settingsConfig(),
    mcpStatuses: [{ name: "plugin-server", pluginId: "a@custom", authStatus: "notLoggedIn" }],
    oauthUrl: "javascript:bad",
  });
  return Effect.gen(function* () {
    const manager = yield* PluginManager;
    const view = yield* manager.query("mcp-servers", context);
    assert.strictEqual(view.servers[0]?.readOnly, true);
    assert.strictEqual(
      (yield* manager.command("mcp-remove", { ...context, name: "plugin-server" })).status,
      "protected",
    );
    const login = yield* manager.command("mcp-login", {
      ...context,
      name: "plugin-server",
      clientRegistration: "dcr",
    });
    assert.strictEqual(login.status, "failed");
    assert.strictEqual(
      h.calls.find((call) => call.method === "mcpServer/oauth/login")?.params.clientRegistration,
      "dcr",
    );
    assert.strictEqual(
      h.calls.some((call) => call.method === "config/batchWrite"),
      false,
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "prepares the official recording helper and preserves the caller's install attempt",
  () => {
    const h = make({
      marketplaceName: "openai-curated",
      plugins: [
        pluginSummary({
          id: "record-and-replay@openai-curated",
          name: "record-and-replay",
          installed: false,
          enabled: false,
        }),
      ],
    });
    return Effect.gen(function* () {
      const manager = yield* PluginManager;
      assert.strictEqual(
        (yield* manager.query("creation-capabilities", context)).recordSkill.available,
        true,
      );
      const result = yield* manager.command("prepare-helper", {
        ...context,
        helper: "record-and-replay",
        installAttemptId: "caller-attempt",
      });
      assert.ok("value" in result);
      if (!("value" in result)) return;
      assert.strictEqual(result.value.nativeId, "record-and-replay@openai-curated");
      assert.ok(result.value.draft.includes("plugin://record-and-replay@openai-curated"));
      assert.strictEqual(
        h.calls.find((call) => call.method === "plugin/install")?.params.installAttemptId,
        "caller-attempt",
      );
    }).pipe(Effect.provide(h.layer));
  },
);
it.effect("requires callable creator apps before returning an unsent creation draft", () => {
  const plugin = pluginSummary({ id: "plugin_creator@openai-curated", name: "plugin_creator" });
  const h = make({ marketplaceName: "openai-curated", plugins: [plugin] });
  return Effect.gen(function* () {
    const manager = yield* PluginManager;
    const result = yield* manager.command("prepare-helper", {
      ...context,
      helper: "plugin-creator",
      installAttemptId: "creator-attempt",
    });
    assert.ok("error" in result);
    if (!("error" in result)) return;
    assert.strictEqual(result.error.code, "auth_required");
  }).pipe(Effect.provide(h.layer));
});
it.effect("returns Plugin Creator's native ID only after native callability is verified", () => {
  const h = make({
    marketplaceName: "openai-curated",
    plugins: [pluginSummary({ id: "plugin_creator@openai-curated", name: "plugin_creator" })],
    runtimeApps: [
      {
        id: "connector_openai_plugin_creator",
        runtimeName: "Plugin Creator",
        enabled: true,
        callable: true,
      },
    ],
  });
  return Effect.gen(function* () {
    const manager = yield* PluginManager;
    const result = yield* manager.command("prepare-helper", {
      ...context,
      helper: "plugin-creator",
      installAttemptId: "creator-attempt",
    });
    assert.ok("value" in result);
    if (!("value" in result)) return;
    assert.strictEqual(
      result.value.draft,
      "[@Plugin Creator](plugin://plugin_creator@openai-curated) help me create a plugin",
    );
    const impostor = make({
      marketplaceName: "third-party",
      plugins: [pluginSummary({ id: "record-and-replay@third-party", name: "record-and-replay" })],
    });
    assert.strictEqual(
      (yield* Effect.gen(function* () {
        return yield* (yield* PluginManager).query("creation-capabilities", context);
      }).pipe(Effect.provide(impostor.layer))).recordSkill.available,
      false,
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("filters plugin hook metadata by its exact owner and counts trust review states", () => {
  const hook: import("@nodex/codex-app-server-protocol/v2/HookMetadata").HookMetadata = {
    key: "review",
    eventName: "sessionStart",
    timeoutSec: 0n,
    matcher: null,
    statusMessage: null,
    additionalContextLimit: null,
    sourcePath: "/hooks.json",
    source: "plugin",
    pluginId: "a@custom",
    displayOrder: 0n,
    enabled: true,
    isManaged: false,
    currentHash: "hash",
    trustStatus: "modified",
    handlerType: "command",
    command: "echo ready",
    async: false,
  };
  const h = make({
    detailHooks: [{ key: hook.key, eventName: hook.eventName }],
    config: settingsConfig(),
    configWriteOk: true,
    hooks: [
      hook,
      { ...hook, key: "trusted", trustStatus: "trusted" },
      { ...hook, key: "managed", isManaged: true },
      { ...hook, key: "other", pluginId: "b@custom" },
    ],
  });
  return Effect.gen(function* () {
    const manager = yield* PluginManager;
    const result = yield* manager.query("plugin-hooks", {
      hostId: "local",
      projectId: "p",
      marketplacePath: "/marketplace.json",
      pluginName: "a",
    });
    assert.deepEqual(
      result.hooks.map((hook) => hook.key),
      ["review", "trusted", "managed"],
    );
    assert.strictEqual(result.needsReviewCount, 1);
    assert.strictEqual(result.available, true);
    const selector = {
      hostId: "local",
      projectId: "p",
      marketplacePath: "/marketplace.json",
      pluginName: "a",
    };
    const detail = yield* manager.query("read", selector);
    assert.strictEqual(detail.hooksNeedingReviewCount, 1);
    assert.strictEqual(detail.hooksAvailable, true);
    assert.strictEqual((yield* manager.command("plugin-hooks-trust", selector)).status, "success");
    const write = h.calls.find((call) => call.method === "config/batchWrite");
    assert.deepEqual(write?.params.edits, [
      { keyPath: 'hooks.state."review".trusted_hash', value: "hash", mergeStrategy: "upsert" },
    ]);
    assert.strictEqual(write?.params.expectedVersion, "observed");
    assert.strictEqual(
      (yield* manager.command("plugin-hooks-trust", { ...selector, projectId: null })).status,
      "failed",
    );
    assert.strictEqual(
      (yield* manager.query("plugin-hooks", {
        ...context,
        marketplacePath: "/marketplace.json",
        pluginName: "a",
      })).needsReviewCount,
      0,
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "projects declared app connection states onto inventory rows and detail without conflating enablement",
  () => {
    const h = make({
      detailApps: [
        {
          id: "connector_test",
          name: "Test app",
          description: null,
          installUrl: null,
          category: null,
        },
      ],
      runtimeApps: [{ id: "connector_test", runtimeName: "Test", enabled: true, callable: true }],
    });
    return Effect.gen(function* () {
      const manager = yield* PluginManager;
      const inventory = yield* manager.query("installed", context);
      assert.strictEqual(inventory.rows[0]?.appConnectionStates?.connector_test, "connected");
      const detail = yield* manager.query("read", {
        ...context,
        marketplacePath: "/marketplace.json",
        pluginName: "a",
      });
      assert.deepEqual(detail.appConnectionStates, { connector_test: "connected" });
      assert.deepEqual(detail.apps[0], {
        id: "connector_test",
        name: "Test app",
        description: null,
        installUrl: null,
        category: null,
        logoUrl: null,
        logoDarkUrl: null,
        accessible: null,
        enabled: true,
        callable: true,
        editable: true,
        editRestriction: null,
        connectionState: "connected",
        canDisconnect: false,
      });
      const loginHost = make({
        config: settingsConfig({ server: { url: "https://example.com/mcp" } }),
      });
      const login = yield* Effect.gen(function* () {
        return yield* (yield* PluginManager).command("mcp-login", { ...context, name: "server" });
      }).pipe(Effect.provide(loginHost.layer));
      assert.ok("value" in login);
      if ("value" in login) assert.strictEqual(login.value.loginId, "native-login");
    }).pipe(Effect.provide(h.layer));
  },
);
it.effect(
  "keeps effective MCP policy origins read-only even when a user declaration exists",
  () => {
    const config = settingsConfig({ managed: { command: "server" } });
    const h = make({
      config: {
        ...config,
        origins: {
          "mcp_servers.managed.command": {
            name: { type: "enterpriseManaged", id: "policy", name: "Policy" },
            version: "policy-version",
          },
        },
      },
    });
    return Effect.gen(function* () {
      const manager = yield* PluginManager;
      const result = yield* manager.command("mcp-enabled", {
        ...context,
        name: "managed",
        enabled: false,
      });
      assert.strictEqual(result.status, "protected");
      assert.strictEqual(
        h.calls.some((call) => call.method === "config/batchWrite"),
        false,
      );
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "forwards app inventory and MCP OAuth notifications with their owning host and generation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events =
          yield* PubSub.unbounded<import("../codex-runtime/CodexEventHub").CodexEndpointEvent>();
        const h = make({ events: Stream.fromPubSub(events) });
        yield* Effect.gen(function* () {
          const manager = yield* PluginManager;
          const changes = yield* manager.changes.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* PubSub.publish(events, {
            kind: "notification",
            hostId: "remote",
            generation: 7,
            value: { protocol: "generated", method: "app/list/updated", params: { data: [] } },
          });
          yield* PubSub.publish(events, {
            kind: "notification",
            hostId: "local",
            generation: 1,
            value: { protocol: "generated", method: "app/list/updated", params: { data: [] } },
          });
          yield* PubSub.publish(events, {
            kind: "notification",
            hostId: "local",
            generation: 1,
            value: {
              protocol: "generated",
              method: "mcpServer/oauthLogin/completed",
              params: { name: "server", threadId: null, loginId: "login", success: true },
            },
          });
          const observed = yield* Fiber.join(changes);
          assert.deepEqual(
            observed.map((event) => event.kind),
            ["apps", "mcp"],
          );
          assert.strictEqual(observed[1]?.hostGeneration, 1);
          assert.strictEqual(observed[1]?.mcpOauthCompletion?.loginId, "login");
          assert.ok(observed.every((event) => event.hostId === "local"));
        }).pipe(Effect.provide(h.layer));
      }),
    ),
);

it.effect(
  "uses installed native identity for Works with badges instead of account-service installation flags",
  () => {
    const h = make({
      plugins: [
        pluginSummary({ id: "a@custom", name: "a", remotePluginId: "parent" }),
        pluginSummary({ id: "b@custom", name: "b", remotePluginId: "provider" }),
      ],
      accountMetadata: {
        dependencies: [
          { plugin_id: "provider", display_name: "Provider", categories: [], is_installed: false },
          { plugin_id: "absent", display_name: "Absent", categories: [], is_installed: true },
        ],
      },
    });
    return Effect.gen(function* () {
      const manager = yield* PluginManager;
      const detail = yield* manager.query("read", {
        ...context,
        marketplacePath: "/marketplace.json",
        pluginName: "a",
      });
      assert.strictEqual(detail.worksWith?.available, true);
      assert.deepEqual(
        detail.worksWith?.dependencies.map((provider) => [provider.pluginId, provider.installed]),
        [
          ["provider", true],
          ["absent", false],
        ],
      );
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "projects authorized skill icons and actual local enablement only for installed plugins",
  () => {
    const skill: import("@nodex/codex-app-server-protocol/v2/SkillSummary").SkillSummary = {
      name: "make_art",
      description: "Art",
      shortDescription: null,
      path: null,
      enabled: true,
      interface: {
        iconSmall: "/icons/art.svg",
        iconSmallUrl: "https://cdn.test/art.svg",
        iconLargeUrl: null,
      },
    };
    const options = {
      detailSkills: [skill, { ...skill, name: "missing" }],
      localSkills: [
        {
          name: "a:make-art",
          path: "/skills/art/SKILL.md",
          enabled: false,
          description: "",
          scope: "user" as const,
          pluginId: "a@custom",
        },
      ],
    };
    const selector = { ...context, marketplacePath: "/marketplace.json", pluginName: "a" };
    return Effect.gen(function* () {
      const detail = yield* Effect.gen(function* () {
        return yield* (yield* PluginManager).query("read", selector);
      }).pipe(Effect.provide(make(options).layer));
      assert.strictEqual(detail.skills[0]?.iconUrl, "app://fs/@fs/icons/art.svg");
      assert.deepEqual(detail.skills[0]?.installedSkill, {
        path: "/skills/art/SKILL.md",
        name: "a:make-art",
        enabled: false,
      });
      assert.strictEqual(detail.skills[1]?.installedSkill, null);
      const uninstalled = make({
        ...options,
        plugins: [pluginSummary({ id: "a@custom", name: "a", installed: false })],
      });
      const preview = yield* Effect.gen(function* () {
        return yield* (yield* PluginManager).query("read", selector);
      }).pipe(Effect.provide(uninstalled.layer));
      assert.strictEqual(preview.skills[0]?.installedSkill, null);
      assert.strictEqual(
        uninstalled.calls.some((call) => call.method === "skills/list"),
        false,
      );
    });
  },
);

it.effect(
  "writes only the resolved plugin MCP enablement key and preserves its declaration",
  () => {
    const h = make({
      detailMcpServers: ["Art Tools"],
      config: settingsConfig({
        "art.with.dot": { name: "Art Tools", command: "node", args: ["art.js"], enabled: false },
      }),
      mcpStatuses: [{ name: "art.with.dot", pluginId: "a@custom" }],
      configWriteOk: true,
    });
    const selector = { ...context, marketplacePath: "/marketplace.json", pluginName: "a" };
    return Effect.gen(function* () {
      const manager = yield* PluginManager;
      const detail = yield* manager.query("read", selector);
      assert.deepEqual(detail.mcpServerStates, [
        {
          name: "Art Tools",
          configKey: "art.with.dot",
          enabled: false,
          installed: true,
          canSetEnabled: true,
        },
      ]);
      const result = yield* manager.command("plugin-mcp-enabled", {
        ...selector,
        name: "Art Tools",
        enabled: true,
      });
      assert.strictEqual(result.status, "success");
      assert.deepEqual(h.calls.find((call) => call.method === "config/value/write")?.params, {
        keyPath: 'mcp_servers."art.with.dot".enabled',
        value: true,
        mergeStrategy: "upsert",
        filePath: "/config.toml",
        expectedVersion: "observed",
      });
      assert.strictEqual(
        h.calls.some((call) => call.method === "config/batchWrite"),
        false,
      );
      const writes = h.calls.filter((call) => call.method === "config/value/write").length;
      assert.strictEqual(
        (yield* manager.command("plugin-mcp-enabled", {
          ...selector,
          name: "unrelated",
          enabled: true,
        })).status,
        "failed",
      );
      assert.strictEqual(
        h.calls.filter((call) => call.method === "config/value/write").length,
        writes,
      );
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "forces native app reconciliation for detail reads requested after browser authentication",
  () => {
    const h = make({
      detailApps: [
        {
          id: "connector_test",
          name: "Test",
          description: null,
          category: null,
          installUrl: "https://chatgpt.com/apps/test",
        },
      ],
    });
    return Effect.gen(function* () {
      const detail = yield* (yield* PluginManager).query("read", {
        ...context,
        marketplacePath: "/marketplace.json",
        pluginName: "a",
        forceRefreshApps: true,
      });
      assert.strictEqual(
        h.calls.find((call) => call.method === "app/installed")?.params.forceRefresh,
        true,
      );
      assert.strictEqual(detail.apps[0]?.installUrl, "https://chatgpt.com/apps/test");
      assert.strictEqual(detail.apps[0]?.enabled, null);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("returns policy denial for an overridden plugin MCP enablement write", () => {
  const h = make({
    detailMcpServers: ["server"],
    config: settingsConfig({ server: { command: "node" } }),
    configOverridden: true,
  });
  return Effect.gen(function* () {
    const result = yield* (yield* PluginManager).command("plugin-mcp-enabled", {
      ...context,
      marketplacePath: "/marketplace.json",
      pluginName: "a",
      name: "server",
      enabled: false,
    });
    assert.strictEqual(result.status, "policy_denied");
    if (result.status === "policy_denied") assert.strictEqual(result.error.code, "policy_denied");
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "admits only observed exact SKILL.md paths and revokes paths removed from the current detail",
  () => {
    const path = "/marketplace/figma/skills/design/SKILL.md";
    const skills: import("@nodex/codex-app-server-protocol/v2/SkillSummary").SkillSummary[] = [
      {
        path,
        name: "design",
        description: "",
        shortDescription: null,
        enabled: false,
        interface: null,
      },
      {
        path: "/marketplace/figma/private.txt",
        name: "invalid",
        description: "",
        shortDescription: null,
        enabled: false,
        interface: null,
      },
    ];
    const h = make({
      omitInventory: true,
      detailSkills: skills,
      plugins: [pluginSummary({ id: "figma@custom", name: "figma", installed: false })],
    });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        const read = (requested: string) =>
          manager.query("skill-contents", { ...context, path: requested });
        const unknown = yield* read(path);
        assert.strictEqual(unknown.status, "failed");
        if (unknown.status === "failed") assert.strictEqual(unknown.error.code, "not_found");
        yield* manager.query("read", {
          ...context,
          marketplacePath: "/marketplace.json",
          pluginName: "figma",
        });
        assert.strictEqual((yield* read(path)).status, "success");
        for (const requested of [
          "/marketplace/figma/skills/other/SKILL.md",
          `${path}/../private.txt`,
          "/marketplace/figma/private.txt",
        ])
          assert.strictEqual((yield* read(requested)).status, "failed");
        skills.splice(0);
        const removed = yield* read(path);
        assert.strictEqual(removed.status, "failed");
        assert.deepEqual(h.contentReads, [path]);
      }),
    );
  },
);

it.effect("fences detail skill preview grants by project bindings", () => {
  const path = "/marketplace/figma/skills/design/SKILL.md";
  const h = make({
    omitInventory: true,
    detailSkillPath: path,
    plugins: [pluginSummary({ id: "figma@custom", name: "figma", installed: false })],
  });
  return withManager(h, (manager) =>
    Effect.gen(function* () {
      const selector = {
        hostId: "local",
        projectId: "p",
        marketplacePath: "/marketplace.json",
        pluginName: "figma",
      };
      yield* manager.query("read", selector);
      assert.strictEqual(
        (yield* manager.query("skill-contents", { ...context, path })).status,
        "failed",
      );
      h.setProject({
        id: "p",
        lifecycle: "active",
        bindingRevision: 4,
        sources: [{ root: "/new", order: 1 }],
      });
      assert.strictEqual(
        (yield* manager.query("skill-contents", { hostId: "local", projectId: "p", path })).status,
        "failed",
      );
      yield* manager.query("read", selector);
      assert.strictEqual(
        (yield* manager.query("skill-contents", { hostId: "local", projectId: "p", path })).status,
        "success",
      );
      assert.deepEqual(h.contentReads, [path]);
    }),
  );
});

it.effect("revokes observed skill paths after account changes and host reconnections", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events =
        yield* PubSub.bounded<import("../codex-runtime/CodexEventHub").CodexEndpointEvent>(16);
      const path = "/marketplace/figma/skills/design/SKILL.md";
      const h = make({
        events: Stream.fromPubSub(events),
        omitInventory: true,
        detailSkillPath: path,
        plugins: [pluginSummary({ id: "figma@custom", name: "figma", installed: false })],
      });
      yield* withManager(h, (manager) =>
        Effect.gen(function* () {
          const selector = {
            ...context,
            marketplacePath: "/marketplace.json",
            pluginName: "figma",
          };
          for (const event of [
            {
              kind: "notification",
              hostId: "local",
              generation: 1,
              value: {
                protocol: "generated",
                method: "account/updated",
                params: { authMode: null, planType: null },
              },
            },
            { kind: "connection", value: { kind: "ready", hostId: "local", generation: 1 } },
          ] as const) {
            yield* manager.query("read", selector);
            const changed = yield* manager.changes.pipe(
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped({ startImmediately: true }),
            );
            yield* PubSub.publish(events, event);
            yield* Fiber.join(changed);
            const result = yield* manager.query("skill-contents", { ...context, path });
            assert.strictEqual(result.status, "failed");
            if (result.status === "failed") assert.strictEqual(result.error.code, "not_found");
          }
          assert.deepEqual(h.contentReads, []);
        }).pipe(Effect.scoped),
      );
    }),
  ),
);

it.effect("retains installed skill authorization and the native remote skill-read path", () => {
  const h = make({ omitInventory: true });
  return withManager(h, (manager) =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* manager.query("skill-contents", { ...context, path: "/managed/SKILL.md" }),
        {
          status: "success",
          contents: "contents",
          files: ["SKILL.md"],
        },
      );
      assert.deepEqual(
        yield* manager.query("skill-contents", {
          ...context,
          remoteMarketplaceName: "remote",
          remotePluginId: "plugin-id",
          skillName: "remote-skill",
        }),
        {
          status: "success",
          contents: "remote skill",
          files: ["SKILL.md"],
        },
      );
      assert.deepEqual(h.contentReads, ["/managed/SKILL.md"]);
      assert.deepEqual(h.calls.find((call) => call.method === "plugin/skill/read")?.params, {
        remoteMarketplaceName: "remote",
        remotePluginId: "plugin-id",
        skillName: "remote-skill",
      });
    }),
  );
});

it.effect(
  "writes only app enablement against the current user version and exposes policy restrictions",
  () => {
    const config = { ...settingsConfig(), config: { apps: { connector_test: { enabled: true } } } };
    const h = make({
      config,
      configWriteOk: true,
      runtimeApps: [{ id: "connector_test", runtimeName: "Test", enabled: true, callable: false }],
    });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        const view = yield* manager.query("apps", context);
        assert.strictEqual(view.apps[0]?.editable, true);
        assert.strictEqual(
          (yield* manager.command("app-enabled", {
            ...context,
            appId: "asdk_app_test",
            enabled: false,
          })).status,
          "success",
        );
        const write = h.calls.find((call) => call.method === "config/batchWrite");
        assert.deepEqual(write?.params.edits, [
          { keyPath: 'apps."connector_test".enabled', value: false, mergeStrategy: "upsert" },
        ]);
        assert.strictEqual(write?.params.expectedVersion, "observed");
        assert.strictEqual(write?.params.reloadUserConfig, true);
      }),
    );
  },
);
it.effect("rejects app enablement from non-user config layers before writing", () => {
  const h = make({
    config: {
      ...settingsConfig(),
      config: { apps: { connector_test: { enabled: false } } },
      origins: {
        "apps.connector_test.enabled": {
          name: { type: "project", dotCodexFolder: "/repo/.codex" },
          version: "project",
        },
      },
    },
    runtimeApps: [{ id: "connector_test", runtimeName: null, enabled: false, callable: false }],
  });
  return withManager(h, (manager) =>
    Effect.gen(function* () {
      const view = yield* manager.query("apps", context);
      assert.strictEqual(view.apps[0]?.editable, false);
      assert.strictEqual(view.apps[0]?.editRestriction?.code, "policy_denied");
      assert.strictEqual(
        (yield* manager.command("app-enabled", {
          ...context,
          appId: "connector_test",
          enabled: true,
        })).status,
        "policy_denied",
      );
      assert.strictEqual(
        h.calls.some((call) => call.method === "config/batchWrite"),
        false,
      );
    }),
  );
});
