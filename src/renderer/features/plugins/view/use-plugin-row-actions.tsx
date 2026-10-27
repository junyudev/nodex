import { toast } from "@/components/ui/toast";
import type { CustomizeNavigation } from "../customize-navigation";
import { pluginMutationSucceeded } from "../model/mutation-result";
import { beginPluginAction, showPluginAppsOnboarding } from "../model/install-sessions";
import { pluginDisplayName } from "../model/plugin-labels";
import { markdownLink } from "../model/skill-model";
import { usePluginManagement, type PluginContext, type PluginRow } from "../plugin-management";

/** The first non-blank starter prompt a plugin offers. */
export function firstDefaultPrompt(row: Pick<PluginRow, "summary">): string | null {
  for (const prompt of row.summary.interface?.defaultPrompt ?? []) {
    const trimmed = prompt.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/** An unsent draft that mentions the plugin, then the starter prompt. */
export function tryPluginPrompt(row: PluginRow, prompt: string | null): string {
  return `${markdownLink(`@${pluginDisplayName(row)}`, `plugin://${row.nativeId}`)} ${prompt?.trim() ?? ""}`;
}

/** Install, uninstall, and Try now for one plugin, with the outcome toasts. */
export function usePluginRowActions(
  context: PluginContext,
  navigation: Pick<CustomizeNavigation, "onStartChat">,
) {
  const management = usePluginManagement(context);

  const tryNow = (row: PluginRow, prompt = firstDefaultPrompt(row)) =>
    navigation.onStartChat(tryPluginPrompt(row, prompt));

  /**
   * Installs a plugin. True when it is ready to use; false when installing failed or its apps
   * are being offered for connection first, where Try now uses `prompt`.
   */
  const install = async (row: PluginRow, prompt?: string | null) => {
    const name = pluginDisplayName(row);
    const end = beginPluginAction(row.stableIdentity, "installing");
    try {
      const result = await management.install({
        ...row.selector,
        installAttemptId: crypto.randomUUID(),
      });
      if (pluginMutationSucceeded(result)) {
        if (result.refreshFailures.includes("skills")) {
          toast.warning(
            `Installed ${name}, but its skills couldn't refresh. Reload skills before starting a new chat`,
          );
        } else if (result.refreshFailures.includes("plugins")) {
          toast.warning(`Installed ${name}, but failed to refresh the plugin list`);
        } else if (
          result.value.authPolicy !== "ON_USE" &&
          result.value.appsNeedingAuth.length > 0
        ) {
          showPluginAppsOnboarding({ row, apps: result.value.appsNeedingAuth, prompt });
          return false;
        } else {
          toast.success(`${name} plugin installed`, {
            action: { label: "Try now", onClick: () => tryNow(row) },
          });
        }
        return true;
      }
      toast.danger("Failed to install plugin", { description: result.error.message });
      return false;
    } catch {
      toast.danger("Failed to install plugin");
      return false;
    } finally {
      end();
    }
  };

  const uninstall = async (row: PluginRow) => {
    const name = pluginDisplayName(row);
    const end = beginPluginAction(row.stableIdentity, "uninstalling");
    try {
      const result = await management.uninstall({ pluginId: row.nativeId });
      if (pluginMutationSucceeded(result)) {
        if (result.refreshFailures.includes("skills")) {
          toast.warning(
            "Plugin changed, but skills couldn't refresh. Reload skills before starting a new chat",
          );
        } else {
          toast.success(`${name} plugin uninstalled`);
        }
        return;
      }
      toast.danger("Failed to uninstall plugin");
    } catch {
      toast.danger("Failed to uninstall plugin");
    } finally {
      end();
    }
  };

  const setEnabled = async (row: PluginRow, enabled: boolean) => {
    const name = pluginDisplayName(row);
    try {
      const result = await management.setPluginEnabled({ pluginId: row.nativeId, enabled });
      if (pluginMutationSucceeded(result)) {
        if (result.refreshFailures.includes("skills")) {
          toast.warning(
            "Plugin changed, but skills couldn't refresh. Reload skills before starting a new chat",
          );
        } else {
          toast.success(enabled ? `${name} plugin enabled` : `${name} plugin disabled`);
        }
        return true;
      }
      toast.danger("Failed to update plugin");
      return false;
    } catch {
      toast.danger("Failed to update plugin");
      return false;
    }
  };

  return { install, uninstall, setEnabled, tryNow };
}
