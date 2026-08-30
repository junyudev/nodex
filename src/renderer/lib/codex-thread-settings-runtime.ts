import { defineRendererCommand, invokePlainCommand } from "./renderer-command";
import type { CodexThreadDetailLevel } from "./types";

const updateCodexDeveloperSettingsCommand = defineRendererCommand({
  key: "codex_thread_settings.update_developer_settings",
  channel: "settings:codex-developer:update",
  authority: "main",
  owner: "CodexThreadSettings",
  protocol: { kind: "returned_value" },
});

export function updateCodexDeveloperSettings(detailLevel: CodexThreadDetailLevel) {
  return invokePlainCommand(updateCodexDeveloperSettingsCommand, { detailLevel });
}
