import { hashKey, useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Project } from "./types";
import { readDatabaseSettingsAuthority } from "./database-settings-runtime";
import { readDatabasePropertyOptions } from "../../shared/database-property-options";
import { queryKeys } from "./query-keys";
import { useProjectionInvalidationRegistry } from "./projection-invalidation-context";
import { invalidateExactQuery } from "./query-invalidation";

/** Loads only destination schemas; Page counts never affect the number of reads. */
export function useProjectDestinationStages(projects: readonly Project[]) {
  const queryClient = useQueryClient();
  const registry = useProjectionInvalidationRegistry();
  const queries = projects.map((project) => ({
    queryKey: queryKeys.destinationStages.byProject(
      project.id,
      project.libraryId,
      project.databaseId,
      project.defaultDatabaseViewId,
    ),
    queryFn: () =>
      readDatabaseSettingsAuthority({
        projectId: project.id,
        databaseId: project.databaseId,
        preferredViewId: project.defaultDatabaseViewId,
      }),
  }));
  const results = useQueries({ queries });
  const identity = JSON.stringify(
    projects.map((project) => [
      project.id,
      project.libraryId,
      project.databaseId,
      project.defaultDatabaseViewId,
    ]),
  );
  useEffect(() => {
    const bindings = JSON.parse(identity) as Array<[string, string, string, string | null]>;
    const unsubscribes = bindings.map(([projectId, libraryId, databaseId, viewId]) => {
      const queryKey = queryKeys.destinationStages.byProject(
        projectId,
        libraryId,
        databaseId,
        viewId,
      );
      return registry.register({
        scope: { kind: "project", projectId: projectId, libraryId: libraryId },
        consumerKey: hashKey(queryKey),
        getDependencies: () => {
          const authority =
            queryClient.getQueryData<Awaited<ReturnType<typeof readDatabaseSettingsAuthority>>>(
              queryKey,
            );
          return {
            databaseIds: [databaseId],
            dataSourceIds: authority ? [authority.dataSource.dataSourceId] : [],
          };
        },
        getCursor: () => {
          const authority =
            queryClient.getQueryData<Awaited<ReturnType<typeof readDatabaseSettingsAuthority>>>(
              queryKey,
            );
          return authority
            ? { storeEpoch: authority.snapshot.storeEpoch, commitSeq: authority.snapshot.commitSeq }
            : null;
        },
        invalidate: () => invalidateExactQuery(queryClient, queryKey),
      });
    });
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [identity, queryClient, registry]);
  return {
    optionsByProjectId: new Map(
      results.flatMap((result, index) => {
        const project = projects[index];
        if (!project || !result.data) return [];
        const property = result.data.source.properties.find(
          (property) => property.propertyId === "status" && property.lifecycle === "active",
        );
        return [[project.id, property ? readDatabasePropertyOptions(property) : []] as const];
      }),
    ),
    loading: results.some((result) => result.isPending),
    error: results.some((result) => result.isError) ? "Couldn’t load destination stages." : null,
  };
}
