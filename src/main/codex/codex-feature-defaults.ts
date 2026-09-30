import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

type UnknownRecord = Record<string, unknown>;

export const CODEX_FEATURE_DEFAULTS = {
  unified_exec: true,
  shell_snapshot: true,
  multi_agent: true,
  prevent_idle_sleep: true,
  respect_system_proxy: true,
} as const;

export type CodexFeatureDefault = keyof typeof CODEX_FEATURE_DEFAULTS;

export interface ApplyCodexFeatureDefaultsResult {
  readonly added: readonly CodexFeatureDefault[];
  readonly changed: boolean;
  readonly config: UnknownRecord;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const MULTI_AGENT_V2_INTEGER_FIELDS = [
  "max_concurrent_threads_per_session",
  "min_wait_timeout_ms",
  "default_wait_timeout_ms",
  "max_wait_timeout_ms",
] as const;

/**
 * Repairs configs written by older Nodex builds, which serialized these integer-only settings as
 * TOML floats. The pinned runtime rejects that representation before reloading any capabilities.
 */
function normalizeCodexFeatureIntegers(features: UnknownRecord): UnknownRecord {
  const multiAgentV2 = features.multi_agent_v2;
  if (!isRecord(multiAgentV2)) return features;

  let normalized = multiAgentV2;
  for (const field of MULTI_AGENT_V2_INTEGER_FIELDS) {
    const value = normalized[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) continue;
    if (normalized === multiAgentV2) normalized = { ...multiAgentV2 };
    normalized[field] = BigInt(value);
  }
  if (normalized === multiAgentV2) return features;
  return { ...features, multi_agent_v2: normalized };
}

export function applyCodexFeatureDefaults(config: UnknownRecord): ApplyCodexFeatureDefaultsResult {
  const configuredFeatures = config.features;
  if (configuredFeatures !== undefined && !isRecord(configuredFeatures)) {
    throw new Error("Codex config [features] must be a TOML table");
  }

  const features = normalizeCodexFeatureIntegers(configuredFeatures ?? {});
  const added = (Object.keys(CODEX_FEATURE_DEFAULTS) as CodexFeatureDefault[]).filter(
    (feature) => !Object.hasOwn(features, feature),
  );
  const repaired = configuredFeatures !== undefined && features !== configuredFeatures;
  if (added.length === 0 && !repaired) return { added, changed: false, config };

  const defaults = Object.fromEntries(
    added.map((feature) => [feature, CODEX_FEATURE_DEFAULTS[feature]]),
  );
  return {
    added,
    changed: true,
    config: {
      ...config,
      features: {
        ...features,
        ...defaults,
      },
    },
  };
}

/** Supply only missing defaults to this process, preserving the user's native configuration bytes. */
export async function codexFeatureDefaultLaunchArgs(codexHome: string): Promise<string[]> {
  const source = await readFile(join(codexHome, "config.toml"), "utf8").catch((error: unknown) => {
    if (isMissingPathError(error)) return "";
    throw error;
  });
  const config = parseToml(source, { integersAsBigInt: true });
  const applied = applyCodexFeatureDefaults(config);
  const args = applied.added.flatMap((feature) => ["-c", `features.${feature}=true`]);
  const features = applied.config.features;
  if (!isRecord(features) || !isRecord(features.multi_agent_v2)) return args;
  for (const field of MULTI_AGENT_V2_INTEGER_FIELDS) {
    const value = features.multi_agent_v2[field];
    if (typeof value === "bigint") args.push("-c", `features.multi_agent_v2.${field}=${value}`);
  }
  return args;
}
