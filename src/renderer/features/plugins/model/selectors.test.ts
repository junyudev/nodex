import { describe, expect, it } from "vitest";
import {
  pluginRow,
  pluginSummary,
  pluginInterface,
} from "../../../../shared/test-fixtures/plugins";
import {
  buildLocalPluginSections,
  selectInstalledPlugins,
  dedupePluginRows,
  mergeInstalledRows,
  mergePluginSections,
  pluginActionState,
  normalizePluginSearch,
  pluginMatchesSearch,
  isOfficialMarketplace,
  routeTargetToSelector,
  selectorToRouteTarget,
  selectSkills,
  skillMatchKeys,
  groupPersonalPlugins,
} from "./selectors";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
const row = (id: string, installedAt = 0) =>
  pluginRow({
    nativeId: id,
    stableIdentity: id,
    summary: pluginSummary({ id, name: id, installedAt }),
  });
describe("plugin inventory selectors", () => {
  it("retains disabled installed rows, sorts newest first, and places admin-disabled last", () => {
    const disabled = row("disabled", 100);
    const admin = row("admin", 200);
    const values = [
      row("old", 1),
      { ...admin, summary: { ...admin.summary, availability: "DISABLED_BY_ADMIN" as const } },
      { ...disabled, summary: { ...disabled.summary, enabled: false } },
      row("new", 50),
    ];
    expect(selectInstalledPlugins(values).map((item) => item.nativeId)).toEqual([
      "disabled",
      "new",
      "old",
      "admin",
    ]);
  });
  it("deduplicates remote identity while preferring installed checkouts", () => {
    const remote = pluginRow({
      marketplace: { name: "remote", path: null, displayName: null },
      summary: pluginSummary({ installed: false }),
      stableIdentity: "remote-id",
    });
    const local = pluginRow({ stableIdentity: "remote-id" });
    expect(dedupePluginRows([remote, local])).toEqual([local]);
    const rich = pluginRow({
      summary: pluginSummary({ interface: pluginInterface({ displayName: "Detailed" }) }),
    });
    expect(dedupePluginRows([pluginRow(), rich])).toEqual([rich]);
  });
  it("merges fresh listing metadata with the installed checkout identity and exact selector", () => {
    const checkout = pluginRow({
      nativeId: "checkout@personal",
      stableIdentity: "remote-id",
      isPersonal: true,
      summary: pluginSummary({
        id: "checkout@personal",
        name: "checkout",
        remotePluginId: "remote-id",
        localVersion: "1.0",
      }),
      selector: { marketplacePath: "/personal.json", pluginName: "checkout" },
    });
    const listing = pluginRow({
      nativeId: "listing@remote",
      stableIdentity: "remote-id",
      marketplace: { name: "public", path: null, displayName: null },
      selector: { remoteMarketplaceName: "public", pluginName: "remote-id" },
      summary: pluginSummary({
        id: "listing@remote",
        installed: false,
        version: "2.0",
        source: { type: "remote" },
        keywords: ["fresh"],
      }),
    });
    const merged = mergeInstalledRows([listing], [checkout])[0]!;
    expect(merged.summary).toMatchObject({
      id: "checkout@personal",
      installed: true,
      localVersion: "1.0",
      version: "2.0",
      keywords: ["fresh"],
      source: checkout.summary.source,
    });
    expect(merged.selector).toEqual(checkout.selector);
    expect(merged.isPersonal).toBe(true);
    expect(mergeInstalledRows([listing], [])[0]?.summary.installed).toBe(false);
  });
  it("keeps the newest installed duplicate before sorting the sidebar", () => {
    const older = { ...row("older", 1), stableIdentity: "shared" };
    const newer = { ...row("newer", 100), stableIdentity: "shared" };
    expect(
      selectInstalledPlugins([older, row("middle", 50), newer]).map((row) => row.nativeId),
    ).toEqual(["newer", "middle"]);
  });
  it("builds truthful fallback sections, preserves featured order, caps at nine and omits managed tools", () => {
    const values = Array.from({ length: 12 }, (_, i) => row(`p${i}`));
    const sections = buildLocalPluginSections(
      [...values, pluginRow({ managed: true })],
      ["p2", "p1"],
    );
    expect(sections.map((section) => section.title)).toEqual(["Featured", "Other"]);
    expect(sections[0]?.plugins.map((item) => item.nativeId)).toEqual(["p2", "p1"]);
    expect(sections[1]?.plugins).toHaveLength(9);
    expect(sections.every((section) => section.urlSlug === null)).toBe(true);
  });
  it("preserves server section order, first title, latest slug and plugin order", () => {
    const sections = mergePluginSections([
      { id: "b", title: "B", urlSlug: null, plugins: [row("1")] },
      { id: "a", title: "A", urlSlug: null, plugins: [row("2")] },
      { id: "b", title: "ignored", urlSlug: "b", plugins: [row("3")] },
    ]);
    expect(sections.map((section) => section.id)).toEqual(["b", "a"]);
    expect(sections[0]).toMatchObject({ title: "B", urlSlug: "b" });
    expect(sections[0]?.plugins.map((item) => item.nativeId)).toEqual(["1", "3"]);
  });
  it("uses the card action precedence, including unknown installation state", () => {
    const admin = pluginSummary({
      availability: "DISABLED_BY_ADMIN",
      installPolicy: "NOT_AVAILABLE",
    });
    expect(pluginActionState(admin, "installed")).toBe("installed_menu");
    expect(pluginActionState(admin, "not_installed")).toBe("admin_disabled");
    expect(
      pluginActionState(pluginSummary({ installPolicy: "NOT_AVAILABLE" }), "not_installed"),
    ).toBe("unavailable");
    expect(pluginActionState(pluginSummary(), "unknown")).toBe("loading");
    expect(pluginActionState(pluginSummary(), "not_installed", true)).toBe("loading");
  });
  it("normalizes search punctuation without matching description by default", () => {
    const value = pluginRow({
      summary: pluginSummary({ name: "Hello_world", keywords: ["a-b"], interface: null }),
    });
    expect(normalizePluginSearch(" HéLLo__World! ")).toBe("h llo world");
    expect(pluginMatchesSearch(value, "hello-world")).toBe(true);
    expect(pluginMatchesSearch(value, "a b")).toBe(true);
    expect(pluginMatchesSearch(value, "unrelated")).toBe(false);
  });
  it("classifies official names exactly and round trips local and remote selectors", () => {
    expect(
      isOfficialMarketplace({ name: "custom", displayName: " OpenAI Curated Remote ", path: null }),
    ).toBe(true);
    expect(
      isOfficialMarketplace({ name: "openai-curated-imitation", displayName: null, path: null }),
    ).toBe(false);
    for (const selector of [
      { marketplacePath: "/catalog.json", pluginName: "local" },
      { remoteMarketplaceName: "public", pluginName: "opaque-remote-id" },
    ])
      expect(
        routeTargetToSelector(selectorToRouteTarget({ selector, nativeId: "native" })),
      ).toEqual(selector);
  });
  it("groups personal checkouts before remote copies and disambiguates imported marketplace labels", () => {
    const values = ["a", "b"].map((part) =>
      pluginRow({
        isOfficial: false,
        marketplace: { name: part, path: `/repos/${part}/marketplace.json`, displayName: "Tools" },
        nativeId: part,
        stableIdentity: part,
      }),
    );
    const own = pluginRow({ isPersonal: true, stableIdentity: "own" });
    const result = groupPersonalPlugins(
      [...values, own],
      [
        pluginRow({
          stableIdentity: "own",
          marketplace: { name: "remote", path: null, displayName: null },
        }),
      ],
    );
    expect(result.createdByYou).toEqual([own]);
    expect(result.marketplaces.map((group) => group.label)).toEqual([
      "Tools (a/marketplace.json)",
      "Tools (b/marketplace.json)",
    ]);
  });
});
it("chooses skill scope precedence and excludes plugin-owned skills while retaining system skills", () => {
  const skill = (
    name: string,
    scope: SkillMetadata["scope"],
    path: string,
    pluginId: string | null = null,
  ): SkillMetadata => ({ name, scope, path, pluginId, enabled: true, description: "test" });
  const repo = skill("hello-world", "repo", "/repo/skills/hello-world/SKILL.md");
  const response = selectSkills({
    data: [
      {
        cwd: "/",
        errors: [],
        skills: [
          skill("hello-world", "user", "/user/SKILL.md"),
          repo,
          skill("sys", "system", "/system/sys/SKILL.md"),
          skill("owned", "user", "/owned/SKILL.md", "plugin"),
        ],
      },
    ],
  });
  expect(response.installed).toHaveLength(2);
  expect(response.project).toEqual([repo]);
  expect(response.system.map((item) => item.name)).toEqual(["sys"]);
  expect(skillMatchKeys(repo)).toEqual(
    expect.arrayContaining(["hello-world", "hello world", "helloworld"]),
  );
  expect(response.matchKeys).toContain("owned");
});
