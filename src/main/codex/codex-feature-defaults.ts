import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

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

export interface MaterializeCodexFeatureDefaultsResult {
  readonly added: readonly CodexFeatureDefault[];
  readonly changed: boolean;
  readonly configPath: string;
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

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeConfigAtomically(configPath: string, contents: string): Promise<void> {
  const directoryPath = dirname(configPath);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directoryPath,
    `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, configPath);
    await syncDirectory(directoryPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function materializeCodexFeatureDefaults(
  runtimeStateHome: string,
): Promise<MaterializeCodexFeatureDefaultsResult> {
  const configPath = join(runtimeStateHome, "config.toml");
  let source = "";
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }

  const parsed = parseToml(source, { integersAsBigInt: true });
  if (!isRecord(parsed)) throw new Error("Codex config root must be a TOML table");

  const applied = applyCodexFeatureDefaults(parsed);
  if (!applied.changed) {
    return { added: applied.added, changed: false, configPath };
  }

  const serialized = stringifyToml(applied.config, { numbersAsFloat: true });
  await writeConfigAtomically(configPath, serialized);
  return { added: applied.added, changed: true, configPath };
}
