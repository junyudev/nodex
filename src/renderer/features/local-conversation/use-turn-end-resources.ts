import { useMemo } from "react";
import { useQueries, type QueryClient } from "@tanstack/react-query";
import type { WorkspacePathState } from "../../../shared/types";
import type { CodexConversationTurn } from "../../lib/types";
import { readWorkspacePathStates } from "../../lib/workspace-file-operations";
import {
  collectThreadOutputCandidates,
  collectTurnOutputCandidates,
  projectTurnEndOutputCandidates,
  selectThreadSummaryOutputRows,
  filterTurnOutputCandidates,
  getTurnEndResourcePaths,
  type TurnOutputCandidate,
} from "./projection/thread-summary-panel-output-model";

type PendingPath = {
  path: string;
  resolve: (state: WorkspacePathState) => void;
  reject: (cause: unknown) => void;
};
const pendingByClient = new WeakMap<QueryClient, Map<string, PendingPath[]>>();

/** Query identity is per path; concurrent observers still use one host batch. */
function readBatchedPathState(
  client: QueryClient,
  hostId: string,
  cwd: string | null,
  path: string,
): Promise<WorkspacePathState> {
  let scopes = pendingByClient.get(client);
  if (!scopes) {
    scopes = new Map();
    pendingByClient.set(client, scopes);
  }
  const scope = JSON.stringify([hostId, cwd]);
  const existing = scopes.get(scope);
  return new Promise((resolve, reject) => {
    const pending = { path, resolve, reject };
    if (existing) {
      existing.push(pending);
      return;
    }
    const batch = [pending];
    scopes.set(scope, batch);
    queueMicrotask(() => {
      scopes.delete(scope);
      void readWorkspacePathStates({ hostId, cwd, paths: batch.map((entry) => entry.path) })
        .then(({ states }) => {
          const byPath = new Map(states.map((state) => [state.path, state]));
          for (const entry of batch) {
            const state = byPath.get(entry.path);
            if (state) entry.resolve(state);
            else entry.reject(new Error("Path state was not returned"));
          }
        })
        .catch((cause: unknown) => batch.forEach((entry) => entry.reject(cause)));
    });
  });
}

function useOutputResources(input: {
  readonly candidates: readonly TurnOutputCandidate[];
  readonly hostId: string;
  readonly cwd?: string | null;
}) {
  const { candidates, hostId, cwd = null } = input;
  const paths = [
    ...new Set(candidates.flatMap(({ resource }) => ("path" in resource ? [resource.path] : []))),
  ];
  return useQueries({
    queries: paths.map((path) => ({
      queryKey: ["workspace-path-states", hostId, cwd, path],
      queryFn: ({ client }) => readBatchedPathState(client, hostId, cwd, path),
      // Existence and Git visibility rarely change; remounting history rows should not respawn Git.
      staleTime: 30_000,
    })),
    combine: (queries) => {
      const states = new Map<string, WorkspacePathState | null>();
      queries.forEach((query, index) => {
        const path = paths[index]!;
        if (query.data) states.set(path, query.data);
        else if (query.isError) states.set(path, null);
      });
      return filterTurnOutputCandidates(candidates, states, cwd);
    },
  });
}

/** One confirmed output result owns cards and duplicate-output suppression. */
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
        ? projectTurnEndOutputCandidates(
            collectTurnOutputCandidates(turn, { cwd, projectlessOutputDirectory }),
          )
        : [],
    [turn, cwd, projectlessOutputDirectory, includeResources],
  );
  const resources = useOutputResources({ candidates, hostId, cwd });
  const endResourcePaths = useMemo(() => getTurnEndResourcePaths(resources), [resources]);
  return { resources, endResourcePaths };
}

export function useThreadSummaryOutputRows(input: {
  readonly turns: readonly CodexConversationTurn[];
  readonly hostId: string;
  readonly cwd?: string | null;
  readonly projectlessOutputDirectory?: string | null;
}) {
  const { turns, hostId, cwd, projectlessOutputDirectory } = input;
  const candidates = useMemo(
    () => collectThreadOutputCandidates(turns, { cwd, projectlessOutputDirectory }),
    [turns, cwd, projectlessOutputDirectory],
  );
  const resources = useOutputResources({ candidates, hostId, cwd });
  return useMemo(() => selectThreadSummaryOutputRows(resources), [resources]);
}
