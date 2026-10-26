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
    failSkills?: boolean;
    failUninstall?: string;
    remoteSearch?: boolean;
    marketplaceName?: string;
    service?: PluginService["Service"];
    detailSkillPath?: string;
    omitSkills?: boolean;
    configOverridden?: boolean;
    directoryErrors?: boolean;
    upgradePartial?: boolean;
    abortInstall?: boolean;
  } = {},
) => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
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
    marketplaces: [
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
            skills: options.detailSkillPath
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
              : [],
            apps: [],
            hooks: [],
            mcpServers: [],
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
                  skills: [
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
      if (method === "config/read")
        return Effect.succeed({
          config: {},
          origins: {},
          layers: [
            {
              name: { type: "user", file: "/config.toml" },
              version: "v42",
              config: {},
            },
          ],
        });
      if (method === "config/batchWrite" && options.configOverridden)
        return Effect.succeed({
          status: "okOverridden",
          version: "v43",
          filePath: "/config.toml",
          overriddenMetadata: null,
        });
      if (method === "config/batchWrite")
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
    events: Stream.empty,
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
        Effect.succeed({ authMethod: "apikey", authToken: null, requiresOpenaiAuth: true }),
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
    omitSkills: true,
    plugins: [pluginSummary({ id: "a@custom", name: "a", enabled: false })],
  });
  return withManager(h, (manager) =>
    Effect.gen(function* () {
      const result = yield* manager.query("skill-contents", {
        ...context,
        path: "/plugins/a/skills/sample/SKILL.md",
      });
      assert.strictEqual(result.contents, "contents");
      assert.strictEqual(
        h.calls.some((call) => call.method === "plugin/read"),
        true,
      );
      const denied = yield* manager
        .query("skill-contents", { ...context, path: "/private/unrelated/SKILL.md" })
        .pipe(Effect.result);
      assert.strictEqual(denied._tag, "Failure");
      if (denied._tag === "Failure") assert.strictEqual(denied.failure.code, "not_found");
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
      omitSkills: true,
      plugins: [pluginSummary({ id: "a@custom", name: "a", installed: false })],
    });
    return withManager(h, (manager) =>
      Effect.gen(function* () {
        assert.strictEqual(
          (yield* manager.query("skill-contents", { ...context, path })).contents,
          "contents",
        );
      }),
    );
  },
);
