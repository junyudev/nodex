import { useCallback, useRef, useState } from "react";
import type { Project } from "./types";
import {
  makeDefaultSidebarCollapsibleSectionsState,
  type SidebarDisclosureSectionId,
  type SidebarCollapsibleSectionsState,
} from "./sidebar-section-prefs";

function readInitialExpandedProjects(
  projects: readonly Project[],
  activeProjectId: string | null,
): Set<string> {
  const initial = new Set<string>();
  if (activeProjectId) initial.add(activeProjectId);
  if (projects.length === 1 && projects[0]) initial.add(projects[0].id);
  return initial;
}

interface UseWorkbenchSidebarStateInput {
  readonly projects: readonly Project[];
  readonly activeProjectId: string | null;
  readonly collapsibleSections?: SidebarCollapsibleSectionsState;
  readonly setCollapsibleSectionCollapsed?: (
    sectionId: SidebarDisclosureSectionId,
    collapsed: boolean,
  ) => void;
}

export function useWorkbenchSidebarState({
  projects,
  activeProjectId,
  collapsibleSections,
  setCollapsibleSectionCollapsed,
}: UseWorkbenchSidebarStateInput) {
  const [expandedProjectIds, setExpandedProjectIds] = useState(() =>
    readInitialExpandedProjects(projects, activeProjectId),
  );
  const [localCollapsibleSections, setLocalCollapsibleSections] = useState(
    makeDefaultSidebarCollapsibleSectionsState,
  );
  const [contextMenuSessionId, setContextMenuSessionId] = useState<string | null>(null);
  const [archivePendingKeys, setArchivePendingKeys] = useState<Set<string>>(() => new Set());
  const archivePendingKeysRef = useRef<ReadonlySet<string>>(archivePendingKeys);
  const resolvedCollapsibleSections = collapsibleSections ?? localCollapsibleSections;

  const toggleProjectExpanded = useCallback((projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  const ensureProjectExpanded = useCallback((projectId: string) => {
    setExpandedProjectIds((current) => {
      if (current.has(projectId)) return current;
      return new Set([...current, projectId]);
    });
  }, []);

  const setSectionCollapsed = useCallback(
    (sectionId: SidebarDisclosureSectionId, collapsed: boolean) => {
      if (setCollapsibleSectionCollapsed) {
        setCollapsibleSectionCollapsed(sectionId, collapsed);
        return;
      }

      setLocalCollapsibleSections((current) => {
        if (current[sectionId] === collapsed) return current;
        return {
          ...current,
          [sectionId]: collapsed,
        };
      });
    },
    [setCollapsibleSectionCollapsed],
  );

  const toggleSection = useCallback(
    (sectionId: SidebarDisclosureSectionId) => {
      setSectionCollapsed(sectionId, !resolvedCollapsibleSections[sectionId]);
    },
    [resolvedCollapsibleSections, setSectionCollapsed],
  );

  const beginContextMenu = useCallback((sessionId: string) => {
    setContextMenuSessionId(sessionId);
  }, []);

  const finishContextMenu = useCallback(() => {
    setContextMenuSessionId(null);
  }, []);

  const beginArchive = useCallback((key: string): boolean => {
    const current = archivePendingKeysRef.current;
    if (current.has(key)) return false;

    const next = new Set(current);
    next.add(key);
    archivePendingKeysRef.current = next;
    setArchivePendingKeys(next);
    return true;
  }, []);

  const finishArchive = useCallback((key: string) => {
    const current = archivePendingKeysRef.current;
    if (!current.has(key)) return;

    const next = new Set(current);
    next.delete(key);
    archivePendingKeysRef.current = next;
    setArchivePendingKeys(next);
  }, []);

  return {
    expandedProjectIds,
    toggleProjectExpanded,
    ensureProjectExpanded,
    contextMenuSessionId,
    beginContextMenu,
    finishContextMenu,
    archivePendingKeys,
    beginArchive,
    finishArchive,
    sections: resolvedCollapsibleSections,
    setSectionCollapsed,
    toggleSection,
    togglePinnedSection: () => toggleSection("pinned"),
    togglePagesSection: () => toggleSection("pages"),
    toggleProjectsSection: () => toggleSection("projects"),
    toggleChatsSection: () => toggleSection("chats"),
  };
}
