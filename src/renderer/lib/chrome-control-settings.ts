import type { ChromeControlSettingsAction } from "../../shared/chrome-control-settings";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererQuery,
} from "@/lib/renderer-command";

const updateChromeControlSettingsCommand = defineRendererCommand({
  key: "chrome_control_settings.update_registration",
  channel: "chrome-control-settings-update",
  authority: "main",
  owner: "ChromeControlRuntime",
  protocol: { kind: "returned_value" },
});

export function readChromeControlSettings() {
  return invokeRendererQuery("chrome-control-settings-get");
}

export function updateChromeControlSettings(action: ChromeControlSettingsAction) {
  return invokePlainCommand(updateChromeControlSettingsCommand, action);
}
