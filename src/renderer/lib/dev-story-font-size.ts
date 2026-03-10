import { getSansFontSizeCssVariables, normalizeSansFontSize, type SansFontSizeCssVariables } from "./sans-font-size";
import { normalizeCodeFontSize } from "./code-font-size";

export const DEV_STORY_SANS_FONT_SIZE_STORAGE_KEY = "nodex-dev-story-sans-font-size-v1";
export const DEV_STORY_CODE_FONT_SIZE_STORAGE_KEY = "nodex-dev-story-code-font-size-v1";

export interface DevStoryFontSizeCssVariables extends SansFontSizeCssVariables {
  "--vscode-editor-font-size": string;
}

function readStorageValue(storageKey: string): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function writeStorageValue(storageKey: string, value: number): void {
  try {
    localStorage.setItem(storageKey, String(value));
  } catch {
    // localStorage may be unavailable.
  }
}

export function readDevStorySansFontSize(): number {
  return normalizeSansFontSize(readStorageValue(DEV_STORY_SANS_FONT_SIZE_STORAGE_KEY));
}

export function writeDevStorySansFontSize(value: number): number {
  const normalized = normalizeSansFontSize(value);
  writeStorageValue(DEV_STORY_SANS_FONT_SIZE_STORAGE_KEY, normalized);
  return normalized;
}

export function readDevStoryCodeFontSize(): number {
  return normalizeCodeFontSize(readStorageValue(DEV_STORY_CODE_FONT_SIZE_STORAGE_KEY));
}

export function writeDevStoryCodeFontSize(value: number): number {
  const normalized = normalizeCodeFontSize(value);
  writeStorageValue(DEV_STORY_CODE_FONT_SIZE_STORAGE_KEY, normalized);
  return normalized;
}

export function getDevStoryFontSizeCssVariables(
  options: {
    sansFontSize: number;
    codeFontSize: number;
  },
): DevStoryFontSizeCssVariables {
  const sansFontSize = normalizeSansFontSize(options.sansFontSize);
  const codeFontSize = normalizeCodeFontSize(options.codeFontSize);

  return {
    ...getSansFontSizeCssVariables(sansFontSize),
    "--vscode-editor-font-size": `${codeFontSize}px`,
  };
}
