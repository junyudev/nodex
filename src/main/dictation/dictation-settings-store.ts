import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_DICTATION_SETTINGS,
  type DictationSettings,
  type DictationSettingsPatch,
} from "../../shared/dictation";
import { isMissingPathError, writeDurableJson } from "../durable-json-file";

const SETTINGS_FILE_NAME = "dictation-settings.json";
const MAX_SETTINGS_BYTES = 64 * 1024;
export const MAX_DICTATION_DICTIONARY_ENTRIES = 100;
export const MAX_DICTATION_DICTIONARY_ENTRY_LENGTH = 512;
const PATCH_KEYS = new Set<keyof DictationSettings>([
  "microphoneInputDeviceId",
  "dictationSoundsEnabled",
  "globalShortcutNudgeDismissed",
  "dictionary",
]);

const parseDictionary = (value: unknown): readonly string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DICTATION_DICTIONARY_ENTRIES) {
    throw new Error("Dictation dictionary is invalid");
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.length > MAX_DICTATION_DICTIONARY_ENTRY_LENGTH) {
      throw new Error("Dictation dictionary entry is invalid");
    }
    return entry;
  });
};

const parseSettings = (value: unknown): DictationSettings => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Dictation settings must be an object");
  }
  const input = value as Record<string, unknown>;
  const microphoneInputDeviceId =
    input.microphoneInputDeviceId ?? DEFAULT_DICTATION_SETTINGS.microphoneInputDeviceId;
  const globalShortcutNudgeDismissed = input.globalShortcutNudgeDismissed ?? false;
  const dictationSoundsEnabled =
    input.dictationSoundsEnabled ?? DEFAULT_DICTATION_SETTINGS.dictationSoundsEnabled;
  const dictionary = parseDictionary(input.dictionary);
  if (
    microphoneInputDeviceId !== null &&
    (typeof microphoneInputDeviceId !== "string" || !microphoneInputDeviceId)
  ) {
    throw new Error("Dictation microphone selection is invalid");
  }
  if (
    typeof globalShortcutNudgeDismissed !== "boolean" ||
    typeof dictationSoundsEnabled !== "boolean"
  ) {
    throw new Error("Dictation settings flags are invalid");
  }
  return {
    microphoneInputDeviceId,
    dictationSoundsEnabled,
    globalShortcutNudgeDismissed,
    dictionary,
  };
};

export const parseDictationSettingsPatch = (value: unknown): DictationSettingsPatch => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Dictation settings update must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!PATCH_KEYS.has(key as keyof DictationSettings)) {
      throw new Error(`Unknown dictation setting: ${key}`);
    }
  }
  if (
    "microphoneInputDeviceId" in input &&
    input.microphoneInputDeviceId !== null &&
    (typeof input.microphoneInputDeviceId !== "string" || !input.microphoneInputDeviceId)
  ) {
    throw new Error("Dictation microphone selection is invalid");
  }
  if (
    "globalShortcutNudgeDismissed" in input &&
    typeof input.globalShortcutNudgeDismissed !== "boolean"
  ) {
    throw new Error("Dictation setting globalShortcutNudgeDismissed must be a boolean");
  }
  if ("dictionary" in input) parseDictionary(input.dictionary);
  if ("dictationSoundsEnabled" in input && typeof input.dictationSoundsEnabled !== "boolean") {
    throw new Error("Dictation setting dictationSoundsEnabled must be a boolean");
  }
  return input as DictationSettingsPatch;
};

export class DictationSettingsStore {
  readonly #filePath: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(userDataPath: string) {
    this.#filePath = join(userDataPath, SETTINGS_FILE_NAME);
  }

  read(): Promise<DictationSettings> {
    return this.#serialize(() => this.#readCurrent());
  }

  update(value: unknown): Promise<DictationSettings> {
    const patch = parseDictationSettingsPatch(value);
    return this.#serialize(async () => {
      const stored = await this.#readStored();
      const current = stored === null ? DEFAULT_DICTATION_SETTINGS : parseSettings(stored);
      const next = { ...current, ...patch };
      await writeDurableJson(this.#filePath, next, MAX_SETTINGS_BYTES);
      return next;
    });
  }

  consumeGlobalShortcutNudge(): Promise<boolean> {
    return this.#serialize(async () => {
      const stored = await this.#readStored();
      const current = stored === null ? DEFAULT_DICTATION_SETTINGS : parseSettings(stored);
      if (current.globalShortcutNudgeDismissed) return false;
      await writeDurableJson(
        this.#filePath,
        {
          ...current,
          globalShortcutNudgeDismissed: true,
        },
        MAX_SETTINGS_BYTES,
      );
      return true;
    });
  }

  async #readCurrent(): Promise<DictationSettings> {
    const stored = await this.#readStored();
    return stored === null ? DEFAULT_DICTATION_SETTINGS : parseSettings(stored);
  }

  async #readStored(): Promise<unknown | null> {
    try {
      const metadata = await lstat(this.#filePath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error("Dictation settings path is not a regular file");
      }
      if (metadata.size > MAX_SETTINGS_BYTES) {
        throw new Error("Dictation settings exceed the size limit");
      }
      return JSON.parse(await readFile(this.#filePath, "utf8")) as unknown;
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}
