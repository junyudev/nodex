import type { PluginInstalledResponse } from "@nodex/codex-app-server-protocol/v2/PluginInstalledResponse";
import type { PluginSummary } from "@nodex/codex-app-server-protocol/v2/PluginSummary";
import type { PluginRow } from "../../shared/codex-plugin-management";
import {
  isOfficialMarketplace,
  pluginActionState,
  pluginStableIdentity,
} from "../../shared/codex-plugin-management-model";
import { resolveComposerInventoryIconUrl } from "../../shared/codex-composer-inventory-icon";
import {
  isForeignDesktopToolPlugin,
  nodexDesktopToolMarketplaceName,
} from "../codex/bundled-desktop-tool-marketplace";

/** Shared admission policy for full management inventory and composer suggestions. */
export function createPluginInventoryPolicy(runtimeStateHome: string) {
  const marketplaceName = nodexDesktopToolMarketplaceName(runtimeStateHome);
  const managedIds = new Set(
    ["browser", "chrome", "computer-use"].map((name) => `${name}@${marketplaceName}`),
  );
  const managed = (id: string, hostId: string) => hostId === "local" && managedIds.has(id);
  const visible = (id: string, hostId: string) =>
    hostId !== "local" || !isForeignDesktopToolPlugin(id, runtimeStateHome);
  const project = <T extends PluginInstalledResponse>(response: T, hostId: string): T => ({
    ...response,
    marketplaces: response.marketplaces.map((marketplace) => ({
      ...marketplace,
      plugins: marketplace.plugins
        .filter((plugin) => visible(plugin.id, hostId))
        .map((plugin) =>
          managed(plugin.id, hostId) && plugin.installed ? { ...plugin, enabled: true } : plugin,
        ),
    })),
  });
  const iconResolver =
    (
      hostId: string,
      authorizeHostFile: (input: { hostId: string; path: string }) => string | null,
    ) =>
    (path: string) =>
      hostId === "local"
        ? resolveComposerInventoryIconUrl(path)
        : authorizeHostFile({ hostId, path });
  const rows = (
    response: PluginInstalledResponse,
    hostId: string,
    authorize: (path: string) => string | null,
    personalMarketplacePath: string | null = null,
  ): PluginRow[] =>
    project(response, hostId).marketplaces.flatMap((marketplace) =>
      marketplace.plugins.map((summary): PluginRow => {
        const identity = {
          name: marketplace.name,
          path: marketplace.path,
          displayName: marketplace.interface?.displayName ?? null,
        };
        const isManaged = managed(summary.id, hostId);
        const canUninstall =
          summary.installed && !isManaged && summary.installPolicy !== "INSTALLED_BY_DEFAULT";
        const state = summary.installed ? "installed" : "not_installed";
        return {
          summary,
          marketplace: identity,
          selector:
            marketplace.path !== null
              ? { marketplacePath: marketplace.path, pluginName: summary.name }
              : {
                  remoteMarketplaceName: marketplace.name,
                  pluginName:
                    summary.remotePluginId ?? summary.shareContext?.remotePluginId ?? summary.id,
                },
          stableIdentity: pluginStableIdentity(summary),
          nativeId: summary.id,
          logoUrl: authorizedIcon(summary, "logo", authorize),
          logoDarkUrl: authorizedIcon(summary, "dark", authorize),
          composerIconUrl: authorizedIcon(summary, "composer", authorize),
          managed: isManaged,
          canUninstall,
          canSetEnabled:
            summary.installed && !isManaged && summary.availability !== "DISABLED_BY_ADMIN",
          installState: state,
          actionState: pluginActionState(summary, state),
          isPersonal:
            marketplace.name === "created-by-me-remote" ||
            (personalMarketplacePath !== null && marketplace.path === personalMarketplacePath),
          isOfficial: isOfficialMarketplace(identity),
        };
      }),
    );
  return { marketplaceName, managed, visible, project, rows, iconResolver };
}
export const safeRemoteIcon = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};
export const authorizedPluginAsset = (
  local: string | null | undefined,
  remote: string | null | undefined,
  authorize: (path: string) => string | null,
): string | null => (local ? authorize(local) : null) ?? safeRemoteIcon(remote);
function authorizedIcon(
  summary: PluginSummary,
  kind: "logo" | "dark" | "composer",
  authorize: (path: string) => string | null,
): string | null {
  const ui = summary.interface;
  if (!ui) return null;
  const local = kind === "logo" ? ui.logo : kind === "dark" ? ui.logoDark : ui.composerIcon;
  const remote =
    kind === "logo" ? ui.logoUrl : kind === "dark" ? ui.logoUrlDark : ui.composerIconUrl;
  return authorizedPluginAsset(local, remote, authorize);
}
