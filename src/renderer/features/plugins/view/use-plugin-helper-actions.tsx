import { useState } from "react";
import { toast } from "@/components/ui/toast";
import type { PluginCreationHelper } from "../../../../shared/codex-plugin-settings";
import type { CustomizeNavigation } from "../customize-navigation";
import { pluginMutationSucceeded } from "../model/mutation-result";
import {
  usePluginCreationCapabilities,
  usePluginManagement,
  type PluginContext,
} from "../plugin-management";

export interface PluginHelperAction {
  /** The helper plugin exists in a marketplace, so its action is offered. */
  readonly visible: boolean;
  /** Offered but not runnable now: blocked, unavailable, or already preparing. */
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly run: () => void;
}

/**
 * Create plugin and Record a skill: each installs or enables its helper plugin when needed, then
 * starts a chat with the helper's draft.
 */
export function usePluginHelperActions(
  context: PluginContext,
  navigation: Pick<CustomizeNavigation, "onStartChat">,
): Record<"createPlugin" | "recordSkill", PluginHelperAction> {
  const capabilities = usePluginCreationCapabilities(context);
  const management = usePluginManagement(context);
  const [preparing, setPreparing] = useState<PluginCreationHelper | null>(null);

  const action = (
    helper: PluginCreationHelper,
    capability: { readonly available: boolean; readonly plugin: unknown } | undefined,
  ): PluginHelperAction => ({
    visible: capability?.plugin != null,
    busy: preparing === helper,
    disabled: capability?.available !== true || preparing != null,
    run: () => {
      setPreparing(helper);
      void management
        .preparePluginHelper({ helper, installAttemptId: crypto.randomUUID() })
        .then((result) => {
          if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
          navigation.onStartChat(result.value.draft);
        })
        .catch(() => toast.danger("Failed to prepare the plugin"))
        .finally(() => setPreparing(null));
    },
  });

  return {
    createPlugin: action("plugin-creator", capabilities.data?.createPlugin),
    recordSkill: action("record-and-replay", capabilities.data?.recordSkill),
  };
}
