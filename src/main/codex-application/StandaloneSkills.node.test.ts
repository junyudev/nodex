import { describe } from "vite-plus/test";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { TestClock } from "effect/testing";
import { StandaloneSkills, live } from "./StandaloneSkills";
import {
  GitCommandPlatform,
  type GitCommandProcessInput,
} from "../git-worker/git-command-platform";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import { makePluginApps } from "./PluginApps";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { ChatGptDesktop } from "./ChatGptDesktop";
import { PluginServiceAccount, PluginService, live as livePluginService } from "./PluginService";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import type { ChatGptDesktopRequestInput } from "../codex/chatgpt-desktop-request";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  parseComposerChatGptConversations,
  parseComposerSitesToolResponse,
} from "../codex/composer-external-suggestion-projection";
import {
  ComposerExternalSuggestions,
  live as suggestionsLive,
} from "./ComposerExternalSuggestions";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { CodexAccountSnapshot } from "../../shared/types";
import { CodexAccount } from "./CodexAccount";
import { CodexToolRuntime, live as codexToolRuntimeLive } from "./CodexToolRuntime";
import { signedOutAccountSnapshot } from "./CodexAccountState";

describe("StandaloneSkills", () => {
  const make = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-skills-" });
    const home = yield* fs.realPath(temp);
    const repo = `${home}/vendor_imports/skills`;
    const project = `${home}/project`;
    yield* fs.makeDirectory(project);
    const calls: GitCommandProcessInput[] = [];
    let failGit = false;
    const git = GitCommandPlatform.of({
      run: (input) =>
        Effect.gen(function* () {
          calls.push(input);
          if (!failGit) {
            yield* fs.makeDirectory(`${repo}/.git`, { recursive: true }).pipe(Effect.orDie);
            for (const group of [".curated", ".experimental"]) {
              yield* fs
                .makeDirectory(`${repo}/skills/${group}/sample/scripts`, { recursive: true })
                .pipe(Effect.orDie);
              yield* fs
                .writeFileString(
                  `${repo}/skills/${group}/sample/SKILL.md`,
                  `---\nname: ${group === ".curated" ? "Curated" : "Experimental"}\ndescription: |\n  A useful skill.\nmetadata:\n  short-description: Short\n---\n# Skill`,
                )
                .pipe(Effect.orDie);
              yield* fs
                .writeFileString(`${repo}/skills/${group}/sample/scripts/run.py`, "print('hello')")
                .pipe(Effect.orDie);
            }
          }
          return {
            code: failGit ? 1 : 0,
            signal: null,
            stdout: "",
            stderr: "",
            stdoutBytes: 0,
            stderrBytes: 0,
            failureReason: null,
          };
        }),
    });
    const layer = live({
      codexHome: home,
      environment: { PATH: "/usr/bin", GIT_DIR: "/outside/.git", GIT_WORK_TREE: "/outside" },
    }).pipe(Layer.provide(Layer.succeed(GitCommandPlatform, git)));
    return {
      home,
      repo,
      project,
      calls,
      layer,
      fail: () => {
        failGit = true;
      },
    };
  });
  const skill = (
    path: string,
    scope: "user" | "repo" = "user",
    pluginId: string | null = null,
  ): SkillMetadata => ({
    path,
    scope,
    pluginId,
    name: "sample",
    description: "sample",
    enabled: true,
  });

  it.effect(
    "refreshes sparse recommendations after ten minutes and retains a failed-refresh cache",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* make;
          yield* Effect.gen(function* () {
            const skills = yield* StandaloneSkills;
            const initial = yield* skills.list(false);
            assert.deepEqual(
              initial.skills.map((skill) => [skill.id, skill.name, skill.shortDescription]),
              [["sample", "Curated", "Short"]],
            );
            assert.strictEqual(initial.source, "git");
            assert.strictEqual(h.calls.length, 2);
            assert.strictEqual(h.calls[0]?.environment.GIT_DIR, undefined);
            assert.strictEqual(h.calls[0]?.environment.GIT_WORK_TREE, undefined);
            assert.ok(
              h.calls.every(
                (call) => call.timeoutMs === 30_000 && call.environment.GIT_TERMINAL_PROMPT === "0",
              ),
            );
            yield* skills.list(false);
            assert.strictEqual(h.calls.length, 2);
            yield* TestClock.adjust("10 minutes");
            h.fail();
            const failed = yield* skills.list(false);
            assert.strictEqual(failed.source, "cache");
            assert.strictEqual(failed.error?.code, "service_unavailable");
            assert.deepEqual(failed.skills, initial.skills);
          }).pipe(Effect.provide(h.layer));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "installs a complete skill atomically in user and Project scopes and refuses replacement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* make;
          const fs = yield* FileSystem.FileSystem;
          yield* Effect.gen(function* () {
            const skills = yield* StandaloneSkills;
            const installed = yield* skills.install("sample", null, Effect.void);
            assert.strictEqual(installed.path, join(h.home, "skills", "sample", "SKILL.md"));
            assert.deepEqual((yield* skills.contents(installed.path)).files, [
              "SKILL.md",
              "scripts/run.py",
            ]);
            assert.strictEqual(
              yield* fs.readFileString(`${h.home}/skills/sample/scripts/run.py`),
              "print('hello')",
            );
            const conflict = yield* skills.install("sample", null, Effect.void).pipe(Effect.flip);
            assert.strictEqual(conflict.code, "invalid_input");
            const project = yield* skills.install("sample", h.project, Effect.void);
            assert.strictEqual(
              project.path,
              join(h.project, ".agents", "skills", "sample", "SKILL.md"),
            );
            yield* skills.uninstall(skill(project.path, "repo"), [h.project], Effect.void);
            assert.strictEqual(yield* fs.exists(`${h.project}/.agents/skills/sample`), false);
            yield* fs.symlink(h.home, `${h.home}/native-home-alias`);
            yield* skills.uninstall(
              skill(`${h.home}/native-home-alias/skills/sample/SKILL.md`),
              [],
              Effect.void,
            );
            assert.strictEqual(yield* fs.exists(`${h.home}/skills/sample`), false);
          }).pipe(Effect.provide(h.layer));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects traversal, plugin removal, symlink scopes, and escaping support files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* make;
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.gen(function* () {
          const skills = yield* StandaloneSkills;
          assert.strictEqual(
            (yield* skills.install("../outside", null, Effect.void).pipe(Effect.flip)).code,
            "invalid_input",
          );
          yield* skills.list(false);
          const outside = `${h.home}/outside`;
          yield* fs.makeDirectory(outside);
          yield* fs.writeFileString(`${outside}/SKILL.md`, "private");
          yield* fs.symlink(outside, `${h.home}/skills`);
          assert.strictEqual(
            (yield* skills.install("sample", null, Effect.void).pipe(Effect.flip)).code,
            "protected",
          );
          assert.strictEqual(
            (yield* skills
              .uninstall(skill(`${outside}/SKILL.md`), [], Effect.void)
              .pipe(Effect.flip)).code,
            "protected",
          );
          assert.strictEqual(
            (yield* skills
              .uninstall(skill(`${outside}/SKILL.md`, "user", "plugin@market"), [], Effect.void)
              .pipe(Effect.flip)).code,
            "protected",
          );
          yield* fs.symlink(outside, `${h.project}/.agents`);
          assert.strictEqual(
            (yield* skills.install("sample", h.project, Effect.void).pipe(Effect.flip)).code,
            "protected",
          );
          assert.strictEqual(yield* fs.exists(`${outside}/skills`), false);
          yield* fs.symlink(`${outside}/SKILL.md`, `${h.repo}/skills/.curated/sample/leak.md`);
          assert.strictEqual(
            (yield* skills.install("sample", h.project, Effect.void).pipe(Effect.flip)).code,
            "protected",
          );
          assert.strictEqual(yield* fs.readFileString(`${outside}/SKILL.md`), "private");
        }).pipe(Effect.provide(h.layer));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "uses an available bundled catalog and supporting files before creating a Git checkout",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* make;
          const fs = yield* FileSystem.FileSystem;
          const bundled = `${h.home}/bundled`;
          yield* fs.makeDirectory(`${bundled}/skills/.curated/pdf`, { recursive: true });
          yield* fs.writeFileString(
            `${bundled}/skills/.curated/pdf/SKILL.md`,
            "---\nname: PDF\ndescription: Read files\n---\n# PDF",
          );
          const layer = live({ codexHome: h.home, environment: {}, bundledRepoRoot: bundled }).pipe(
            Layer.provide(
              Layer.succeed(GitCommandPlatform, {
                run: () => Effect.die("The bundled fallback must not fetch Git"),
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const skills = yield* StandaloneSkills;
            const catalog = yield* skills.list(false);
            assert.strictEqual(catalog.source, "bundled");
            assert.deepEqual(
              catalog.skills.map((skill) => skill.id),
              ["pdf"],
            );
            const installed = yield* skills.install("pdf", null, Effect.void);
            assert.strictEqual(
              (yield* skills.contents(installed.path)).contents?.includes("# PDF"),
              true,
            );
          }).pipe(Effect.provide(layer));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "previews recommendations before installation and authorizes only contained small icons",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const h = yield* make;
          yield* Effect.gen(function* () {
            const skills = yield* StandaloneSkills;
            const preview = yield* skills.recommendedContents("sample");
            assert.ok(preview.contents?.includes("# Skill"));
            assert.deepEqual(preview.files, ["SKILL.md", "scripts/run.py"]);
            assert.strictEqual(yield* fs.exists(`${h.home}/skills/sample`), false);
            for (const id of ["missing", "../sample", "/private"])
              assert.strictEqual(
                (yield* skills.recommendedContents(id).pipe(Effect.flip)).code,
                "not_found",
              );
            const source = `${h.repo}/skills/.curated/sample`;
            yield* fs.makeDirectory(`${source}/agents`);
            yield* fs.makeDirectory(`${source}/assets`);
            yield* fs.writeFileString(`${source}/assets/small.svg`, "<svg/>");
            yield* fs.writeFileString(
              `${source}/agents/openai.yaml`,
              'interface:\n  icon_small: "./assets/small.svg"\n',
            );
            const catalog = yield* skills.list(false);
            assert.ok(catalog.skills[0]?.iconUrl?.startsWith("app://fs/@fs/"));
            assert.ok(catalog.skills[0]?.iconUrl?.endsWith("/assets/small.svg"));
            assert.deepEqual((yield* skills.recommendedContents("sample")).files, [
              "SKILL.md",
              "agents/openai.yaml",
              "assets/small.svg",
              "scripts/run.py",
            ]);
            const outside = `${h.home}/private`;
            yield* fs.makeDirectory(outside);
            yield* fs.writeFileString(`${outside}/SKILL.md`, "private");
            yield* fs.writeFileString(
              `${source}/agents/openai.yaml`,
              `interface:\n  icon_small: "${outside}/SKILL.md"\n`,
            );
            assert.strictEqual((yield* skills.list(false)).skills[0]?.iconUrl, null);
            yield* fs.symlink(`${outside}/SKILL.md`, `${source}/leak.md`);
            assert.strictEqual(
              (yield* skills.recommendedContents("sample").pipe(Effect.flip)).code,
              "protected",
            );
          }).pipe(Effect.provide(h.layer));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("PluginApps", () => {
  const context = {
    hostId: "local",
    projectId: null,
    hostGeneration: 7,
    accountEpoch: 2,
    bindingRevision: null,
    cwds: [],
  } as const;
  const metadata = (id: string) => ({
    id,
    name: `App ${id}`,
    description: null,
    iconUrl: null,
    iconUrlDark: null,
    distributionChannel: null,
    installUrl: null,
    pluginDisplayNames: [],
    toolSummaries: null,
  });
  const make = (
    options: {
      ids?: string[];
      unsupported?: boolean;
      fail?: boolean;
      links?: unknown[];
      connectors?: unknown[];
    } = {},
  ) => {
    const calls: { method: string; params: Record<string, unknown>; scheduling: unknown }[] = [];
    const http: ChatGptDesktopRequestInput[] = [];
    const ids = options.ids ?? ["connector_sample"];
    const gateway = {
      requestOnHost: (
        _host: string,
        method: string,
        params: Record<string, unknown>,
        scheduling: unknown,
      ) => {
        calls.push({ method, params, scheduling });
        if (method === "config/read")
          return Effect.succeed({
            config: {},
            origins: {},
            layers: [
              {
                name: { type: "user", file: "/config.toml", profile: null },
                config: {},
                version: "v1",
                disabledReason: null,
              },
            ],
          });
        if (options.fail || (options.unsupported && method === "app/installed"))
          return Effect.fail(
            codexRuntimeError({
              operation: "apps",
              reason: "request",
              retryable: false,
              cause: options.fail
                ? null
                : new CodexAppServerRequestError({
                    method,
                    operation: "receive-response",
                    code: -32601,
                    errorMessage: "Method not found",
                  }),
            }),
          );
        if (method === "app/installed")
          return Effect.succeed({
            apps: ids.map((id) => ({ id, runtimeName: null, enabled: true, callable: false })),
          });
        if (method === "app/read")
          return Effect.succeed({
            apps: (params.appIds as string[]).filter((id) => id !== "missing").map(metadata),
            missingAppIds: (params.appIds as string[]).filter((id) => id === "missing"),
          });
        if (method === "app/list")
          return Effect.succeed({
            data: [
              {
                id: "legacy",
                name: "Legacy",
                description: null,
                logoUrl: null,
                logoUrlDark: null,
                distributionChannel: null,
                installUrl: null,
                pluginDisplayNames: [],
                isAccessible: true,
                isEnabled: false,
              },
            ],
            nextCursor: null,
          });
        return Effect.die(`Unexpected ${method}`);
      },
    } as unknown as CodexGateway["Service"];
    const desktop = {
      request: (input: ChatGptDesktopRequestInput) => {
        http.push(input);
        return Effect.succeed(
          new Response(
            JSON.stringify(
              input.path.includes("list_accessible")
                ? { links: options.links ?? [] }
                : input.path.includes("/batch")
                  ? {
                      connectors:
                        options.connectors ??
                        ids.map((id) => ({ id, name: `HTTP ${id}`, status: "AVAILABLE" })),
                    }
                  : {},
            ),
            { headers: { "Content-Type": "application/json" } },
          ),
        );
      },
    } as unknown as ChatGptDesktop["Service"];
    return {
      calls,
      http,
      owner: makePluginApps.pipe(
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(ChatGptDesktop, desktop),
      ),
    };
  };
  it.effect("batches metadata by 100 while preserving runtime state and explicit missing IDs", () =>
    Effect.gen(function* () {
      const h = make({ ids: Array.from({ length: 203 }, (_, i) => `app_${i}`) });
      const apps = yield* h.owner;
      const view = yield* apps.list(context, {
        ...context,
        appIds: ["missing"],
        forceRefresh: true,
      });
      assert.deepEqual(
        h.calls
          .filter((call) => call.method === "app/read")
          .map((call) => (call.params.appIds as string[]).length),
        [100, 100, 4],
      );
      assert.deepEqual(view.missingAppIds, ["missing"]);
      assert.strictEqual(view.apps[0]?.enabled, true);
      assert.strictEqual(view.apps[0]?.callable, false);
      assert.strictEqual(view.apps[0]?.connectionState, "unknown");
      assert.deepEqual(h.calls[0]?.scheduling, { expectedHostId: "local", expectedGeneration: 7 });
      assert.strictEqual(h.http.length, 0);
    }),
  );
  it.effect("uses the legacy lifecycle only for an unsupported method", () =>
    Effect.gen(function* () {
      const h = make({ unsupported: true });
      const view = yield* (yield* h.owner).list(context, context);
      assert.strictEqual(view.apps[0]?.id, "legacy");
      assert.strictEqual(view.apps[0]?.callable, false);
      assert.strictEqual(view.apps[0]?.enabled, false);
      assert.strictEqual(view.apps[0]?.accessible, true);
      const failure = make({ fail: true });
      const error = yield* (yield* failure.owner).list(context, context).pipe(Effect.flip);
      assert.strictEqual(error.code, "service_unavailable");
      assert.strictEqual(
        failure.calls.some((call) => call.method === "app/list"),
        false,
      );
    }),
  );
  it.effect(
    "prefers a usable connection over a disabled account and scopes disconnection to a verified app",
    () =>
      Effect.gen(function* () {
        const h = make({
          links: [
            {
              id: "blocked",
              connector_id: "connector_sample",
              auth_status: "ACTIVE",
              connector_status: "DISABLED_BY_ADMIN",
            },
            {
              id: "good",
              connector_id: "connector_sample",
              name: "Work",
              auth_status: "ACTIVE",
              connector_status: "AVAILABLE",
            },
          ],
        });
        const apps = yield* h.owner;
        const view = yield* apps.list(context, context);
        assert.strictEqual(view.apps[0]?.connectionState, "connected");
        assert.deepEqual(view.apps[0]?.connections, [{ id: "good", name: "Work" }]);
        const invalid = yield* apps
          .disconnect(context, { appId: "connector_sample", linkId: "someone-else" })
          .pipe(Effect.flip);
        assert.strictEqual(invalid.code, "not_found");
        assert.strictEqual(
          h.http.some((call) => call.method === "DELETE"),
          false,
        );
        yield* apps.disconnect(context, { appId: "connector_sample", linkId: "good" });
        const deletion = h.http.find((call) => call.method === "DELETE");
        assert.strictEqual(deletion?.path, "aip/connectors/links/good");
        assert.deepEqual(deletion?.expectedAccount, { accountId: "account", userId: "user" });
        assert.strictEqual(deletion?.refreshOn401, false);
      }).pipe(
        Effect.provideService(PluginServiceAccount, { accountId: "account", userId: "user" }),
      ),
  );
  it.effect(
    "does not treat implicit or hidden links as connected and preserves administrator blocking",
    () =>
      Effect.gen(function* () {
        const h = make({
          ids: ["connector_sample", "blocked"],
          links: [
            { id: "implicit_link::x", connector_id: "connector_sample", auth_status: "ACTIVE" },
            {
              id: "hidden",
              connector_id: "connector_sample",
              auth_status: "ACTIVE",
              visibility: "HIDDEN",
            },
            {
              id: "disabled",
              connector_id: "blocked",
              auth_status: "ACTIVE",
              connector_status: "DISABLED_BY_ADMIN",
            },
          ],
        });
        const view = yield* (yield* h.owner).list(context, context);
        assert.strictEqual(view.apps[0]?.connectionState, "authentication_required");
        assert.strictEqual(view.apps[1]?.connectionState, "admin_disabled");
        assert.strictEqual(view.connect.supported, false);
      }).pipe(
        Effect.provideService(PluginServiceAccount, { accountId: "account", userId: "user" }),
      ),
  );
});

describe("PluginService", () => {
  const live = livePluginService;
  const token = (account: string) =>
    `x.${Buffer.from(JSON.stringify({ exp: 9999999999, "https://api.openai.com/auth": { chatgpt_account_id: account, user_id: "u" } })).toString("base64url")}.x`;
  const make = (
    options: {
      authMethod?: string;
      status?: number;
      workspace?: boolean;
      malformed?: boolean;
      changeAccount?: boolean;
      terminal?: boolean;
    } = {},
  ) => {
    const calls: { path: string; method: string; account: string | undefined }[] = [];
    let account = "a";
    const desktop = ChatGptDesktop.of({
      authStatus: () =>
        Effect.succeed({
          authMethod: options.authMethod ?? "chatgpt",
          authToken: token(account),
          requiresOpenaiAuth: true,
        }),
      authMethod: Effect.succeed(options.authMethod ?? "chatgpt"),
      prepareRequest: () => Effect.die("unused"),
      request: (input) =>
        Effect.sync(() => {
          calls.push({
            path: input.path,
            method: input.method,
            account: input.expectedAccount?.accountId,
          });
          if (options.changeAccount) account = "b";
          const body = options.malformed
            ? { invalid: true }
            : input.path.includes("/home")
              ? {
                  sections: [
                    {
                      id: "curated",
                      title: "Curated",
                      url_slug: "curated",
                      plugins: [{ id: "plugin", display_name: "Plugin" }],
                    },
                  ],
                }
              : {
                  plugins: [{ id: "plugin", display_name: "Plugin" }],
                  pagination: options.terminal ? {} : { next_page_token: "next" },
                  category: { title: "Design", description: "Tools for design" },
                };
          return Response.json(body, { status: options.status ?? 200 });
        }),
    });
    const gateway = {
      requestLocal: () =>
        Effect.succeed({
          account: { type: "chatgpt", planType: options.workspace ? "business" : "pro" },
        }),
    } as unknown as CodexGateway["Service"];
    return {
      calls,
      layer: live.pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(ChatGptDesktop, desktop), Layer.succeed(CodexGateway, gateway)),
        ),
      ),
    };
  };
  const withService = <A>(
    h: ReturnType<typeof make>,
    run: (service: PluginService["Service"]) => Effect.Effect<A, unknown>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(h.layer);
        return yield* run(Context.get(context, PluginService));
      }),
    );
  it.effect(
    "disables every HTTP capability without ChatGPT auth and never issues an HTTP request",
    () => {
      const h = make({ authMethod: "apikey" });
      return withService(h, (service) =>
        Effect.gen(function* () {
          const access = yield* service.access;
          assert.strictEqual(Object.values(access).some(Boolean), false);
          assert.strictEqual(h.calls.length, 0);
        }),
      );
    },
  );
  it.effect(
    "resolves endpoint denial as a false capability while selected feeds retain HTTP errors",
    () => {
      const h = make({ status: 403 });
      return withService(h, (service) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* service.access).publicHome, false);
          const result = yield* service.home.pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") assert.strictEqual(result.failure.code, "policy_denied");
        }),
      );
    },
  );
  it.effect("rejects malformed service responses and stale account responses", () => {
    const malformed = make({ malformed: true });
    const changed = make({ changeAccount: true });
    return Effect.gen(function* () {
      yield* withService(malformed, (service) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* service.home.pipe(Effect.result))._tag, "Failure");
        }),
      );
      yield* withService(changed, (service) =>
        Effect.gen(function* () {
          const result = yield* service.home.pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") assert.strictEqual(result.failure.code, "account_changed");
        }),
      );
    });
  });
  it.effect(
    "encodes category search and opaque cursors, preserves metadata and fences remote toggles",
    () => {
      const h = make();
      return withService(h, (service) =>
        Effect.gen(function* () {
          const page = yield* service.category({
            slug: "a/b",
            search: " design tools ",
            cursor: "opaque+cursor",
          });
          assert.strictEqual(page.category?.title, "Design");
          const url = new URL(h.calls[0]!.path, "https://example.com/");
          assert.strictEqual(url.pathname, "/ps/plugin-categories/a%2Fb/plugins");
          assert.strictEqual(url.searchParams.get("q"), "design tools");
          assert.strictEqual(url.searchParams.get("pageToken"), "opaque+cursor");
          assert.strictEqual(url.searchParams.get("scope"), "GLOBAL");
          assert.strictEqual(url.searchParams.get("limit"), "50");
          yield* service.setEnabled("a/b", false);
          assert.deepStrictEqual(h.calls.at(-1), {
            path: "ps/plugins/a%2Fb/disable",
            method: "POST",
            account: "a",
          });
        }),
      );
    },
  );
  it.effect(
    "checks workspace capability only for workspace accounts and reuses resolved access for a minute",
    () => {
      const h = make({ workspace: true });
      return withService(h, (service) =>
        Effect.gen(function* () {
          const first = yield* service.access;
          assert.strictEqual(first.workspace, true);
          assert.strictEqual(first.shared, true);
          const count = h.calls.length;
          yield* service.access;
          assert.strictEqual(h.calls.length, count);
          assert.strictEqual(
            h.calls.some((call) => call.path.includes("/workspace/shared")),
            true,
          );
        }),
      );
    },
  );

  it.effect("refuses to retarget a frozen account before dispatch", () => {
    const h = make();
    return withService(h, (service) =>
      Effect.gen(function* () {
        const result = yield* service.home.pipe(
          Effect.provideService(PluginServiceAccount, { accountId: "different", userId: "u" }),
          Effect.result,
        );
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure.code, "account_changed");
        assert.strictEqual(h.calls.length, 0);
      }),
    );
  });

  it.effect("accepts terminal pages without a next-page token", () => {
    const h = make({ terminal: true });
    return withService(h, (service) =>
      Effect.gen(function* () {
        const page = yield* service.page({ feed: "user", limit: 50 });
        assert.strictEqual(page.plugins.length, 1);
        assert.strictEqual(page.pagination.next_page_token ?? null, null);
      }),
    );
  });
});

