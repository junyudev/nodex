import type { ProjectSession } from "../../shared/types";

export interface ProjectAgentDockMaterializationPort {
  readonly ensureDefaultDraft: (projectId: string) => Promise<ProjectSession>;
}

export interface ProjectAgentDockMaterializer {
  readonly materialize: (
    input: {
      readonly projectId: string;
      readonly draftId: string;
    },
    port: ProjectAgentDockMaterializationPort,
  ) => Promise<ProjectSession>;
}

function draftKey(projectId: string, draftId: string): string {
  return `${projectId}\u0000${draftId}`;
}

/**
 * Coalesces one Window-local Project draft onto the Core-owned default Session.
 * The caller commits the Scene binding only after Thread start succeeds, so a
 * failed start keeps the original draft scope and its composer state retryable.
 */
export function createProjectAgentDockMaterializer(): ProjectAgentDockMaterializer {
  const materializations = new Map<string, Promise<ProjectSession>>();

  return {
    materialize(input, port) {
      const key = draftKey(input.projectId, input.draftId);
      const current = materializations.get(key);
      if (current) return current;

      const materialization = port
        .ensureDefaultDraft(input.projectId)
        .then((session) => {
          if (session.projectId !== input.projectId) {
            throw new Error("Default draft does not belong to the Project Agent Dock");
          }
          return session;
        })
        .catch((error: unknown) => {
          materializations.delete(key);
          throw error;
        });
      materializations.set(key, materialization);
      return materialization;
    },
  };
}

export function createProjectAgentDockDraftSession(
  projectId: string,
  draftId: string,
): ProjectSession {
  const timestamp = new Date(0).toISOString();
  return {
    id: `project-draft:${draftId}`,
    projectId,
    noThreadFallbackTitle: "New chat",
    displayTitle: "New chat",
    activityAt: 0,
    managed: false,
    pinned: false,
    pinnedOrder: null,
    archived: false,
    archivedAt: null,
    remindAt: null,
    canManage: true,
    canStop: true,
    unread: false,
    thread: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
