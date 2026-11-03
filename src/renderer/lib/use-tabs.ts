import { useState, useCallback, useEffect } from "react";
import type { Project } from "./types";

export type ViewTab = "board" | "list" | "toggle-list" | "calendar";

export interface Tab {
  id: string;
  projectId: string;
  viewMode: ViewTab;
  searchQueries: Record<string, string>;
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string;
}

const STORAGE_KEY = "nodex-tabs";
const OLD_PROJECT_KEY = "nodex-project";
const VALID_VIEW_MODES: ViewTab[] = ["board", "list", "toggle-list", "calendar"];

function generateId(): string {
  return crypto.randomUUID();
}

function makeTab(projectId: string, viewMode: ViewTab = "board"): Tab {
  return { id: generateId(), projectId, viewMode, searchQueries: {} };
}

function isViewTab(value: unknown): value is ViewTab {
  return typeof value === "string" && VALID_VIEW_MODES.includes(value as ViewTab);
}

function normalizeSearchQueries(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};

  return Object.entries(value).reduce<Record<string, string>>((acc, [projectId, query]) => {
    if (typeof query !== "string") return acc;
    acc[projectId] = query;
    return acc;
  }, {});
}

function normalizeTab(tab: {
  id: string;
  projectId: string;
  viewMode?: unknown;
  searchQueries?: unknown;
}): Tab {
  return {
    ...tab,
    viewMode: isViewTab(tab.viewMode) ? tab.viewMode : "board",
    searchQueries: normalizeSearchQueries(tab.searchQueries),
  };
}

function loadState(): TabsState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { tabs?: unknown; activeTabId?: unknown };
    if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return null;

    const normalizedTabs = parsed.tabs
      .filter(
        (
          tab,
        ): tab is { id: string; projectId: string; viewMode?: unknown; searchQueries?: unknown } =>
          typeof tab === "object" &&
          tab !== null &&
          typeof (tab as { id?: unknown }).id === "string" &&
          typeof (tab as { projectId?: unknown }).projectId === "string",
      )
      .map((tab) => normalizeTab(tab));

    if (normalizedTabs.length === 0) return null;

    return {
      tabs: normalizedTabs,
      activeTabId:
        typeof parsed.activeTabId === "string" ? parsed.activeTabId : normalizedTabs[0].id,
    };
  } catch {
    return null;
  }
}

function saveState(state: TabsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable
  }
}

function syncUrl(projectId: string): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get("project") !== projectId) {
    params.set("project", projectId);
    window.history.replaceState(null, "", `?${params.toString()}`);
  }
  try {
    localStorage.setItem(OLD_PROJECT_KEY, projectId);
  } catch {
    // ignore
  }
}

function buildInitialState(projects: Project[]): TabsState {
  if (projects.length === 0) {
    const tab = makeTab("default");
    return { tabs: [tab], activeTabId: tab.id };
  }

  // Try restoring saved tabs
  const saved = loadState();
  if (saved) {
    const projectIds = new Set(projects.map((p) => p.id));
    const validTabs = saved.tabs.filter((t) => projectIds.has(t.projectId));
    if (validTabs.length > 0) {
      const activeStillValid = validTabs.some((t) => t.id === saved.activeTabId);
      return {
        tabs: validTabs,
        activeTabId: activeStillValid ? saved.activeTabId : validTabs[0].id,
      };
    }
  }

  // Migrate from old single-project preference
  const params = new URLSearchParams(window.location.search);
  let preferred = params.get("project");
  if (!preferred) {
    try {
      preferred = localStorage.getItem(OLD_PROJECT_KEY);
    } catch {
      // ignore
    }
  }

  const projectIds = projects.map((p) => p.id);
  const targetId = preferred && projectIds.includes(preferred) ? preferred : projectIds[0];
  const tab = makeTab(targetId);
  return { tabs: [tab], activeTabId: tab.id };
}

export function useTabs(projects: Project[]) {
  const [state, setState] = useState<TabsState>(() => buildInitialState(projects));
  const [previousProjects, setPreviousProjects] = useState(projects);

  if (previousProjects !== projects) {
    setPreviousProjects(projects);
    if (previousProjects.length === 0 && projects.length > 0) {
      setState(() => buildInitialState(projects));
    } else if (projects.length > 0) {
      const projectIds = new Set(projects.map((project) => project.id));
      setState((previous) => {
        const tabs = previous.tabs.filter((tab) => projectIds.has(tab.projectId));
        if (tabs.length === previous.tabs.length) return previous;
        if (tabs.length === 0) {
          const tab = makeTab(projects[0].id);
          return { tabs: [tab], activeTabId: tab.id };
        }
        return {
          tabs,
          activeTabId: tabs.some((tab) => tab.id === previous.activeTabId)
            ? previous.activeTabId
            : tabs[0].id,
        };
      });
    }
  }

  // Persist and sync URL on state change
  useEffect(() => {
    saveState(state);
    const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
    if (activeTab) {
      syncUrl(activeTab.projectId);
    }
  }, [state]);

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;

  const openTab = useCallback((projectId: string) => {
    setState((prev) => {
      // If already open, just focus it
      const existing = prev.tabs.find((t) => t.projectId === projectId);
      if (existing) {
        return { ...prev, activeTabId: existing.id };
      }
      const tab = makeTab(projectId);
      return {
        tabs: [...prev.tabs, tab],
        activeTabId: tab.id,
      };
    });
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setState((prev) => {
      if (prev.tabs.length <= 1) return prev; // keep at least 1

      const idx = prev.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return prev;

      const newTabs = prev.tabs.filter((t) => t.id !== tabId);
      let newActiveId = prev.activeTabId;

      if (prev.activeTabId === tabId) {
        // Activate neighbor: prefer right, then left
        const neighborIdx = Math.min(idx, newTabs.length - 1);
        newActiveId = newTabs[neighborIdx].id;
      }

      return { tabs: newTabs, activeTabId: newActiveId };
    });
  }, []);

  const setActiveTab = useCallback((tabId: string) => {
    setState((prev) => {
      if (prev.activeTabId === tabId) return prev;
      if (!prev.tabs.some((t) => t.id === tabId)) return prev;
      return { ...prev, activeTabId: tabId };
    });
  }, []);

  const switchProject = useCallback((tabId: string, projectId: string) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, projectId } : t)),
    }));
  }, []);

  const setViewMode = useCallback((tabId: string, mode: ViewTab) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, viewMode: mode } : t)),
    }));
  }, []);

  const setSearchQuery = useCallback((tabId: string, projectId: string, query: string) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        return {
          ...tab,
          searchQueries: {
            ...tab.searchQueries,
            [projectId]: query,
          },
        };
      }),
    }));
  }, []);

  const switchToTabIndex = useCallback((index: number) => {
    setState((prev) => {
      if (index < 0 || index >= prev.tabs.length) return prev;
      return { ...prev, activeTabId: prev.tabs[index].id };
    });
  }, []);

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeTab,
    openTab,
    closeTab,
    setActiveTab,
    switchProject,
    setViewMode,
    setSearchQuery,
    switchToTabIndex,
  };
}
