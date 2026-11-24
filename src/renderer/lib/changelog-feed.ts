import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ChangelogFeed } from "../../shared/changelog-feed";
import { invokeRendererQuery } from "./renderer-command";
import { spaceQueryKey } from "./renderer-space";

export function readChangelogFeed(): Promise<ChangelogFeed> {
  return invokeRendererQuery("app:changelog:read");
}

export function useChangelogFeed(): UseQueryResult<ChangelogFeed> {
  return useQuery({
    queryKey: spaceQueryKey(["changelogFeed"]),
    queryFn: readChangelogFeed,
    networkMode: "always",
    staleTime: 5 * 60_000,
    retry: 2,
    refetchOnWindowFocus: false,
  });
}
