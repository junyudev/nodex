import { lstatSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

export const SETTINGS_DOCUMENT_MAX_BYTES = 1024 * 1024;

export type SettingsTomlDocument = Record<string, unknown>;

export interface SettingsTomlDocumentSnapshot {
  readonly document: SettingsTomlDocument;
  readonly bytes: Buffer | null;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Reads a bounded TOML document. Missing files are the only input treated as an empty document. */
export function readSettingsTomlDocumentSnapshot(configPath: string): SettingsTomlDocumentSnapshot {
  let stats;
  try {
    stats = lstatSync(configPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { document: {}, bytes: null };
    }
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Settings document is not a regular file: ${configPath}`);
  }
  if (stats.size > SETTINGS_DOCUMENT_MAX_BYTES) {
    throw new Error(
      `Settings document exceeds ${SETTINGS_DOCUMENT_MAX_BYTES} bytes: ${configPath}`,
    );
  }

  const raw = readFileSync(configPath);
  const decoded = strictUtf8.decode(raw);
  const parsed = parseToml(decoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Settings document must contain a TOML table: ${configPath}`);
  }
  return { document: parsed as SettingsTomlDocument, bytes: raw };
}

/** Reads only the parsed view when byte identity is not part of the caller contract. */
export function readSettingsTomlDocument(configPath: string): SettingsTomlDocument {
  return readSettingsTomlDocumentSnapshot(configPath).document;
}
