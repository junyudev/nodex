import { describe, expect } from "vite-plus/test";
import { it } from "vitest";
import type { ConfigReadResponse } from "@nodex/codex-app-server-protocol/v2/ConfigReadResponse";
import type { ConfigLayerSource } from "@nodex/codex-app-server-protocol/v2/ConfigLayerSource";
import { pluginAppPolicy } from "./PluginAppPolicy";
import { pluginSummary } from "../../shared/test-fixtures/plugins";
import {
  createPluginInventoryPolicy,
  safeRemoteIcon,
  authorizedPluginAsset,
} from "./PluginInventoryPolicy";
import { assert, it as itPluginAccountMetadata } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makePluginAccountMetadata } from "./PluginAccountMetadata";
import { ChatGptDesktop } from "./ChatGptDesktop";
import { PluginServiceAccount } from "./PluginService";
import type { ChatGptDesktopRequestInput } from "../codex/chatgpt-desktop-request";
import type { SkillSummary } from "@nodex/codex-app-server-protocol/v2/SkillSummary";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import { matchPluginDetailSkill, projectPluginMcpServers } from "./PluginDetailModel";

describe("PluginAppPolicy", () => {
  const config = (
    name?: ConfigLayerSource,
    key = "apps.connector_test.enabled",
    apps: unknown = { connector_test: { enabled: false } },
  ): ConfigReadResponse =>
    ({
      config: { apps },
      origins: name ? { [key]: { name, version: "v1" } } : {},
      layers: [
        {
          name: { type: "user", file: "/config.toml", profile: null },
          version: "v1",
          config: {},
          disabledReason: null,
        },
      ],
    }) as ConfigReadResponse;
  it("allows user/default app switches while protecting managed, profile, project and session origins", () => {
    for (const name of [
      undefined,
      { type: "user", file: "/config.toml", profile: null },
      { type: "system", file: "/etc/config.toml" },
    ] as const)
      expect(pluginAppPolicy(config(name), "connector_test").editable).toBe(true);
    for (const name of [
      { type: "enterpriseManaged", id: "org", name: "Org" },
      { type: "mdm", domain: "app", key: "config" },
      { type: "project", dotCodexFolder: "/repo/.codex" },
      { type: "sessionFlags" },
      { type: "user", file: "/config.toml", profile: "work" },
    ] as const)
      expect(pluginAppPolicy(config(name), "connector_test").editRestriction?.code).toBe(
        "policy_denied",
      );
    expect(pluginAppPolicy(config(), "connector_test", true).editable).toBe(false);
    expect(pluginAppPolicy(null, "connector_test").editRestriction?.code).toBe(
      "inventory_unavailable",
    );
  });
  it("applies default restrictions and cannot bypass connector alias policy", () => {
    const managed = { type: "enterpriseManaged", id: "org", name: "Org" } as const;
    expect(
      pluginAppPolicy(
        config(managed, "apps._default.enabled", { _default: { enabled: false } }),
        "connector_test",
      ).editable,
    ).toBe(false);
    expect(pluginAppPolicy(config(managed), "asdk_app_test").editable).toBe(false);
    expect(pluginAppPolicy(config(), "asdk_app_test").configKey).toBe("connector_test");
  });
  it("protects tool-specific policy and disables editing under a disabled parent app", () => {
    expect(
      pluginAppPolicy(
        config({ type: "sessionFlags" }, 'apps."connector.with.dot".tools.read.enabled', {
          "connector.with.dot": { enabled: true },
        }),
        "connector.with.dot",
        false,
        "read",
      ).editable,
    ).toBe(false);
    expect(
      pluginAppPolicy(
        config(
          { type: "project", dotCodexFolder: "/repo" },
          "apps.connector_test.tools.read.files.enabled",
          { connector_test: { enabled: true } },
        ),
        "connector_test",
        false,
        "read.files",
      ).editRestriction?.code,
    ).toBe("policy_denied");
    expect(
      pluginAppPolicy(config(), "connector_test", false, "read.files").editRestriction?.code,
    ).toBe("protected");
    expect(
      pluginAppPolicy(
        config(undefined, undefined, { connector_test: { enabled: true } }),
        "connector_test",
        false,
        "read.files",
      ).editable,
    ).toBe(true);
  });
});

