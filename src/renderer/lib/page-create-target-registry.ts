import type { ContentRoutingContext } from "../../shared/content-routing-context";
import type { DataSourcePropertyRecordV2 } from "../../shared/database-module-v2";
import type { ProjectAppearance } from "../../shared/project-appearance";
import { appScope, scopedAtom, type ScopeHandle, useScopedAtomValue } from "./maitai";
import type { BoardSummaryColumn, WorkflowStatus } from "./types";

export interface PageCreateTarget {
  readonly surfaceId: string;
  readonly panelTabId: string;
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly appearance: ProjectAppearance;
  };
  readonly databaseViewId: string;
  readonly clientSessionId: string;
  readonly routingContext: ContentRoutingContext;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly columns: readonly Pick<BoardSummaryColumn, "id" | "name">[];
}

export interface PageCreateTargetRegistration {
  readonly token: string;
  readonly target: PageCreateTarget;
  readonly activeColumnId: WorkflowStatus | null;
  readonly activitySequence: number;
}

export type PageCreateTargetCapability =
  | {
      readonly status: "ready";
      readonly target: PageCreateTarget;
    }
  | {
      readonly status: "loading" | "unavailable";
      readonly reason: string;
    };

export interface ProjectDefaultPageCreateTargetRegistration {
  readonly token: string;
  readonly projectId: string;
  readonly capability: PageCreateTargetCapability;
}

export interface PageCreateTargetRegistryState {
  readonly boardRegistrations: Readonly<Record<string, PageCreateTargetRegistration>>;
  readonly projectDefaultRegistrations: Readonly<
    Record<string, ProjectDefaultPageCreateTargetRegistration>
  >;
  readonly activeSurfaceId: string | null;
  readonly nextActivitySequence: number;
}

export type PageCreateTargetResolution =
  | {
      readonly status: "resolved";
      readonly target: PageCreateTarget;
      readonly columnId: WorkflowStatus;
    }
  | {
      readonly status: "unavailable";
      readonly reason: string;
    };

const INITIAL_PAGE_CREATE_TARGET_REGISTRY_STATE: PageCreateTargetRegistryState = {
  boardRegistrations: {},
  projectDefaultRegistrations: {},
  activeSurfaceId: null,
  nextActivitySequence: 1,
};

const pageCreateTargetRegistryAtom = scopedAtom<PageCreateTargetRegistryState>(
  appScope,
  INITIAL_PAGE_CREATE_TARGET_REGISTRY_STATE,
  { debugLabel: "page-create-target-registry" },
);

function resolveColumnId(registration: PageCreateTargetRegistration): WorkflowStatus | null {
  const { activeColumnId, target } = registration;
  if (activeColumnId && target.columns.some((column) => column.id === activeColumnId)) {
    return activeColumnId;
  }
  return target.columns[0]?.id ?? null;
}

export function resolvePageCreateTarget(
  state: PageCreateTargetRegistryState,
  activeProjectId: string | null,
): PageCreateTargetResolution {
  const registrations = Object.values(state.boardRegistrations);
  const active = state.activeSurfaceId
    ? (state.boardRegistrations[state.activeSurfaceId] ?? null)
    : null;

  if (active) {
    const columnId = resolveColumnId(active);
    if (columnId) {
      return { status: "resolved", target: active.target, columnId };
    }
    return {
      status: "unavailable",
      reason: "This Database View has no workflow columns.",
    };
  }

  if (!activeProjectId) {
    return {
      status: "unavailable",
      reason: "Select a Project before creating a Page.",
    };
  }

  const recentlyActive = registrations
    .filter(
      (registration) =>
        registration.target.project.id === activeProjectId &&
        registration.activitySequence > 0 &&
        resolveColumnId(registration),
    )
    .toSorted((left, right) => right.activitySequence - left.activitySequence)[0];
  if (recentlyActive) {
    const columnId = resolveColumnId(recentlyActive);
    if (columnId) {
      return { status: "resolved", target: recentlyActive.target, columnId };
    }
  }

  const projectDefault = state.projectDefaultRegistrations[activeProjectId];
  if (!projectDefault) {
    return {
      status: "unavailable",
      reason: "Preparing this Project’s default Database View…",
    };
  }
  if (projectDefault.capability.status !== "ready") {
    return {
      status: "unavailable",
      reason: projectDefault.capability.reason,
    };
  }

  const defaultTarget = projectDefault.capability.target;
  const columnId = defaultTarget.columns[0]?.id ?? null;
  if (!columnId) {
    return {
      status: "unavailable",
      reason: "This Database View has no workflow columns.",
    };
  }
  return { status: "resolved", target: defaultTarget, columnId };
}

