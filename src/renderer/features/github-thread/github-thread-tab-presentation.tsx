import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { gitHubThreadQueryOptions } from "@/lib/github-threads";
import type { GitHubThreadKind, GitHubThreadRef } from "../../../shared/github-thread";
import { gitHubThreadLabel } from "../../../shared/github-thread";
import {
  GitHubThreadStateIcon,
  gitHubThreadStateOf,
  unknownGitHubThreadState,
} from "./github-thread-state";

export interface GitHubThreadTabPresentation {
  /** The thread's title once known, otherwise `owner/repo#N`. */
  readonly title: string;
  /** `owner/repo#N`, for tooltips and the tab location. */
  readonly location: string;
  readonly icon: ReactElement;
}

/**
 * How a GitHub tab presents itself in tab strips, the Tabs chooser and the tab location.
 * Reads the thread's cached detail without starting a read of its own: the tab's body owns
 * reading, so a background tab never spends GitHub requests.
 */
export function useGitHubThreadTabPresentation(input: {
  readonly thread: GitHubThreadRef;
  readonly kindHint: GitHubThreadKind;
  readonly titleSnapshot: string | null;
}): GitHubThreadTabPresentation {
  const { data } = useQuery({ ...gitHubThreadQueryOptions(input.thread), enabled: false });
  const detail = data?.status === "ready" ? data.detail : null;
  const location = gitHubThreadLabel(detail?.ref ?? input.thread);
  return {
    title: detail?.title || input.titleSnapshot || location,
    location,
    icon: (
      <GitHubThreadStateIcon
        state={detail ? gitHubThreadStateOf(detail) : unknownGitHubThreadState(input.kindHint)}
      />
    ),
  };
}
