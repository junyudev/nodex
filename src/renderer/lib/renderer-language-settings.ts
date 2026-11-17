import type { LanguageSettings, LanguageSettingsReader } from "../../shared/i18n/locales";
import { activateAppLocale } from "./app-locale";

let current: LanguageSettings | null = null;
let activation = Promise.resolve();
let received = 0;
const listeners = new Set<() => void>();

export function getRendererLanguageSettings(): LanguageSettings | null {
  return current;
}

export function subscribeRendererLanguageSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function accept(settings: LanguageSettings): void {
  if (settings.locale === current?.locale && settings.preference === current.preference) return;
  current = settings;
  activation = activateAppLocale(settings.locale);
  for (const listener of listeners) listener();
}

async function awaitCurrentActivation(): Promise<void> {
  let pending: Promise<void>;
  do {
    pending = activation;
    await pending;
  } while (pending !== activation);
}

/** A push from Main supersedes a read or command response already in flight. */
export async function syncRendererLanguageSettings(
  request: () => Promise<LanguageSettings>,
): Promise<void> {
  const observed = received;
  const settings = await request();
  if (observed === received) accept(settings);
  await awaitCurrentActivation();
}

/** Take one window-lifetime subscription before reading the first snapshot. */
export function initializeRendererLanguageSettings(bridge: LanguageSettingsReader): {
  readonly ready: Promise<void>;
  readonly dispose: () => void;
} {
  const dispose = bridge.onLanguageSettingsChanged((settings) => {
    received += 1;
    accept(settings);
    void activation.catch((error) =>
      console.error("Could not activate the display language", error),
    );
  });
  return { ready: syncRendererLanguageSettings(bridge.readLanguageSettings), dispose };
}
