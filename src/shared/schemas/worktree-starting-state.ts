import { z } from "zod";

/**
 * Where a new managed worktree starts. This is the one definition every boundary shares: the
 * `create_session` tool, the launch API and the worktree worker protocol, so a starting state
 * accepted from an Agent or a window is always one the worker accepts too.
 */
const WorkingTreeStartingStateSchema = z.strictObject({ type: z.literal("working-tree") });

/** Git names never begin or end with whitespace; a published pattern keeps tool schemas honest. */
const gitName = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .regex(/^\S(?:[\s\S]*\S)?$/, "Must not begin or end with whitespace");

const BranchStartingStateSchema = z.strictObject({
  type: z.literal("branch"),
  branchName: gitName(1_024),
  /** Exact remote-tracking ref chosen in the branch picker; Agents name branches only. */
  remoteRef: gitName(2_048).optional(),
  /** `create-branch` creates a missing branch from the default branch; otherwise it is an error. */
  onMissing: z.enum(["error", "create-branch"]).optional(),
});

export const WorktreeStartingStateSchema = z.discriminatedUnion("type", [
  WorkingTreeStartingStateSchema,
  BranchStartingStateSchema,
]);

/** The subset an Agent may request through `create_session`. */
export const AgentWorktreeStartingStateSchema = z.discriminatedUnion("type", [
  WorkingTreeStartingStateSchema,
  BranchStartingStateSchema.omit({ remoteRef: true }),
]);

export type WorktreeStartingState = Readonly<z.output<typeof WorktreeStartingStateSchema>>;