describe("ComposerExternalSuggestions", () => {
  const unsupported = () => Effect.die(new Error("Unsupported test operation"));

  const gateway = CodexGateway.of({
    promoteQueuedCatalogPage: Effect.succeed(false),
    localHostId: "local",
    requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
    requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
    events: Stream.empty,
    requestLocal: ((method: string) => {
      if (method === "config/read")
        return Effect.succeed({ config: { chatgpt_base_url: "https://chatgpt.test" } });
      throw new Error(`Unexpected request: ${method}`);
    }) as CodexGateway["Service"]["requestLocal"],
    requestOnHost: unsupported,
    requestForThread: unsupported,
    notifyLocal: unsupported,
    connection: unsupported,
    connectionChanges: () => Stream.empty,
    awaitReady: () => Effect.void,
    reconcileHost: unsupported,
    removeHost: unsupported,
    restartHost: unsupported,
  });

  const build = (chatgpt: ChatGptDesktop["Service"], scope: Scope.Closeable) =>
    Layer.buildWithScope(
      suggestionsLive.pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(CodexGateway, gateway), Layer.succeed(ChatGptDesktop, chatgpt)),
        ),
      ),
      scope,
    );

  it.effect("projects Sites and ChatGPT suggestions behind account availability", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const scope = yield* Scope.make();
      const context = yield* build(
        ChatGptDesktop.of({
          prepareRequest: () => Effect.die("unused"),
          authStatus: () => Effect.die(new Error("unused")),
          authMethod: Effect.succeed("chatgpt"),
          request: (input) => {
            requests.push(input.path);
            if (input.path === "/wham/sites/access") {
              return Effect.succeed(
                new Response(JSON.stringify({ enabled: true }), { status: 200 }),
              );
            }
            if (input.path === "/wham/apps") {
              return Effect.succeed(
                new Response(
                  JSON.stringify({
                    result: {
                      structuredContent: {
                        items: [{ id: "site-a", slug: "site-a", title: "Site A" }],
                      },
                    },
                  }),
                  { status: 200 },
                ),
              );
            }
            return Effect.succeed(
              new Response(
                JSON.stringify({ items: [{ conversation_id: "chat-a", title: "Chat A" }] }),
                { status: 200 },
              ),
            );
          },
        }),
        scope,
      );
      const suggestions = Context.get(context, ComposerExternalSuggestions);
      assert.deepEqual(yield* suggestions.listSites, {
        available: true,
        sites: [
          {
            id: "site-a",
            title: "Site A",
            slug: "site-a",
            currentLiveUrl: null,
            path: "sites-project://site-a",
          },
        ],
      });
      assert.deepEqual(yield* suggestions.listChatGptConversations(" agent "), {
        available: true,
        conversations: [
          {
            conversationId: "chat-a",
            title: "Chat A",
            path: "chatgpt-conversation://chat-a",
          },
        ],
      });
      assert.include(requests.at(-1) ?? "", "/conversations/search?query=agent");
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("returns unavailable without issuing ChatGPT requests for API-key accounts", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* build(
        ChatGptDesktop.of({
          prepareRequest: () => Effect.die("unused"),
          authStatus: () => Effect.die(new Error("unused")),
          authMethod: Effect.succeed("apikey"),
          request: () => Effect.die(new Error("request should not run")),
        }),
        scope,
      );
      const suggestions = Context.get(context, ComposerExternalSuggestions);
      assert.deepEqual(yield* suggestions.listSites, { available: false, sites: [] });
      assert.deepEqual(yield* suggestions.listChatGptConversations(""), {
        available: false,
        conversations: [],
      });
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it("rejects failed Sites payloads and deduplicates malformed conversation rows", () => {
    assert.deepEqual(
      parseComposerSitesToolResponse({
        result: { isError: true, structuredContent: { items: [] } },
      }),
      [],
    );
    assert.deepEqual(
      parseComposerChatGptConversations({
        items: [
          { conversation_id: "conversation-1", title: null },
          { id: "conversation-1", title: "duplicate" },
          { id: "", title: "invalid" },
        ],
      }),
      [
        {
          conversationId: "conversation-1",
          title: "",
          path: "chatgpt-conversation://conversation-1",
        },
      ],
    );
  });
});

