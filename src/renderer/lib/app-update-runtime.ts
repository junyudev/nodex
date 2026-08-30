import type { UpdateAppUpdateSettingsInput } from "./types";
import { subscribeAppUpdateStatus } from "./api";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const updateAppUpdateSettingsCommand = defineRendererCommand({
  key: "app_update.update_settings",
  channel: "settings:app-updates:update",
  authority: "main",
  owner: "AppUpdateRuntime",
  protocol: { kind: "returned_value" },
});

const checkForAppUpdateCommand = defineRendererCommand({
  key: "app_update.check",
  channel: "app:update:check",
  authority: "external",
  owner: "AppUpdateRuntime",
  protocol: { kind: "pending_operation" },
});

const installAppUpdateCommand = defineRendererCommand({
  key: "app_update.install",
  channel: "app:update:install",
  authority: "external",
  owner: "AppUpdateRuntime",
  protocol: { kind: "pending_operation" },
});

export { subscribeAppUpdateStatus };

export function readAppUpdateSettings() {
  return invokeRendererQuery("settings:app-updates:get");
}

export function readAppUpdateStatus() {
  return invokeRendererQuery("app:update:status");
}

export function updateAppUpdateSettings(input: UpdateAppUpdateSettingsInput) {
  return invokePlainCommand(updateAppUpdateSettingsCommand, input);
}

export function checkForAppUpdate() {
  return invokePlainCommand(checkForAppUpdateCommand);
}

export function installAppUpdate() {
  return invokePlainCommand(installAppUpdateCommand);
}
