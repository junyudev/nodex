import { persistedAtom, usePersistedAtomValue, useSetPersistedAtom } from "@/lib/maitai";
import {
  DEFAULT_FLOATING_COMPOSER_DOCK,
  DEFAULT_FLOATING_COMPOSER_HEIGHT_PX,
  DEFAULT_FLOATING_COMPOSER_WIDTH_PX,
  FLOATING_COMPOSER_MIN_HEIGHT_PX,
  FLOATING_COMPOSER_MIN_WIDTH_PX,
  isFloatingComposerDock,
  type FloatingComposerDock,
} from "./floating-composer-layout";

/**
 * The window-wide floating composer size (surface width, expanded frame height), and the dock used
 * where a Scene has not chosen one.
 */
export interface FloatingComposerPreference {
  readonly width: number;
  readonly height: number;
  readonly dock: FloatingComposerDock;
}

const DEFAULT_PREFERENCE: FloatingComposerPreference = {
  width: DEFAULT_FLOATING_COMPOSER_WIDTH_PX,
  height: DEFAULT_FLOATING_COMPOSER_HEIGHT_PX,
  dock: DEFAULT_FLOATING_COMPOSER_DOCK,
};
const MAX_STORED_SIZE_PX = 4_096;

function decodeSize(value: unknown, minimum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(MAX_STORED_SIZE_PX, Math.max(minimum, value)))
    : fallback;
}

export function decodeFloatingComposerPreference(value: unknown): FloatingComposerPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_PREFERENCE;
  const record = value as Record<string, unknown>;
  return {
    width: decodeSize(record.width, FLOATING_COMPOSER_MIN_WIDTH_PX, DEFAULT_PREFERENCE.width),
    height: decodeSize(record.height, FLOATING_COMPOSER_MIN_HEIGHT_PX, DEFAULT_PREFERENCE.height),
    dock: isFloatingComposerDock(record.dock) ? record.dock : DEFAULT_PREFERENCE.dock,
  };
}

const floatingComposerPreferenceAtom = persistedAtom({
  debugLabel: "floating-composer-preference",
  storageKey: "nodex:floating-composer:v1",
  defaultValue: DEFAULT_PREFERENCE,
  hydration: "eager",
  decode: decodeFloatingComposerPreference,
});

export function useFloatingComposerPreference() {
  const loadable = usePersistedAtomValue(floatingComposerPreferenceAtom);
  const write = useSetPersistedAtom(floatingComposerPreferenceAtom);
  const update = (patch: Partial<FloatingComposerPreference>) => {
    void write((current) => {
      const next = { ...current, ...patch };
      return next.width === current.width &&
        next.height === current.height &&
        next.dock === current.dock
        ? current
        : next;
    }).catch(() => {
      // The preference stays applied for this window; the next change retries the write.
    });
  };
  return { preference: loadable.value, update };
}