describe("PluginInventoryPolicy", () => {
  const policy = createPluginInventoryPolicy("/tmp/plugin-policy");
  describe("plugin inventory policy", () => {
    it("hides only foreign local desktop copies, retains disabled/admin rows and protects managed tools", () => {
      const id = `browser@${policy.marketplaceName}`;
      const inventory = {
        marketplaces: [
          {
            name: "tools",
            path: "/catalog",
            interface: null,
            plugins: [
              pluginSummary({ id, enabled: false }),
              pluginSummary({ id: "browser@openai-bundled" }),
              pluginSummary({ id: "browser@custom", enabled: false }),
              pluginSummary({ id: "admin@custom", availability: "DISABLED_BY_ADMIN" }),
            ],
          },
        ],
        marketplaceLoadErrors: [],
      };
      const rows = policy.rows(inventory, "local", () => "app://authorized");
      expect(rows.map((row) => row.nativeId)).toEqual([id, "browser@custom", "admin@custom"]);
      expect(rows[0]).toMatchObject({
        managed: true,
        canUninstall: false,
        canSetEnabled: false,
        summary: { enabled: true },
      });
      expect(rows[1]?.summary.enabled).toBe(false);
      expect(policy.rows(inventory, "remote", () => null)).toHaveLength(4);
      expect(policy.managed(id, "remote")).toBe(false);
    });
    it("authorizes local icons, rejects unsafe remote URLs and keeps remote selectors opaque", () => {
      const summary = pluginSummary({ remotePluginId: "opaque-id", source: { type: "remote" } });
      const rows = policy.rows(
        {
          marketplaces: [{ name: "remote", path: null, interface: null, plugins: [summary] }],
          marketplaceLoadErrors: [],
        },
        "local",
        () => null,
      );
      expect(safeRemoteIcon("file:///private/logo.png")).toBeNull();
      expect(safeRemoteIcon("javascript:alert(1)")).toBeNull();
      expect(safeRemoteIcon("https://example.com/logo.png")).toBe("https://example.com/logo.png");
      expect(rows[0]?.selector).toEqual({
        remoteMarketplaceName: "remote",
        pluginName: "opaque-id",
      });
      expect(policy.iconResolver("remote", () => "app://host-image")("/some/path")).toBe(
        "app://host-image",
      );
    });
  });
});

describe("PluginAccountMetadata", () => {
  const it = itPluginAccountMetadata;
  const make = (body: unknown, status = 200) => {
    const calls: ChatGptDesktopRequestInput[] = [];
    const desktop = {
      request: (input: ChatGptDesktopRequestInput) => {
        calls.push(input);
        return Effect.succeed(Response.json(body, { status }));
      },
    } as unknown as ChatGptDesktop["Service"];
    return {
      calls,
      owner: makePluginAccountMetadata.pipe(Effect.provideService(ChatGptDesktop, desktop)),
    };
  };
  it.effect(
    "keeps disclosed provider categories and availability distinct from native plugin state",
    () =>
      Effect.gen(function* () {
        const h = make({
          dependencies: [
            {
              plugin_id: "provider",
              display_name: "Provider",
              categories: [{ id: "storage", label: "Storage" }],
              is_enabled: false,
              is_installed: true,
              icon_url: "https://example.test/logo.png",
              icon_url_dark: "file:///private/icon",
              availability_status: { reason: "workspace_setup_required" },
              navigation: { kind: "plugin_detail", plugin_id: "provider" },
            },
          ],
        });
        const metadata = yield* h.owner;
        const dependencies = yield* metadata.dependencies("plugin/id");
        assert.deepEqual(dependencies, [
          {
            pluginId: "provider",
            displayName: "Provider",
            categories: [{ id: "storage", label: "Storage" }],
            enabled: false,
            installed: true,
            logoUrl: "https://example.test/logo.png",
            logoDarkUrl: null,
            unavailableReason: "workspace_setup_required",
            navigationPluginId: "provider",
          },
        ]);
        assert.strictEqual(h.calls[0]?.path, "ps/plugins/plugin%2Fid");
        assert.strictEqual(new Headers(h.calls[0]?.headers).get("OAI-Product-Sku"), "CODEX");
        assert.deepEqual(h.calls[0]?.expectedAccount, { accountId: "a", userId: "u" });
      }).pipe(Effect.provideService(PluginServiceAccount, { accountId: "a", userId: "u" })),
  );
  it.effect(
    "resolves the canonical creator plugin and preserves missing or denied capabilities",
    () =>
      Effect.gen(function* () {
        const canonical = make({ plugin_id: "canonical-creator", status: "AVAILABLE" });
        assert.strictEqual(yield* (yield* canonical.owner).creatorPluginId, "canonical-creator");
        const absent = make({});
        assert.strictEqual(yield* (yield* absent.owner).dependencies("plugin"), null);
        const denied = make({}, 403);
        assert.strictEqual(
          (yield* (yield* denied.owner).creatorPluginId.pipe(Effect.flip)).code,
          "policy_denied",
        );
        const signedOut = make({});
        assert.strictEqual(
          (yield* (yield* signedOut.owner).creatorPluginId.pipe(
            Effect.provideService(PluginServiceAccount, null),
            Effect.flip,
          )).code,
          "auth_required",
        );
        assert.strictEqual(signedOut.calls.length, 0);
      }).pipe(Effect.provideService(PluginServiceAccount, { accountId: "a", userId: "u" })),
  );
});

