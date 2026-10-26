import type { ConfigReadResponse } from "@nodex/codex-app-server-protocol/v2/ConfigReadResponse";
import type { PluginFailure } from "../../shared/codex-plugin-management";
import {
  configuredTable,
  normalizeConnectorId,
  writablePluginConfigLayer,
} from "./PluginSettingsModel";

/** Effective origins decide editability; defaults may be overridden, managed/project policy may not. */
export function pluginAppPolicy(
  config: ConfigReadResponse | null,
  appId: string,
  adminDisabled = false,
  toolName?: string,
) {
  const declarations = configuredTable(config?.config.apps);
  const canonical = normalizeConnectorId(appId);
  const configKey = Object.hasOwn(declarations, appId)
    ? appId
    : (Object.keys(declarations).find((key) => normalizeConnectorId(key) === canonical) ??
      canonical);
  const denied = (code: PluginFailure["code"], message: string) => ({
    configKey,
    editable: false,
    editRestriction: { code, message, retryable: false } satisfies PluginFailure,
  });
  if (adminDisabled) return denied("policy_denied", "This app is disabled by your administrator.");
  if (!config || !writablePluginConfigLayer(config))
    return denied("inventory_unavailable", "Writable app settings are unavailable.");
  const keys = [
    ...new Set([
      appId,
      configKey,
      canonical,
      ...Object.keys(declarations).filter((key) => normalizeConnectorId(key) === canonical),
    ]),
  ];
  const candidates = keys.flatMap((key) => [
    `apps.${key}.enabled`,
    `apps.${JSON.stringify(key)}.enabled`,
    `apps.${key}`,
    `apps.${JSON.stringify(key)}`,
  ]);
  if (toolName !== undefined)
    candidates.push(
      ...keys.flatMap((key) => [
        `apps.${key}.tools.${toolName}.enabled`,
        `apps.${JSON.stringify(key)}.tools.${JSON.stringify(toolName)}.enabled`,
        `apps.${JSON.stringify(key)}.tools.${toolName}.enabled`,
        `apps.${key}.tools.${JSON.stringify(toolName)}.enabled`,
        `apps.${key}.tools.${toolName}`,
        `apps.${JSON.stringify(key)}.tools.${JSON.stringify(toolName)}`,
        `apps.${JSON.stringify(key)}.tools.${toolName}`,
        `apps.${key}.tools.${JSON.stringify(toolName)}`,
        `apps.${key}.tools`,
        `apps.${JSON.stringify(key)}.tools`,
        `apps.${key}.default_tools_enabled`,
        `apps.${JSON.stringify(key)}.default_tools_enabled`,
      ]),
      "apps._default.default_tools_enabled",
    );
  if (!keys.some((key) => typeof configuredTable(declarations[key]).enabled === "boolean"))
    candidates.push("apps._default.enabled", "apps._default");
  candidates.push("apps");
  if (
    candidates.some((key) => {
      const origin = config.origins[key];
      return (
        origin &&
        !["packagedDefaults", "system"].includes(origin.name.type) &&
        !(origin.name.type === "user" && origin.name.profile == null)
      );
    })
  )
    return denied("policy_denied", "This app is controlled by another configuration layer.");
  const declaration = configuredTable(declarations[configKey]);
  if (
    toolName !== undefined &&
    (declaration.enabled === false ||
      (declaration.enabled === undefined &&
        configuredTable(declarations._default).enabled === false))
  )
    return denied("protected", "Enable the app before changing its tools.");
  return { configKey, editable: true, editRestriction: null };
}
