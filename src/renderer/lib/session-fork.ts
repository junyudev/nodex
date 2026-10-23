import type { ProjectSessionForkTarget } from "../../shared/types";

export interface SessionForkDestination {
  readonly target: ProjectSessionForkTarget;
  readonly label: string;
}

/** Fork labels describe the source's actual execution location. */
export function sessionForkDestinations(input: {
  readonly isWorktree: boolean;
  readonly canCreateWorktree: boolean;
}): readonly SessionForkDestination[] {
  return [
    {
      target: "local",
      label: input.isWorktree ? "Fork chat in same worktree" : "Fork chat",
    },
    ...(input.canCreateWorktree
      ? [{ target: "newWorktree" as const, label: "Fork chat in new worktree" }]
      : []),
  ];
}
