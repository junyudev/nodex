import type { GitHubThreadCommand } from "../../../shared/github-thread";

/** How the tab's controls change the thread: one command at a time, with its progress. */
export interface GitHubThreadCommandRunner {
  readonly pending: boolean;
  readonly command: (command: GitHubThreadCommand) => void;
}
