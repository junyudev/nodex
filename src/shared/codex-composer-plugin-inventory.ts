import type { PluginInstalledResponse } from "@nodex/codex-app-server-protocol/v2/PluginInstalledResponse";
import type { PluginInstallParams } from "@nodex/codex-app-server-protocol/v2/PluginInstallParams";
import type { ConfigBatchWriteParams } from "@nodex/codex-app-server-protocol/v2/ConfigBatchWriteParams";
import type { CodexComposerPlugin } from "./types";
import {
  resolveComposerInventoryIconUrl,
  type ComposerInventoryIconResolver,
} from "./codex-composer-inventory-icon";

export const COMPOSER_INSTALL_SUGGESTION_PLUGIN_NAMES = [
  "computer-use",
  "browser",
  "chrome-dev",
  "chrome-internal",
  "chrome",
  "spreadsheets",
  "presentations",
  "record-and-replay",
] as const;

interface ComposerPluginInventoryOptions {
  readonly installSuggestionPluginNames?: readonly string[];
}

export type ComposerPluginActivationResolution =
  | { readonly kind: "active" }
  | {
      readonly kind: "enable";
      readonly params: ConfigBatchWriteParams;
    }
  | {
      readonly kind: "install";
      readonly params: PluginInstallParams;
    };

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function normalizeDefaultPrompt(value: readonly string[] | null | undefined): string | null {
  for (const candidate of value ?? []) {
    const normalized = normalizeOptionalText(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeRemoteImageUrl(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function resolveComposerPluginNames(input: {
  readonly name: string;
  readonly displayName: string | null;
}): { readonly name: string; readonly displayName: string } {
  if (input.name === "browser") {
    return { name: "Browser", displayName: "Browser" };
  }
  if (input.name === "computer-use") {
    return { name: "Computer", displayName: "Computer" };
  }
  return {
    name: input.name,
    displayName: input.displayName ?? input.name,
  };
}

/**
 * Projects protocol plugin metadata into the small, renderer-safe inventory
 * used by composer mention surfaces. Response order is intentional: it keeps
 * marketplace curation instead of alphabetically reshuffling the menu.
 */
export function buildComposerPluginInventory(
  response: Pick<PluginInstalledResponse, "marketplaces">,
  options: ComposerPluginInventoryOptions = {},
): CodexComposerPlugin[] {
  const plugins: CodexComposerPlugin[] = [];
  const seenPluginIds = new Set<string>();
  const installSuggestionPluginNames = new Set(options.installSuggestionPluginNames ?? []);

  for (const marketplace of response.marketplaces) {
    for (const plugin of marketplace.plugins) {
      const id = plugin.id.trim();
      if (!id || seenPluginIds.has(id)) continue;
      if (plugin.availability === "DISABLED_BY_ADMIN") continue;
      const isInstallSuggestion =
        !plugin.installed && installSuggestionPluginNames.has(plugin.name);
      const isRecordSkillEnableSuggestion =
        plugin.installed &&
        plugin.name === "record-and-replay" &&
        installSuggestionPluginNames.has(plugin.name);
      if (!plugin.enabled && !isInstallSuggestion && !isRecordSkillEnableSuggestion) continue;

      seenPluginIds.add(id);
      const pluginName = normalizeOptionalText(plugin.name) ?? id;
      const { name, displayName } = resolveComposerPluginNames({
        name: pluginName,
        displayName: normalizeOptionalText(plugin.interface?.displayName),
      });
      plugins.push({
        id,
        name,
        displayName,
        description: normalizeOptionalText(plugin.interface?.shortDescription),
        defaultPrompt: normalizeDefaultPrompt(plugin.interface?.defaultPrompt),
        installed: plugin.installed,
        enabled: plugin.enabled,
        path: `plugin://${id}`,
        iconUrl:
          normalizeRemoteImageUrl(plugin.interface?.composerIconUrl) ??
          normalizeRemoteImageUrl(plugin.interface?.logoUrl),
        iconUrlDark:
          normalizeRemoteImageUrl(plugin.interface?.logoUrlDark) ??
          normalizeRemoteImageUrl(plugin.interface?.composerIconUrl) ??
          normalizeRemoteImageUrl(plugin.interface?.logoUrl),
        brandColor: normalizeOptionalText(plugin.interface?.brandColor),
      });
    }
  }

  return plugins;
}

export function resolveComposerPluginActivation(
  response: Pick<PluginInstalledResponse, "marketplaces">,
  pluginId: string,
): ComposerPluginActivationResolution {
  const id = pluginId.trim();
  if (!id) throw new Error("Composer plugin id is required");

  for (const marketplace of response.marketplaces) {
    const plugin = marketplace.plugins.find((candidate) => candidate.id.trim() === id);
    if (!plugin) continue;
    if (plugin.availability === "DISABLED_BY_ADMIN") {
      throw new Error("Composer plugin is disabled by your administrator");
    }
    if (plugin.installed && plugin.enabled) {
      return { kind: "active" };
    }
    if (plugin.installed) {
      if (plugin.name !== "record-and-replay") {
        throw new Error("Composer plugin is installed but disabled");
      }
      return {
        kind: "enable",
        params: {
          edits: [
            {
              keyPath: `plugins.${plugin.id}.enabled`,
              value: true,
              mergeStrategy: "upsert",
            },
          ],
          filePath: null,
          expectedVersion: null,
          reloadUserConfig: true,
        },
      };
    }

    const marketplacePath = normalizeOptionalText(marketplace.path);
    if (marketplacePath) {
      return {
        kind: "install",
        params: {
          marketplacePath,
          pluginName: plugin.name,
        },
      };
    }
    return {
      kind: "install",
      params: {
        remoteMarketplaceName: marketplace.name,
        pluginName: plugin.name,
      },
    };
  }

  throw new Error("Composer plugin is no longer available");
}

export async function hydrateComposerPluginInventoryIcons(
  response: Pick<PluginInstalledResponse, "marketplaces">,
  plugins: readonly CodexComposerPlugin[],
  resolveIcon: ComposerInventoryIconResolver = resolveComposerInventoryIconUrl,
): Promise<CodexComposerPlugin[]> {
  const interfacesById = new Map(
    response.marketplaces.flatMap((marketplace) =>
      marketplace.plugins.map((plugin) => [plugin.id.trim(), plugin.interface] as const),
    ),
  );

  return Promise.all(
    plugins.map(async (plugin) => {
      const pluginInterface = interfacesById.get(plugin.id);
      if (!pluginInterface) return plugin;
      const lightIconPath = pluginInterface.composerIcon ?? pluginInterface.logo;
      const darkIconPath = pluginInterface.logoDark ?? lightIconPath;
      const localIcon = lightIconPath ? resolveIcon(lightIconPath) : null;
      const localDarkIcon =
        darkIconPath === lightIconPath
          ? localIcon
          : darkIconPath
            ? resolveIcon(darkIconPath)
            : null;
      if (!localIcon && !localDarkIcon) return plugin;
      return {
        ...plugin,
        iconUrl: localIcon ?? plugin.iconUrl,
        iconUrlDark: localDarkIcon ?? localIcon ?? plugin.iconUrlDark,
      };
    }),
  );
}
