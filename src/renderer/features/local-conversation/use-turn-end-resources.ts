import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CodexConversationTurn } from "../../lib/types";
import { readWorkspacePathsExist } from "../../lib/workspace-file-operations";
import {
  collectTurnEndResources,
  filterTurnEndResources,
  getTurnEndResourcePaths,
} from "./projection/thread-summary-panel-output-model";

/** One existence result owns both visible resources and duplicate-output suppression. */
export function useTurnEndResources(input: {
  readonly turn: CodexConversationTurn | null;
  readonly hostId: string;
  readonly cwd?: string | null;
  readonly projectlessOutputDirectory?: string | null;
  readonly includeResources: boolean;
}) {
  const { turn, hostId, cwd, projectlessOutputDirectory, includeResources } = input;
  const candidates = useMemo(
    () =>
      turn && includeResources
        ? collectTurnEndResources(turn, { cwd, projectlessOutputDirectory })
        : [],
    [turn, cwd, projectlessOutputDirectory, includeResources],
  );
  const paths = useMemo(
    () => candidates.flatMap((resource) => (resource.kind === "file" ? [resource.path] : [])),
    [candidates],
  );
  const query = useQuery({
    queryKey: ["workspace-paths-exist", hostId, paths],
    queryFn: () => readWorkspacePathsExist({ hostId, paths }),
    enabled: paths.length > 0,
    staleTime: 5_000,
  });
  const resources = useMemo(
    () =>
      filterTurnEndResources(
        candidates,
        query.data ? new Set(query.data.existingPaths) : query.isError ? undefined : new Set(),
        cwd,
      ),
    [candidates, query.data, query.isError, cwd],
  );
  const endResourcePaths = useMemo(() => getTurnEndResourcePaths(resources), [resources]);
  return { resources, endResourcePaths };
}
