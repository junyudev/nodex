import type { GitHubThreadCommand, GitHubThreadDetail } from "../../../shared/github-thread";

export interface GitHubThreadCommandOptions {
  /** How the thread reads once the change applies, shown until GitHub answers. */
  readonly optimistic?: (detail: GitHubThreadDetail) => GitHubThreadDetail;
  /** The caller shows a refusal in place, so no toast repeats it. */
  readonly quiet?: boolean;
}

/** How the tab's controls change the thread. */
export interface GitHubThreadCommandRunner {
  /** Some change has not been answered yet. */
  readonly pending: boolean;
  /**
   * Sends one change. Resolves `true` once GitHub applied it; otherwise reports why and resolves
   * `false`, so a draft can stay where it was written.
   */
  readonly run: (
    command: GitHubThreadCommand,
    options?: GitHubThreadCommandOptions,
  ) => Promise<boolean>;
}
