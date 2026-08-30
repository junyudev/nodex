import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import type { ProjectAppearance } from "../../shared/project-appearance";
import { projectCatalogStoreFor } from "./project-catalog";
import { queryKeys } from "./query-keys";
import type { Project } from "./types";

export function useProjectAppearanceMutation(project: Project) {
  const queryClient = useQueryClient();
  const projectCatalog = useMemo(() => projectCatalogStoreFor(queryClient), [queryClient]);
  const projectId = project.id;
  const latestSequenceRef = useRef(0);
  const pendingCountRef = useRef(0);
  const confirmedProjectRef = useRef(project);
  const latestSettlementRef = useRef<Promise<Project>>(Promise.resolve(project));
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (pendingCountRef.current > 0) return;
    confirmedProjectRef.current = project;
    latestSettlementRef.current = Promise.resolve(project);
  }, [project]);

  const changeAppearanceAsync = (appearance: ProjectAppearance): Promise<Project> => {
    const sequence = latestSequenceRef.current + 1;
    latestSequenceRef.current = sequence;
    pendingCountRef.current += 1;
    setPendingCount(pendingCountRef.current);
    setError(null);

    // `updateProject()` installs the catalog presentation synchronously.
    const operation = projectCatalog.updateProject(projectId, { appearance });
    const request = (async () => {
      try {
        const outcome = await operation;
        if (outcome.kind === "acknowledged") {
          confirmedProjectRef.current = outcome.project;
          return outcome.project;
        }
        if (outcome.kind === "definitive_failure" || outcome.kind === "unknown_outcome") {
          throw new Error(outcome.failure.message);
        }
        throw new Error("The Project appearance update was superseded by a newer authority");
      } catch (cause) {
        const failure = cause instanceof Error ? cause : new Error("Could not update Project");
        if (sequence === latestSequenceRef.current) {
          setError(failure);
          toast.danger("Could not update project marker", { description: failure.message });
        }
        throw failure;
      } finally {
        pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
        setPendingCount(pendingCountRef.current);
        if (sequence === latestSequenceRef.current) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all() });
        }
      }
    })();
    const settlement = request.catch(() => confirmedProjectRef.current);
    latestSettlementRef.current = settlement;
    return request;
  };

  const waitForSettledProject = async (): Promise<Project> => {
    if (pendingCountRef.current === 0) return confirmedProjectRef.current;
    while (true) {
      const settlement = latestSettlementRef.current;
      const settledProject = await settlement;
      if (settlement === latestSettlementRef.current) return settledProject;
    }
  };

  return {
    changeAppearance: (appearance: ProjectAppearance) => {
      void changeAppearanceAsync(appearance).catch(() => undefined);
    },
    changeAppearanceAsync,
    error,
    pending: pendingCount > 0,
    waitForSettledProject,
  };
}
