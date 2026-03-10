import { useCallback, useEffect, useState } from "react";
import { invoke } from "@/lib/api";
import type { Board } from "@/lib/types";
import { useProjects } from "@/lib/use-projects";

/**
 * Fetches boards for every project. Used by card pickers and @ mention menus.
 */
export function useAllBoards() {
  const { projects } = useProjects();
  const [boards, setBoards] = useState<Map<string, Board>>(new Map());
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    const results = new Map<string, Board>();
    await Promise.all(
      projects.map(async (project) => {
        try {
          const board = (await invoke("board:get", project.id)) as Board;
          results.set(project.id, board);
        } catch {
          // skip failed projects
        }
      }),
    );
    setBoards(results);
    setLoading(false);
  }, [projects]);

  useEffect(() => {
    if (projects.length > 0) {
      void fetchAll();
    } else {
      setBoards(new Map());
      setLoading(false);
    }
  }, [projects, fetchAll]);

  return { boards, loading };
}
