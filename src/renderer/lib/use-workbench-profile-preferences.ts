import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { WorkbenchRecentPageSessionSchema } from "../../shared/schemas/workbench";
import type { WorkbenchRecentPageSession } from "./types";
import {
  CODEX_SIDEBAR_WIDTH_DEFAULT_PX,
  clampCodexSidebarWidth,
} from "./codex-sidebar-auto-reveal";
import {
  normalizeSidebarCollapsibleSectionsState,
  type SidebarDisclosureSectionId,
  type SidebarCollapsibleSectionsState,
} from "./sidebar-section-prefs";
import { appScope, scopedAtom, useScopedAtom } from "./maitai";
import { WORKBENCH_PERSIST_DEBOUNCE_MS } from "./timing";

export type RecentPageSession = WorkbenchRecentPageSession;
export type {
  SidebarCollapsibleSectionId,
  SidebarDisclosureSectionId,
  SidebarCollapsibleSectionsState,
} from "./sidebar-section-prefs";

export interface WorkbenchSidebarPreferences {
  readonly collapsed: boolean;
  readonly width: number;
  readonly collapsibleSections: SidebarCollapsibleSectionsState;
}

export interface WorkbenchProfilePreferences {
  readonly sidebar: WorkbenchSidebarPreferences;
  readonly recentPageSessions: RecentPageSession[];
}

const WORKBENCH_PROFILE_PREFERENCES_STORAGE_KEY = "nodex-workbench-profile-preferences-v2";
const LEGACY_WORKBENCH_PROFILE_PREFERENCES_STORAGE_KEY = "nodex-workbench-profile-preferences-v1";
const MAX_RECENT_PAGE_SESSIONS = 10;
const workbenchProfilePreferencesAtom = scopedAtom<WorkbenchProfilePreferences | null>(
  appScope,
  null,
  { debugLabel: "workbench-profile-preferences" },
);

