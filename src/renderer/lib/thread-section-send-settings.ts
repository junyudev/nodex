import {
  normalizeStoredBoolean,
  writeStoredBoolean,
} from "./storage-boolean";

export const THREAD_SECTION_SEND_SETTINGS_STORAGE_KEY =
  "nodex-thread-section-send-settings-v1";

export interface ThreadSectionSendSettings {
  confirmBeforeSend: boolean;
}

export const DEFAULT_THREAD_SECTION_SEND_SETTINGS: ThreadSectionSendSettings = {
  confirmBeforeSend: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeThreadSectionSendSettings(
  value: unknown,
): ThreadSectionSendSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_THREAD_SECTION_SEND_SETTINGS };
  }

  return {
    confirmBeforeSend: normalizeStoredBoolean(
      value.confirmBeforeSend,
      DEFAULT_THREAD_SECTION_SEND_SETTINGS.confirmBeforeSend,
    ),
  };
}

export function readThreadSectionSendSettings(): ThreadSectionSendSettings {
  try {
    const raw = localStorage.getItem(THREAD_SECTION_SEND_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_THREAD_SECTION_SEND_SETTINGS };
    return normalizeThreadSectionSendSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_THREAD_SECTION_SEND_SETTINGS };
  }
}

export function writeThreadSectionSendSettings(
  value: unknown,
): ThreadSectionSendSettings {
  const normalized = normalizeThreadSectionSendSettings(value);
  try {
    localStorage.setItem(
      THREAD_SECTION_SEND_SETTINGS_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  } catch {
    // localStorage may be unavailable.
  }
  return normalized;
}

export function writeThreadSectionConfirmBeforeSend(
  value: unknown,
): ThreadSectionSendSettings {
  const confirmBeforeSend = writeStoredBoolean(
    `${THREAD_SECTION_SEND_SETTINGS_STORAGE_KEY}:confirmBeforeSend`,
    value,
    DEFAULT_THREAD_SECTION_SEND_SETTINGS.confirmBeforeSend,
  );
  const nextSettings = { confirmBeforeSend };
  try {
    localStorage.setItem(
      THREAD_SECTION_SEND_SETTINGS_STORAGE_KEY,
      JSON.stringify(nextSettings),
    );
    localStorage.removeItem(`${THREAD_SECTION_SEND_SETTINGS_STORAGE_KEY}:confirmBeforeSend`);
  } catch {
    // localStorage may be unavailable.
  }
  return nextSettings;
}

export function shouldConfirmThreadSectionSend(
  settings: ThreadSectionSendSettings | null | undefined,
): boolean {
  return normalizeStoredBoolean(
    settings?.confirmBeforeSend,
    DEFAULT_THREAD_SECTION_SEND_SETTINGS.confirmBeforeSend,
  );
}
