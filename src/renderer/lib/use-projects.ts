import { useCallback, useEffect, useState } from "react";
import type { Project } from "./types";
import { invoke } from "./api";

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = useCallback(async () => {
    try {
      const data = (await invoke("projects:list")) as Project[];
      setProjects(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const createProject = useCallback(
    async (
      id: string,
      name: string,
      description?: string,
      icon?: string,
      workspacePath?: string | null,
    ): Promise<Project | null> => {
      try {
        const project = (await invoke("projects:create", {
          id,
          name,
          description,
          icon,
          workspacePath,
        })) as Project;
        await fetchProjects();
        return project;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        return null;
      }
    },
    [fetchProjects]
  );

  const deleteProject = useCallback(
    async (projectId: string): Promise<boolean> => {
      try {
        const result = (await invoke("projects:delete", projectId)) as boolean;
        if (result) await fetchProjects();
        return result;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        return false;
      }
    },
    [fetchProjects]
  );

  const renameProject = useCallback(
    async (
      oldId: string,
      newId: string,
      name?: string,
      description?: string,
      icon?: string,
      workspacePath?: string | null,
    ): Promise<Project | null> => {
      try {
        const project = (await invoke(
          "projects:rename",
          oldId,
          newId,
          { name, description, icon, workspacePath }
        )) as Project;
        await fetchProjects();
        return project;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        return null;
      }
    },
    [fetchProjects]
  );

  return {
    projects,
    loading,
    error,
    refresh: fetchProjects,
    createProject,
    deleteProject,
    renameProject,
  };
}
