import type { Thread, TurnEnvironmentParams } from "@nodex/codex-app-server-protocol/v2";

export interface CodexEnvironmentSelectionEvidence {
  readonly source: "live" | "stored";
  /** App-server Thread timestamps are protocol seconds. */
  readonly updatedAt: number;
}

export interface CodexEnvironmentSelectionState {
  readonly environments?: readonly TurnEnvironmentParams[] | null;
  readonly environmentSelectionEvidence?: CodexEnvironmentSelectionEvidence;
}

const cloneEnvironments = (
  environments: readonly TurnEnvironmentParams[],
): readonly TurnEnvironmentParams[] =>
  environments.map((environment) => ({
    ...environment,
    ...(environment.runtimeWorkspaceRoots === undefined
      ? {}
      : {
          runtimeWorkspaceRoots:
            environment.runtimeWorkspaceRoots === null
              ? null
              : [...environment.runtimeWorkspaceRoots],
        }),
  }));

/** Reads the app-server's loaded-thread environment selection into Nodex's turn model. */
export function readCodexThreadEnvironments(
  thread: Thread,
): readonly TurnEnvironmentParams[] | null {
  const environments = thread.environments;
  if (environments == null) return environments;
  return cloneEnvironments(environments);
}

/** Exact stored/live metadata merge: stored observations never beat a newer live selection. */
export function mergeCodexThreadEnvironmentSelection(
  thread: Thread,
  current: CodexEnvironmentSelectionState | null | undefined,
  source: CodexEnvironmentSelectionEvidence["source"],
): CodexEnvironmentSelectionState {
  const environments = readCodexThreadEnvironments(thread);
  if (
    environments == null ||
    (source === "stored" &&
      (current?.environmentSelectionEvidence?.source === "live" ||
        (current?.environmentSelectionEvidence?.updatedAt ?? Number.NEGATIVE_INFINITY) >=
          thread.updatedAt))
  ) {
    return {
      environments: current?.environments,
      environmentSelectionEvidence: current?.environmentSelectionEvidence,
    };
  }
  return {
    environments,
    environmentSelectionEvidence: { source, updatedAt: thread.updatedAt },
  };
}

export function isSameCodexEnvironmentSelectionEvidence(
  left: CodexEnvironmentSelectionEvidence | undefined,
  right: CodexEnvironmentSelectionEvidence | undefined,
): boolean {
  if (left === right) return true;
  return left?.source === right?.source && left?.updatedAt === right?.updatedAt;
}

/** A native response may commit its prepared environments unless a newer live selection won. */
export function canAcceptCodexPreparedEnvironmentSelection(
  current: CodexEnvironmentSelectionEvidence | undefined,
  capturedAtDispatch: CodexEnvironmentSelectionEvidence | undefined,
): boolean {
  return (
    current?.source !== "live" ||
    isSameCodexEnvironmentSelectionEvidence(current, capturedAtDispatch)
  );
}

/**
 * Accept the prepared sticky environment only if a newer live selection did not win while the
 * native request was in flight. `acceptedAtSeconds` mirrors the app-server metadata clock.
 */
export function acceptCodexPreparedEnvironmentSelection(
  current: CodexEnvironmentSelectionState | null | undefined,
  prepared: readonly TurnEnvironmentParams[] | null | undefined,
  capturedAtDispatch: CodexEnvironmentSelectionEvidence | undefined,
  acceptedAtSeconds: number,
): CodexEnvironmentSelectionState {
  if (
    prepared == null ||
    !canAcceptCodexPreparedEnvironmentSelection(
      current?.environmentSelectionEvidence,
      capturedAtDispatch,
    )
  ) {
    return {
      environments: current?.environments,
      environmentSelectionEvidence: current?.environmentSelectionEvidence,
    };
  }
  return {
    environments: cloneEnvironments(prepared),
    environmentSelectionEvidence: { source: "live", updatedAt: acceptedAtSeconds },
  };
}

export function resolveCodexAcceptedThreadEnvironmentSelection(
  thread: Thread,
  current: CodexEnvironmentSelectionState | null | undefined,
  capturedAtDispatch: CodexEnvironmentSelectionEvidence | undefined,
): CodexEnvironmentSelectionState {
  if (
    !canAcceptCodexPreparedEnvironmentSelection(
      current?.environmentSelectionEvidence,
      capturedAtDispatch,
    )
  )
    return {
      environments: current?.environments,
      environmentSelectionEvidence: current?.environmentSelectionEvidence,
    };
  return mergeCodexThreadEnvironmentSelection(thread, current, "live");
}
