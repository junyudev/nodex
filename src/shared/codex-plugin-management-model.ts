import type {
  PluginSummary,
  PluginRow,
  PluginSection,
  PluginSelector,
  PluginRouteTarget,
  PluginMarketplaceIdentity,
  PersonalPlugins,
  SkillsView,
  PluginActionState,
} from "./codex-plugin-management";
import type { SkillsListResponse } from "@nodex/codex-app-server-protocol/v2/SkillsListResponse";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";

export const pluginStableIdentity = (plugin: PluginSummary): string =>
  plugin.remotePluginId ?? plugin.shareContext?.remotePluginId ?? plugin.id;
export const normalizePluginSearch = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
export const pluginMatchesSearch = (row: PluginRow, term: string): boolean => {
  const normalized = normalizePluginSearch(term);
  return (
    !normalized ||
    normalizePluginSearch(
      [row.summary.interface?.displayName ?? row.summary.name, ...row.summary.keywords].join(" "),
    ).includes(normalized)
  );
};
const officialNames = new Set([
  "codex-official",
  "openai-bundled",
  "openai-curated",
  "openai-curated-remote",
  "openai-primary-runtime",
]);
export const isOfficialMarketplace = (marketplace: PluginMarketplaceIdentity): boolean =>
  [marketplace.name, marketplace.displayName].some(
    (name) => name !== null && officialNames.has(normalizePluginSearch(name).replaceAll(" ", "-")),
  );
export const pluginActionState = (
  summary: PluginSummary,
  installed: PluginRow["installState"],
  pending = false,
): PluginActionState => {
  if (pending) return "loading";
  if (installed === "installed") return "installed_menu";
  if (summary.availability === "DISABLED_BY_ADMIN") return "admin_disabled";
  if (summary.installPolicy === "NOT_AVAILABLE") return "unavailable";
  if (installed === "unknown") return "loading";
  return "install";
};
export const selectorToRouteTarget = (
  row: Pick<PluginRow, "nativeId" | "selector">,
): PluginRouteTarget => ({
  pluginId: row.nativeId,
  pluginName: row.selector.pluginName,
  marketplace:
    row.selector.marketplacePath !== undefined
      ? { kind: "local", marketplacePath: row.selector.marketplacePath }
      : { kind: "remote", remoteMarketplaceName: row.selector.remoteMarketplaceName },
});
export const routeTargetToSelector = (target: PluginRouteTarget): PluginSelector =>
  target.marketplace.kind === "local"
    ? { marketplacePath: target.marketplace.marketplacePath, pluginName: target.pluginName }
    : {
        remoteMarketplaceName: target.marketplace.remoteMarketplaceName,
        pluginName: target.pluginName,
      };

/** A checkout wins over its remote listing; installed state wins over an uninstalled duplicate. */
export function dedupePluginRows(rows: readonly PluginRow[]): PluginRow[] {
  const result = new Map<string, PluginRow>();
  for (const row of rows) {
    const previous = result.get(row.stableIdentity);
    if (
      !previous ||
      (!previous.summary.installed && row.summary.installed) ||
      (previous.summary.installed === row.summary.installed &&
        previous.marketplace.path === null &&
        row.marketplace.path !== null)
    )
      result.set(row.stableIdentity, row);
  }
  return [...result.values()];
}
export function mergeInstalledRows(
  directory: readonly PluginRow[],
  installed: readonly PluginRow[],
): PluginRow[] {
  const installedById = new Map(installed.map((row) => [row.stableIdentity, row]));
  return dedupePluginRows(
    directory.map((row) => {
      const match = installedById.get(row.stableIdentity);
      if (!match)
        return {
          ...row,
          installState: "not_installed" as const,
          actionState: pluginActionState(row.summary, "not_installed"),
        };
      const summary = {
        ...row.summary,
        installed: match.summary.installed,
        installedAt: match.summary.installedAt,
        enabled: match.summary.enabled,
        localVersion: match.summary.localVersion,
        installPolicy: match.summary.installPolicy,
        installPolicySource: match.summary.installPolicySource,
      };
      return {
        ...row,
        summary,
        nativeId: match.nativeId,
        managed: match.managed,
        canUninstall: match.canUninstall,
        canSetEnabled: match.canSetEnabled,
        logoUrl: row.logoUrl ?? match.logoUrl,
        logoDarkUrl: row.logoDarkUrl ?? match.logoDarkUrl,
        composerIconUrl: row.composerIconUrl ?? match.composerIconUrl,
        installState: match.installState,
        actionState: pluginActionState(summary, match.installState),
      };
    }),
  );
}
export const selectInstalledPlugins = (rows: readonly PluginRow[], search = ""): PluginRow[] =>
  dedupePluginRows(rows.filter((row) => row.summary.installed))
    .filter((row) => pluginMatchesSearch(row, search))
    .sort(
      (a, b) =>
        Number(a.summary.availability === "DISABLED_BY_ADMIN") -
          Number(b.summary.availability === "DISABLED_BY_ADMIN") ||
        (b.summary.installedAt ?? 0) - (a.summary.installedAt ?? 0),
    );

