import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_AGENT_RUNTIME_SETTINGS } from "../../../shared/agent-runtime-settings";
import {
  agentRuntimeSettingsQueryOptions,
  updateAgentRuntimeSettings,
} from "@/lib/agent-runtime-settings";
import { PermissionModeDropdown } from "@/features/local-conversation/view/shared/permission-mode-dropdown";

/** The permission mode new chats start with; each chat can change its own from the composer. */
export function DefaultPermissionsSettingControl() {
  const client = useQueryClient();
  const settings = useQuery(agentRuntimeSettingsQueryOptions());
  return (
    <PermissionModeDropdown
      triggerStyle="settings"
      mode={settings.data?.defaultRuntimeMode ?? DEFAULT_AGENT_RUNTIME_SETTINGS.defaultRuntimeMode}
      disabled={settings.isPending}
      onSelect={async (defaultRuntimeMode) => {
        await updateAgentRuntimeSettings(client, {
          ...(settings.data ?? DEFAULT_AGENT_RUNTIME_SETTINGS),
          defaultRuntimeMode,
        });
      }}
    />
  );
}