describe("PluginDetailModel", () => {
  const manifest = (patch: Partial<SkillSummary> = {}): SkillSummary => ({
    name: "make_art",
    description: "",
    shortDescription: null,
    path: null,
    interface: null,
    enabled: true,
    ...patch,
  });
  const local = (patch: Partial<SkillMetadata> = {}): SkillMetadata => ({
    name: "image-tools:make-art",
    path: "/skills/art/SKILL.md",
    enabled: false,
    scope: "user",
    description: "",
    pluginId: "image-tools@custom",
    ...patch,
  });

  it("matches paths first, then qualified names, then a unique per-segment comparable name", () => {
    const path = local({ name: "renamed", path: "/match" });
    const exact = local({ name: "image-tools:make_art", path: "/exact" });
    expect(matchPluginDetailSkill("image-tools", manifest({ path: "/match" }), [exact, path])).toBe(
      path,
    );
    expect(matchPluginDetailSkill("image-tools", manifest(), [local(), exact])).toBe(exact);
    expect(matchPluginDetailSkill("Image Tools", manifest(), [local()])).toEqual(local());
    expect(
      matchPluginDetailSkill("ignored", manifest({ name: "Image Tools:make art" }), [local()]),
    ).toEqual(local());
    expect(
      matchPluginDetailSkill(
        "image-tools",
        manifest({ path: "/old", name: "image-tools:make_art" }),
        [local()],
      ),
    ).toEqual(local());
  });

  it("leaves ambiguous or unrelated local skills unavailable and deduplicates roots", () => {
    const skill = local();
    expect(matchPluginDetailSkill("image-tools", manifest(), [skill, skill])).toBe(skill);
    expect(
      matchPluginDetailSkill("image-tools", manifest(), [skill, local({ path: "/other" })]),
    ).toBeNull();
    expect(matchPluginDetailSkill("", manifest(), [skill])).toBeNull();
    expect(matchPluginDetailSkill("image-tools", manifest({ name: "other" }), [skill])).toBeNull();
  });

  it("authorizes local skill icons before HTTPS fallback", () => {
    expect(
      authorizedPluginAsset(
        "/icons/skill.svg",
        "https://cdn.test/skill.svg",
        (path) => `app://asset${path}`,
      ),
    ).toBe("app://asset/icons/skill.svg");
    expect(authorizedPluginAsset("relative.svg", "https://cdn.test/skill.svg", () => null)).toBe(
      "https://cdn.test/skill.svg",
    );
    expect(authorizedPluginAsset(null, "file:///secret", () => null)).toBeNull();
  });

  it("projects only unique MCP config keys and fences installation and other plugin owners", () => {
    const config = {
      config: {
        mcp_servers: {
          "art.with.dot": { name: "Art Tools", enabled: false },
          "duplicate-a": { name: "Duplicate" },
          "duplicate-b": { name: "Duplicate" },
        },
      },
    } as unknown as import("@nodex/codex-app-server-protocol/v2/ConfigReadResponse").ConfigReadResponse;
    const view = projectPluginMcpServers(
      ["Art Tools", "Duplicate"],
      "art@custom",
      true,
      true,
      config,
      [],
    );
    expect(view[0]).toEqual({
      name: "Art Tools",
      configKey: "art.with.dot",
      enabled: false,
      installed: true,
      canSetEnabled: true,
    });
    expect(view[1]?.configKey).toBeNull();
    expect(
      projectPluginMcpServers(["Art Tools"], "art@custom", false, true, config, [])[0],
    ).toMatchObject({ installed: false, configKey: null, canSetEnabled: false });
    expect(
      projectPluginMcpServers(["Art Tools"], "art@custom", true, true, config, [
        { name: "art.with.dot", pluginId: "other@custom" } as never,
      ])[0]?.canSetEnabled,
    ).toBe(false);
  });
});