describe("CodexToolRuntime", () => {
  it.effect("gates app discovery and coalesces concurrent status reads", () =>
    Effect.gen(function* () {
      const statusResponse = yield* Deferred.make<unknown>();
      let statusRequests = 0;
      const statusParams: unknown[] = [];
      const requestLocal = ((method: string, params: unknown) => {
        if (method === "app/list") {
          const cursor = (params as { cursor?: string | null }).cursor;
          return Effect.succeed({
            data:
              cursor === null
                ? [
                    {
                      id: "app-a",
                      name: "App A",
                      description: null,
                      logoUrl: "https://example.com/app.png",
                      logoUrlDark: null,
                      iconAssets: null,
                      iconDarkAssets: null,
                      distributionChannel: null,
                      branding: null,
                      appMetadata: null,
                      labels: null,
                      installUrl: null,
                      isAccessible: true,
                      isEnabled: true,
                      pluginDisplayNames: [],
                    },
                  ]
                : [],
            nextCursor: cursor === null ? "next" : null,
          });
        }
        if (method === "mcpServerStatus/list") {
          statusRequests += 1;
          statusParams.push(params);
          return Deferred.await(statusResponse);
        }
        if (method === "mcpServer/resource/read") {
          return Effect.succeed({ contents: [], originCallId: null });
        }
        if (method === "mcpServer/tool/call") return Effect.succeed({ content: [] });
        throw new Error(`Unexpected request: ${method}`);
      }) as CodexGateway["Service"]["requestLocal"];
      const unsupported = () => Effect.die(new Error("Unsupported test operation"));
      const gateway = CodexGateway.of({
        promoteQueuedCatalogPage: Effect.succeed(false),
        localHostId: "local",
        requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
        requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
        events: Stream.empty,
        requestLocal,
        requestOnHost: (_hostId, method, params) => requestLocal(method, params),
        requestForThread: (_threadId, method, params) => requestLocal(method, params),
        notifyLocal: unsupported,
        connection: () => unsupported(),
        connectionChanges: () => Stream.empty,
        awaitReady: () => Effect.void,
        reconcileHost: unsupported,
        removeHost: unsupported,
        restartHost: unsupported,
      });
      const accountSnapshot = yield* SubscriptionRef.make<CodexAccountSnapshot>({
        ...signedOutAccountSnapshot(),
        account: { type: "chatgpt" as const, email: "agent@example.com", planType: "plus" },
      });
      const account = CodexAccount.of({
        snapshot: accountSnapshot,
        refresh: unsupported(),
        readUsageLimits: unsupported(),
        consumeRateLimitResetCredit: unsupported,
        startLogin: unsupported,
        cancelLogin: unsupported,
        logout: unsupported(),
      });
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        codexToolRuntimeLive({ supportsChatGptApps: true }).pipe(
          Layer.provide(
            Layer.merge(Layer.succeed(CodexGateway, gateway), Layer.succeed(CodexAccount, account)),
          ),
        ),
        scope,
      );
      const runtime = Context.get(context, CodexToolRuntime);

      assert.deepEqual(
        (yield* runtime.listApps).map((app) => app.id),
        ["app-a"],
      );
      assert.deepEqual(yield* runtime.readResource({ server: "docs", uri: "docs://effect" }), {
        contents: [],
        originCallId: null,
      });
      assert.deepEqual(
        yield* runtime.callTool({
          threadId: "thread-1",
          server: "docs",
          tool: "search",
          arguments: { query: "Effect" },
        }),
        { content: [] },
      );
      const first = yield* runtime.listServerStatuses().pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const second = yield* runtime.listServerStatuses().pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.strictEqual(statusRequests, 1);
      yield* Deferred.succeed(statusResponse, { data: [], nextCursor: null });
      assert.deepEqual(yield* Fiber.join(first), { data: [], nextCursor: null });
      assert.deepEqual(yield* Fiber.join(second), { data: [], nextCursor: null });
      assert.deepEqual(yield* runtime.listServerStatuses("thread-1"), {
        data: [],
        nextCursor: null,
      });
      assert.strictEqual(statusRequests, 2);
      assert.deepEqual(statusParams, [
        { cursor: null, detail: "full", limit: 100 },
        { cursor: null, detail: "full", limit: 100, threadId: "thread-1" },
      ]);

      yield* Scope.close(scope, Exit.void);
    }),
  );
});
