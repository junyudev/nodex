import { persistedAtom, usePersistedAtomValue, useSetPersistedAtom } from "@/lib/maitai";
import type { PanelId } from "@/lib/types";
import { omitRecordKey } from "@/lib/utils";
import type { NewTabShortcutPreference } from "./workbench-new-tab-model";
import { PANEL_NEW_TAB_ACTIONS, type PanelNewTabActionKind } from "./workbench-panel-actions";

/** Each panel's New tab arrangement. A missing panel uses the default. */
export type NewTabShortcutPreferences = Readonly<
  Partial<Record<PanelId, NewTabShortcutPreference>>
>;

const toolKinds = new Set<string>(
  PANEL_NEW_TAB_ACTIONS.map(({ kind }) => kind).filter((kind) => kind !== "browser"),
);

function decodeToolKinds(values: readonly unknown[]): PanelNewTabActionKind[] {
  const kinds = new Set<PanelNewTabActionKind>();
  for (const value of values) {
    if (typeof value !== "string" || !toolKinds.has(value)) continue;
    kinds.add(value as PanelNewTabActionKind);
    if (kinds.size === toolKinds.size) break;
  }
  return [...kinds];
}

/** Reads each panel independently so a malformed entry falls back to that panel's defaults. */
export function decodeNewTabShortcutPreferences(value: unknown): NewTabShortcutPreferences {
  if (value === null || typeof value !== "object") return {};
  const preferences: Partial<Record<PanelId, NewTabShortcutPreference>> = {};
  for (const panelId of ["right", "bottom"] as const) {
    try {
      if (Array.isArray(value) || !Object.hasOwn(value, panelId)) continue;
      const panel = (value as Record<PanelId, unknown>)[panelId];
      if (panel === null || typeof panel !== "object" || Array.isArray(panel)) continue;
      const { order, pinned } = panel as Record<string, unknown>;
      if (!Array.isArray(order) || !Array.isArray(pinned)) continue;
      preferences[panelId] = { order: decodeToolKinds(order), pinned: decodeToolKinds(pinned) };
    } catch {
      // Treat an unreadable panel as missing.
    }
  }
  return preferences;
}

const newTabShortcutsAtom = persistedAtom<NewTabShortcutPreferences>({
  debugLabel: "new-tab-shortcuts",
  storageKey: "nodex:new-tab-shortcuts:v1",
  defaultValue: {},
  hydration: "eager",
  decode: decodeNewTabShortcutPreferences,
});

/** The person's New tab arrangement for one panel, shared by every New tab and window. */
export function useNewTabShortcutPreference(panelId: PanelId): {
  /** Null until the person pins, unpins or reorders, and again after Reset to default. */
  readonly preference: NewTabShortcutPreference | null;
  /** False while the stored arrangement is still loading. */
  readonly ready: boolean;
  readonly update: (next: NewTabShortcutPreference | null) => void;
} {
  const loadable = usePersistedAtomValue(newTabShortcutsAtom);
  const write = useSetPersistedAtom(newTabShortcutsAtom);
  const update = (next: NewTabShortcutPreference | null) => {
    void write((current) =>
      next === null ? omitRecordKey(current, panelId) : { ...current, [panelId]: next },
    ).catch(() => {
      // The preference stays applied in this window. The next change retries the write.
    });
  };
  return {
    preference: loadable.value[panelId] ?? null,
    ready: loadable.status !== "loading",
    update,
  };
}
