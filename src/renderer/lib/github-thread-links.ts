import { queryOptions } from "@tanstack/react-query";
import { gitHubThreadKey, type GitHubThreadRef } from "../../shared/github-thread";
import { invokeRendererQuery } from "./renderer-command";
import { spaceQueryKey } from "./renderer-space";

export const gitHubThreadLinksQueryOptions = (ref: GitHubThreadRef) =>
  queryOptions({
    queryKey: spaceQueryKey(["github", "thread-links", gitHubThreadKey(ref)]),
    queryFn: () => invokeRendererQuery("github:thread-links", ref),
    staleTime: 5_000,
  });
