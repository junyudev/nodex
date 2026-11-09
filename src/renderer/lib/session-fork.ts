import type { NativeContextMenuIconKey } from "../../shared/native-context-menu";
import type { ProjectSessionForkTarget } from "../../shared/types";

export interface SessionForkDestination {
  readonly target: ProjectSessionForkTarget;
  readonly label: string;
  readonly iconKey: Extract<NativeContextMenuIconKey, "fork" | "local" | "worktree">;
}

/**
 * Fork labels and icons describe the source's actual execution location: a fork beside a local
 * chat shows the laptop, a fork in the same worktree the branch, a fork into a new worktree the
 * worktree.
 */
export function sessionForkDestinations(input: {
  readonly isWorktree: boolean;
  readonly canCreateWorktree: boolean;
}): readonly SessionForkDestination[] {
  return [
    input.isWorktree
      ? { target: "local", label: "Fork chat in same worktree", iconKey: "fork" }
      : { target: "local", label: "Fork chat", iconKey: "local" },
    ...(input.canCreateWorktree
      ? [
          {
            target: "newWorktree" as const,
            label: "Fork chat in new worktree",
            iconKey: "worktree" as const,
          },
        ]
      : []),
  ];
}