export function buildLocalPluginSections(
  rows: readonly PluginRow[],
  featuredPluginIds: readonly string[],
): PluginSection[] {
  const publicRows = dedupePluginRows(rows.filter((row) => row.isOfficial && !row.managed));
  const byId = new Map(
    publicRows.flatMap(
      (row) =>
        [
          [row.nativeId, row],
          [row.stableIdentity, row],
        ] as const,
    ),
  );
  const seen = new Set<string>();
  const take = (candidates: readonly PluginRow[]) =>
    candidates.filter((row) => {
      if (seen.has(row.stableIdentity)) return false;
      seen.add(row.stableIdentity);
      return true;
    });
  const featured = take(featuredPluginIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])));
  const categories = new Map<string, PluginRow[]>();
  for (const row of publicRows) {
    if (seen.has(row.stableIdentity)) continue;
    const category = row.summary.interface?.category?.trim() || "Other";
    categories.set(category, [...(categories.get(category) ?? []), row]);
  }
  return [
    ...(featured.length
      ? [{ id: "featured", title: "Featured", urlSlug: null, plugins: featured.slice(0, 9) }]
      : []),
    ...[...categories]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([title, plugins]) => ({
        id: `plugins-${normalizePluginSearch(title).replaceAll(" ", "-")}`,
        title,
        urlSlug: null,
        plugins: take(plugins).slice(0, 9),
      })),
  ].filter((section) => section.plugins.length > 0);
}
export function mergePluginSections(sections: readonly PluginSection[]): PluginSection[] {
  const byId = new Map<string, PluginSection>();
  for (const section of sections) {
    const previous = byId.get(section.id);
    byId.set(
      section.id,
      previous
        ? {
            ...previous,
            urlSlug: section.urlSlug ?? previous.urlSlug,
            plugins: dedupePluginRows([...previous.plugins, ...section.plugins]).slice(0, 9),
          }
        : { ...section, plugins: dedupePluginRows(section.plugins).slice(0, 9) },
    );
  }
  return [...byId.values()].filter((section) => section.plugins.length > 0);
}
const marketplaceKey = (m: PluginMarketplaceIdentity) => JSON.stringify([m.name, m.path]);
export function groupPersonalPlugins(
  rows: readonly PluginRow[],
  created: readonly PluginRow[] = [],
  shared: readonly PluginRow[] = [],
): PersonalPlugins {
  const localCreated = rows.filter((row) => row.isPersonal);
  const createdByYou = dedupePluginRows([...localCreated, ...created]);
  const createdIds = new Set(createdByYou.map((row) => row.stableIdentity));
  const groups = new Map<
    string,
    { identity: PluginMarketplaceIdentity; label: string; plugins: PluginRow[] }
  >();
  for (const row of rows.filter((row) => !row.isOfficial && !row.isPersonal)) {
    const key = marketplaceKey(row.marketplace);
    const group = groups.get(key) ?? {
      identity: row.marketplace,
      label: row.marketplace.displayName ?? row.marketplace.name,
      plugins: [],
    };
    group.plugins.push(row);
    groups.set(key, group);
  }
  const marketplaces = [...groups.values()]
    .map((group, _, all) => {
      const duplicates = all.filter((item) => item.label === group.label);
      if (duplicates.length < 2) return group;
      const parts = (group.identity.path ?? group.identity.name).split("/").filter(Boolean);
      let suffix = parts.join("/");
      for (let length = 1; length <= parts.length; length++) {
        const candidate = parts.slice(-length).join("/");
        if (
          duplicates.every(
            (item) =>
              item === group ||
              !(item.identity.path ?? item.identity.name).endsWith(`/${candidate}`),
          )
        ) {
          suffix = candidate;
          break;
        }
      }
      return { ...group, label: `${group.label} (${suffix})` };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  return {
    createdByYou,
    sharedWithYou: dedupePluginRows(shared).filter((row) => !createdIds.has(row.stableIdentity)),
    marketplaces,
  };
}
const humanize = (value: string) => value.replace(/[-_]+/gu, " ");
export function skillMatchKeys(skill: SkillMetadata): string[] {
  const directory =
    skill.path
      .replaceAll("\\", "/")
      .replace(/\/SKILL\.md$/iu, "")
      .split("/")
      .at(-1) ?? "";
  return [
    ...new Set(
      [directory, skill.name, humanize(skill.name), skill.interface?.displayName ?? ""]
        .flatMap((key) => [key.trim().toLowerCase(), key.toLowerCase().replace(/[^a-z0-9]/gu, "")])
        .filter(Boolean),
    ),
  ];
}
export function selectSkills(response: SkillsListResponse): SkillsView {
  const byPath = new Map(
    response.data.flatMap((entry) => entry.skills).map((skill) => [skill.path, skill]),
  );
  const priority = { repo: 0, user: 1, system: 2, admin: 3 };
  const byName = new Map<string, SkillMetadata>();
  for (const skill of [...byPath.values()].sort(
    (a, b) => priority[a.scope] - priority[b.scope] || a.path.localeCompare(b.path),
  ))
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  const all = [...byName.values()].sort(
    (a, b) =>
      (a.interface?.displayName ?? humanize(a.name)).localeCompare(
        b.interface?.displayName ?? humanize(b.name),
      ) || a.name.localeCompare(b.name),
  );
  const installed = all.filter((skill) => !skill.pluginId && !skill.path.startsWith("plugin://"));
  return {
    installed,
    personal: installed.filter((skill) => skill.scope === "user"),
    system: installed.filter((skill) => skill.scope === "system"),
    project: installed.filter((skill) => skill.scope === "repo"),
    admin: installed.filter((skill) => skill.scope === "admin"),
    matchKeys: [...new Set(all.flatMap(skillMatchKeys))],
  };
}