export function registerPageCreateTarget(
  appHandle: ScopeHandle,
  token: string,
  target: PageCreateTarget,
): void {
  appHandle.set(pageCreateTargetRegistryAtom, (previous) => {
    const existing = previous.boardRegistrations[target.surfaceId];
    return {
      ...previous,
      boardRegistrations: {
        ...previous.boardRegistrations,
        [target.surfaceId]: {
          token,
          target,
          activeColumnId: existing?.activeColumnId ?? null,
          activitySequence: existing?.activitySequence ?? 0,
        },
      },
    };
  });
}

export function unregisterPageCreateTarget(
  appHandle: ScopeHandle,
  surfaceId: string,
  token: string,
): void {
  appHandle.set(pageCreateTargetRegistryAtom, (previous) => {
    const existing = previous.boardRegistrations[surfaceId];
    if (!existing || existing.token !== token) return previous;

    const boardRegistrations = { ...previous.boardRegistrations };
    delete boardRegistrations[surfaceId];
    return {
      ...previous,
      boardRegistrations,
      activeSurfaceId: previous.activeSurfaceId === surfaceId ? null : previous.activeSurfaceId,
    };
  });
}

export function markPageCreateTargetActive(
  appHandle: ScopeHandle,
  surfaceId: string,
  columnId?: WorkflowStatus,
): void {
  appHandle.set(pageCreateTargetRegistryAtom, (previous) => {
    const existing = previous.boardRegistrations[surfaceId];
    if (!existing) return previous;

    return {
      ...previous,
      boardRegistrations: {
        ...previous.boardRegistrations,
        [surfaceId]: {
          ...existing,
          activeColumnId: columnId ?? existing.activeColumnId,
          activitySequence: previous.nextActivitySequence,
        },
      },
      activeSurfaceId: surfaceId,
      nextActivitySequence: previous.nextActivitySequence + 1,
    };
  });
}

export function getPageCreateTarget(
  appHandle: ScopeHandle,
  surfaceId: string,
): PageCreateTarget | null {
  const state = appHandle.get(pageCreateTargetRegistryAtom);
  const boardTarget = state.boardRegistrations[surfaceId]?.target;
  if (boardTarget) return boardTarget;

  for (const registration of Object.values(state.projectDefaultRegistrations)) {
    const { capability } = registration;
    if (capability.status !== "ready") continue;
    if (capability.target.surfaceId === surfaceId) return capability.target;
  }
  return null;
}

export function registerProjectDefaultPageCreateTarget(
  appHandle: ScopeHandle,
  projectId: string,
  token: string,
  capability: PageCreateTargetCapability,
): void {
  appHandle.set(pageCreateTargetRegistryAtom, (previous) => ({
    ...previous,
    projectDefaultRegistrations: {
      ...previous.projectDefaultRegistrations,
      [projectId]: { token, projectId, capability },
    },
  }));
}

export function unregisterProjectDefaultPageCreateTarget(
  appHandle: ScopeHandle,
  projectId: string,
  token: string,
): void {
  appHandle.set(pageCreateTargetRegistryAtom, (previous) => {
    const existing = previous.projectDefaultRegistrations[projectId];
    if (!existing || existing.token !== token) return previous;

    const projectDefaultRegistrations = {
      ...previous.projectDefaultRegistrations,
    };
    delete projectDefaultRegistrations[projectId];
    return { ...previous, projectDefaultRegistrations };
  });
}

export function resolveRegisteredPageCreateTarget(
  appHandle: ScopeHandle,
  activeProjectId: string | null,
): PageCreateTargetResolution {
  return resolvePageCreateTarget(appHandle.get(pageCreateTargetRegistryAtom), activeProjectId);
}

export function usePageCreateTargetResolution(
  activeProjectId: string | null,
): PageCreateTargetResolution {
  return resolvePageCreateTarget(useScopedAtomValue(pageCreateTargetRegistryAtom), activeProjectId);
}
