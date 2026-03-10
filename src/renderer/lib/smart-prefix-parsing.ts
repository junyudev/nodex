import {
  normalizeStoredBoolean,
  readStoredBoolean,
  writeStoredBoolean,
} from "./storage-boolean";

export const SMART_PREFIX_PARSING_ENABLED_STORAGE_KEY =
  "nodex-smart-prefix-parsing-enabled-v1";
export const STRIP_SMART_PREFIX_FROM_TITLE_STORAGE_KEY =
  "nodex-strip-smart-prefix-from-title-v1";

export const DEFAULT_SMART_PREFIX_PARSING_ENABLED = true;
export const DEFAULT_STRIP_SMART_PREFIX_FROM_TITLE_ENABLED = true;

export function normalizeSmartPrefixParsingEnabled(value: unknown): boolean {
  return normalizeStoredBoolean(value, DEFAULT_SMART_PREFIX_PARSING_ENABLED);
}

export function normalizeStripSmartPrefixFromTitleEnabled(value: unknown): boolean {
  return normalizeStoredBoolean(value, DEFAULT_STRIP_SMART_PREFIX_FROM_TITLE_ENABLED);
}

export function readSmartPrefixParsingEnabled(): boolean {
  return readStoredBoolean(
    SMART_PREFIX_PARSING_ENABLED_STORAGE_KEY,
    DEFAULT_SMART_PREFIX_PARSING_ENABLED,
  );
}

export function writeSmartPrefixParsingEnabled(value: boolean): boolean {
  return writeStoredBoolean(
    SMART_PREFIX_PARSING_ENABLED_STORAGE_KEY,
    value,
    DEFAULT_SMART_PREFIX_PARSING_ENABLED,
  );
}

export function readStripSmartPrefixFromTitleEnabled(): boolean {
  return readStoredBoolean(
    STRIP_SMART_PREFIX_FROM_TITLE_STORAGE_KEY,
    DEFAULT_STRIP_SMART_PREFIX_FROM_TITLE_ENABLED,
  );
}

export function writeStripSmartPrefixFromTitleEnabled(value: boolean): boolean {
  return writeStoredBoolean(
    STRIP_SMART_PREFIX_FROM_TITLE_STORAGE_KEY,
    value,
    DEFAULT_STRIP_SMART_PREFIX_FROM_TITLE_ENABLED,
  );
}
