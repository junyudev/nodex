import { normalizeCodeLanguageId } from "../../../shared/code-languages/code-language-catalog";

export const CODE_LANGUAGE_PREFERENCE_STORAGE_KEY = "nodex-editor-code-language-default-v1";

export interface CodeLanguagePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CodeLanguagePreference {
  get(): string;
  set(languageId: unknown): void;
}

function getBrowserStorage(): CodeLanguagePreferenceStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createCodeLanguagePreference(
  storage: CodeLanguagePreferenceStorage | null = getBrowserStorage(),
): CodeLanguagePreference {
  let current = "text";
  let loaded = false;

  const get = () => {
    if (loaded) return current;
    loaded = true;
    try {
      current = normalizeCodeLanguageId(storage?.getItem(CODE_LANGUAGE_PREFERENCE_STORAGE_KEY));
    } catch {
      current = "text";
    }
    return current;
  };

  const set = (languageId: unknown) => {
    current = normalizeCodeLanguageId(languageId);
    loaded = true;
    try {
      storage?.setItem(CODE_LANGUAGE_PREFERENCE_STORAGE_KEY, current);
    } catch {
      // The in-memory value remains authoritative for this renderer session.
    }
  };

  return { get, set };
}

export const codeLanguagePreference = createCodeLanguagePreference();
