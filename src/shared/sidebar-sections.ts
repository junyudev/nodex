import type { ProjectAppearance } from "./project-appearance";
import type { CodexThreadActiveFlag, Project } from "./types";

export type SidebarSectionKind = "pinned" | "pages" | "projects" | "chats" | "custom";
export type SidebarSectionLifecycle = "active" | "deleted";

export const SIDEBAR_SECTION_CONTAINER_PREFIX = "section:";

export const sidebarSectionContainerId = (sectionId: string): string =>
  `${SIDEBAR_SECTION_CONTAINER_PREFIX}${sectionId}`;

export const readSidebarSectionContainerId = (containerId: string): string | null => {
  if (!containerId.startsWith(SIDEBAR_SECTION_CONTAINER_PREFIX)) return null;
  return containerId.slice(SIDEBAR_SECTION_CONTAINER_PREFIX.length).trim() || null;
};

export interface SidebarSectionSummary {
  readonly sectionId: string;
  readonly kind: SidebarSectionKind;
  readonly name: string | null;
  readonly rankKey: number;
  readonly revision: number;
  readonly lifecycle: SidebarSectionLifecycle;
  readonly directItemCount: number;
  readonly effectiveSessionCount: number;
  readonly hasRunning: boolean;
  readonly hasUnread: boolean;
}

export interface SidebarSectionWindow {
  readonly items: readonly SidebarSectionSummary[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly projectionRevision: number;
}

export type SidebarSectionItemRef =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "session"; readonly sessionId: string };

export type SidebarSectionItemPlacement =
  | { readonly kind: "start" }
  | { readonly kind: "end" }
  | { readonly kind: "before"; readonly item: SidebarSectionItemRef }
  | { readonly kind: "after"; readonly item: SidebarSectionItemRef };

export type SidebarSectionItem =
  | {
      readonly placementId: string;
      readonly rankKey: number;
      readonly revision: number;
      readonly kind: "project";
      readonly project: {
        readonly projectId: string;
        readonly name: string;
        readonly lifecycle: Project["lifecycle"];
        readonly appearance: ProjectAppearance;
        readonly pinned: boolean;
      };
    }
  | {
      readonly placementId: string;
      readonly rankKey: number;
      readonly revision: number;
      readonly kind: "session";
      readonly session: {
        readonly sessionId: string;
        readonly projectId: string | null;
        readonly displayTitle: string;
        readonly pinned: boolean;
        readonly archived: boolean;
        readonly unread: boolean;
        readonly threadId: string | null;
        readonly status: {
          readonly statusType: "notLoaded" | "idle" | "systemError" | "active";
          readonly activeFlags: readonly CodexThreadActiveFlag[];
        } | null;
      };
    };

export interface SidebarSectionItemWindow {
  readonly items: readonly SidebarSectionItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly projectionRevision: number;
}

export interface SidebarSectionWindowInput {
  readonly includeDeleted?: boolean;
  readonly after?: string | null;
  readonly first?: number;
}

export interface SidebarSectionItemWindowInput {
  readonly includeArchived?: boolean;
  readonly after?: string | null;
  readonly first?: number;
}

export interface SidebarSectionCreateInput {
  readonly name: string;
  readonly initialItem?: SidebarSectionItemRef | null;
}

export interface SidebarSectionRenameInput {
  readonly name: string;
  readonly expectedRevision: number;
}

export interface SidebarSectionRevisionInput {
  readonly expectedRevision: number;
}

export interface SidebarSectionMoveItemInput {
  readonly item: SidebarSectionItemRef;
  readonly sectionId: string | null;
  readonly placement: SidebarSectionItemPlacement;
}

export interface SidebarSectionSessionCreateInput {
  readonly sectionId: string;
  readonly title?: string;
  readonly initialPageIds?: readonly string[];
}

export interface SidebarSectionArchiveInput {
  readonly createReplacement?: boolean;
}
