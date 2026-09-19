import {
  selectAppToolCatalog,
  type AppToolCatalogPurpose,
} from "../../shared/nodex-app-tools/catalog-selection";
import { isCodexAppServerVersionAtLeast } from "../codex-runtime/CodexAppServerCapabilities";

type ThreadConfigValue =
  | null
  | string
  | number
  | boolean
  | ThreadConfigValue[]
  | { [key: string]: ThreadConfigValue };
type ThreadConfig = Record<string, ThreadConfigValue>;

/**
 * Product-owned Codex Desktop feature defaults.
 *
 * These are the execution features that are enabled for the supported Desktop
 * experience and must be materialized for app-server. Runtime capability
 * negotiation such as thread queue is intentionally not duplicated here.
 */
const CODEX_DESKTOP_ALWAYS_ON_THREAD_FEATURE_CONFIG = Object.freeze({
  "features.apps_mcp_path_override": true,
  "features.code_mode_interrupt": true,
  "features.collaboration_modes": true,
  "features.concurrent_reasoning_summaries": true,
  "features.executed_tool_call_metadata": true,
  "features.guardian_approval": true,
  "features.guardian_reuse_parent_compaction": true,
  "features.image_detail_original": true,
  "features.image_generation": true,
  "features.image_resize_notice": true,
  "features.item_ids": true,
  "features.realtime_conversation": true,
  "features.request_rule": true,
  "features.thread_tools": true,
  "features.enable_mcp_apps": true,
  "features.workspace_dependencies": true,
} satisfies ThreadConfig);

const CODEX_DESKTOP_GUARDIAN_V2_CONFIG = Object.freeze({ enabled: true });
const CODEX_DESKTOP_RECOMMENDED_PLUGINS_MINIMUM_VERSION = "0.147.0-alpha.1";
const CODEX_DESKTOP_STRUCTURED_GUARDIAN_V2_MINIMUM_VERSION = "0.148.0-alpha.18";

const supportsDesktopFeatureWireFormat = (
  appServerVersion: string | null | undefined,
  minimumVersion: string,
): boolean =>
  appServerVersion === undefined ||
  appServerVersion === "0.0.0" ||
  isCodexAppServerVersionAtLeast(appServerVersion, minimumVersion);

/**
 * Current Codex Desktop defaults expressed as Nodex-owned static policy.
 * Older app-server versions keep Desktop's compatibility behavior without
 * reintroducing remote feature assignments.
 */
export function buildCodexDesktopThreadFeatureConfig(
  appServerVersion?: string | null,
): ThreadConfig {
  const supportsStructuredGuardian = supportsDesktopFeatureWireFormat(
    appServerVersion,
    CODEX_DESKTOP_STRUCTURED_GUARDIAN_V2_MINIMUM_VERSION,
  );
  const supportsRecommendedPlugins = supportsDesktopFeatureWireFormat(
    appServerVersion,
    CODEX_DESKTOP_RECOMMENDED_PLUGINS_MINIMUM_VERSION,
  );
  return {
    ...CODEX_DESKTOP_ALWAYS_ON_THREAD_FEATURE_CONFIG,
    "features.guardianv2": supportsStructuredGuardian ? CODEX_DESKTOP_GUARDIAN_V2_CONFIG : true,
    ...(supportsRecommendedPlugins ? { "features.recommended_plugins": true } : {}),
  };
}

export const CODEX_DESKTOP_THREAD_FEATURE_CONFIG = Object.freeze(
  buildCodexDesktopThreadFeatureConfig(),
);

const normalizeConfigValue = (value: unknown): ThreadConfigValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value)) return value.map(normalizeConfigValue);
  if (typeof value !== "object") throw new Error("Thread configuration must contain JSON values");
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      entry === undefined ? [] : [[key, normalizeConfigValue(entry)]],
    ),
  );
};

/** Refresh app-tool visibility at every Thread launch, fork, and live resume. */
export function buildCodexThreadConfig(input: {
  /** The physical app-server Session has the private Nodex App Tools transport installed. */
  readonly nativeAppTools: boolean;
  readonly purpose?: AppToolCatalogPurpose;
  readonly overrides?: Readonly<Record<string, unknown>> | null;
}): ThreadConfig {
  const purpose = input.purpose ?? "session";
  return {
    // A host without the private server must not receive a partial MCP definition.
    ...(input.nativeAppTools
      ? {
          "mcp_servers.nodex_app.enabled_tools": selectAppToolCatalog({
            nativeMcp: true,
            purpose,
          }).map((tool) => tool.name),
        }
      : {}),
    ...Object.fromEntries(
      Object.entries(input.overrides ?? {}).flatMap(([key, entry]) =>
        entry === undefined ? [] : [[key, normalizeConfigValue(entry)]],
      ),
    ),
  };
}