function makeDefaultWorkbenchProfilePreferences(): WorkbenchProfilePreferences {
  return {
    sidebar: {
      collapsed: false,
      width: CODEX_SIDEBAR_WIDTH_DEFAULT_PX,
      collapsibleSections: normalizeSidebarCollapsibleSectionsState(undefined),
    },
    recentPageSessions: [],
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeRecentPageSessions(value: unknown): RecentPageSession[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((candidate) => {
      const parsed = WorkbenchRecentPageSessionSchema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, MAX_RECENT_PAGE_SESSIONS);
}

export function normalizeWorkbenchProfilePreferences(value: unknown): WorkbenchProfilePreferences {
  return normalizeWorkbenchProfilePreferencesAtBoundary(value);
}

export function normalizeLegacyWorkbenchProfilePreferences(
  value: unknown,
): WorkbenchProfilePreferences {
  return normalizeWorkbenchProfilePreferencesAtBoundary(value);
}

function normalizeWorkbenchProfilePreferencesAtBoundary(
  value: unknown,
): WorkbenchProfilePreferences {
  const defaults = makeDefaultWorkbenchProfilePreferences();
  const record = readRecord(value);
  if (!record) return defaults;
  const sidebar = readRecord(record.sidebar);

  return {
    sidebar: {
      collapsed:
        typeof sidebar?.collapsed === "boolean" ? sidebar.collapsed : defaults.sidebar.collapsed,
      width: clampCodexSidebarWidth(
        typeof sidebar?.width === "number" ? sidebar.width : defaults.sidebar.width,
      ),
      collapsibleSections: normalizeSidebarCollapsibleSectionsState(sidebar?.collapsibleSections),
    },
    recentPageSessions: normalizeRecentPageSessions(record.recentPageSessions),
  };
}

type WorkbenchPreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function loadWorkbenchProfilePreferencesFromStorage(
  storage: WorkbenchPreferenceStorage,
): WorkbenchProfilePreferences {
  try {
    const raw = storage.getItem(WORKBENCH_PROFILE_PREFERENCES_STORAGE_KEY);
    if (raw) return normalizeWorkbenchProfilePreferences(JSON.parse(raw));

    const legacyRaw = storage.getItem(LEGACY_WORKBENCH_PROFILE_PREFERENCES_STORAGE_KEY);
    if (!legacyRaw) return makeDefaultWorkbenchProfilePreferences();
    const migrated = normalizeLegacyWorkbenchProfilePreferences(JSON.parse(legacyRaw));
    if (persistWorkbenchProfilePreferences(migrated, storage)) {
      try {
        storage.removeItem(LEGACY_WORKBENCH_PROFILE_PREFERENCES_STORAGE_KEY);
      } catch {
        // A retained v1 value is safe and can be retried on the next load.
      }
    }
    return migrated;
  } catch {
    return makeDefaultWorkbenchProfilePreferences();
  }
}

function loadWorkbenchProfilePreferences(): WorkbenchProfilePreferences {
  return loadWorkbenchProfilePreferencesFromStorage(localStorage);
}

function persistWorkbenchProfilePreferences(
  preferences: WorkbenchProfilePreferences,
  storage: Pick<Storage, "setItem"> = localStorage,
): boolean {
  try {
    storage.setItem(WORKBENCH_PROFILE_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    // Preferences remain valid for the current renderer lifetime.
    return false;
  }
}

export function recordRecentPageLeaveInPreferences(
  recentPageSessions: readonly RecentPageSession[],
  input: {
    readonly id: string;
    readonly projectId: string;
    readonly pageId: string;
    readonly titleSnapshot: string;
    readonly lastOpenedAt: string;
  },
): RecentPageSession[] {
  const existing = recentPageSessions.find(
    (session) => session.projectId === input.projectId && session.pageId === input.pageId,
  );
  if (existing) {
    return recentPageSessions.map((session) =>
      session.id === existing.id
        ? {
            ...session,
            titleSnapshot: input.titleSnapshot,
            lastOpenedAt: input.lastOpenedAt,
          }
        : session,
    );
  }

  return [
    {
      id: input.id,
      projectId: input.projectId,
      pageId: input.pageId,
      titleSnapshot: input.titleSnapshot,
      lastOpenedAt: input.lastOpenedAt,
    },
    ...recentPageSessions,
  ].slice(0, MAX_RECENT_PAGE_SESSIONS);
}

export function useWorkbenchProfilePreferences() {
  const [storedPreferences, setStoredPreferences] = useScopedAtom(workbenchProfilePreferencesAtom);
  const initialPreferencesRef = useRef<WorkbenchProfilePreferences | null>(null);
  if (!initialPreferencesRef.current) {
    initialPreferencesRef.current = loadWorkbenchProfilePreferences();
  }
  const initialPreferences = initialPreferencesRef.current;
  const preferences = storedPreferences ?? initialPreferences;

  useLayoutEffect(() => {
    setStoredPreferences((current) => current ?? initialPreferences);
  }, [initialPreferences, setStoredPreferences]);

  const pendingPersistRef = useRef<WorkbenchProfilePreferences | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const flush = useCallback(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    const pending = pendingPersistRef.current;
    if (!pending) return;
    pendingPersistRef.current = null;
    persistWorkbenchProfilePreferences(pending);
  }, []);

  useEffect(() => {
    pendingPersistRef.current = preferences;
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(flush, WORKBENCH_PERSIST_DEBOUNCE_MS);
  }, [flush, preferences]);

  useEffect(() => {
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [flush]);

  const update = useCallback(
    (transform: (current: WorkbenchProfilePreferences) => WorkbenchProfilePreferences) => {
      setStoredPreferences((current) => transform(current ?? initialPreferences));
    },
    [initialPreferences, setStoredPreferences],
  );

  const setSidebarCollapsed = useCallback(
    (collapsed: boolean) => {
      update((current) => {
        if (current.sidebar.collapsed === collapsed) return current;
        return {
          ...current,
          sidebar: { ...current.sidebar, collapsed },
        };
      });
    },
    [update],
  );

  const setSidebarWidth = useCallback(
    (width: number) => {
      const next = clampCodexSidebarWidth(width);
      update((current) => {
        if (current.sidebar.width === next) return current;
        return {
          ...current,
          sidebar: { ...current.sidebar, width: next },
        };
      });
    },
    [update],
  );

  const setSidebarCollapsibleSectionCollapsed = useCallback(
    (sectionId: SidebarDisclosureSectionId, collapsed: boolean) => {
      update((current) => {
        if (current.sidebar.collapsibleSections[sectionId] === collapsed) {
          return current;
        }
        return {
          ...current,
          sidebar: {
            ...current.sidebar,
            collapsibleSections: {
              ...current.sidebar.collapsibleSections,
              [sectionId]: collapsed,
            },
          },
        };
      });
    },
    [update],
  );

  const recordRecentPageLeave = useCallback(
    (projectId: string, pageId: string, titleSnapshot: string): string => {
      const id = crypto.randomUUID();
      const lastOpenedAt = new Date().toISOString();
      let selectedId: string = id;
      update((current) => {
        const existing = current.recentPageSessions.find(
          (session) => session.projectId === projectId && session.pageId === pageId,
        );
        selectedId = existing?.id ?? id;
        return {
          ...current,
          recentPageSessions: recordRecentPageLeaveInPreferences(current.recentPageSessions, {
            id,
            projectId,
            pageId,
            titleSnapshot,
            lastOpenedAt,
          }),
        };
      });
      return selectedId;
    },
    [update],
  );

  return useMemo(
    () => ({
      sidebar: preferences.sidebar,
      recentPageSessions: preferences.recentPageSessions,
      setSidebarCollapsed,
      setSidebarWidth,
      setSidebarCollapsibleSectionCollapsed,
      recordRecentPageLeave,
      flush,
    }),
    [
      flush,
      preferences,
      recordRecentPageLeave,
      setSidebarCollapsed,
      setSidebarCollapsibleSectionCollapsed,
      setSidebarWidth,
    ],
  );
}

export const workbenchProfilePreferencesStorageKey = WORKBENCH_PROFILE_PREFERENCES_STORAGE_KEY;
export const legacyWorkbenchProfilePreferencesStorageKey =
  LEGACY_WORKBENCH_PROFILE_PREFERENCES_STORAGE_KEY;
