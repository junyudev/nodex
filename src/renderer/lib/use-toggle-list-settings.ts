import { useCallback, useEffect, useMemo, useState } from "react";
import type { ToggleListSettings } from "./toggle-list/types";
import {
  getDefaultToggleListSettings,
  normalizeToggleListSettings,
} from "./toggle-list/settings";

const STORAGE_KEY = "nodex-toggle-list-settings-v1";

type PersistedSettings = Record<string, ToggleListSettings>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readAll(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    return Object.entries(parsed).reduce<PersistedSettings>((acc, [projectId, value]) => {
      if (typeof projectId !== "string") return acc;
      const normalized = normalizeToggleListSettings(value);
      acc[projectId] = normalized;
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function writeAll(next: PersistedSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage may be unavailable
  }
}

export function useToggleListSettings(projectId: string) {
  const [settings, setSettings] = useState<ToggleListSettings>(() => {
    const all = readAll();
    return all[projectId] ?? getDefaultToggleListSettings();
  });

  useEffect(() => {
    const all = readAll();
    setSettings(all[projectId] ?? getDefaultToggleListSettings());
  }, [projectId]);

  useEffect(() => {
    const all = readAll();
    writeAll({
      ...all,
      [projectId]: settings,
    });
  }, [projectId, settings]);

  const reset = useCallback(() => {
    setSettings(getDefaultToggleListSettings());
  }, []);

  const update = useCallback(
    (fn: (prev: ToggleListSettings) => ToggleListSettings) => {
      setSettings(fn);
    },
    [],
  );

  const helpers = useMemo(
    () => ({
      update,
      reset,
    }),
    [reset, update],
  );

  return {
    settings,
    ...helpers,
  };
}
