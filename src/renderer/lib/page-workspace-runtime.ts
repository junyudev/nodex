import { useQuery, queryOptions } from "@tanstack/react-query";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

export const pageWorkspaceQuery = (pageId: string) =>
  queryOptions({
    queryKey: ["pageWorkspace", pageId],
    queryFn: () => invokeRendererQuery("work:workspace", pageId),
    enabled: pageId.length > 0,
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
export const usePageWorkspace = (pageId: string) => useQuery(pageWorkspaceQuery(pageId));
const refreshCommand = defineRendererCommand({
  key: "work.refreshWorkspace",
  channel: "work:refresh-workspace",
  authority: "main",
  owner: "Page Workspace",
  protocol: { kind: "returned_value" },
});
/** Requests a fresh forge observation without clearing a previously known PR. */
export const refreshPageWorkspace = (pageId: string) => invokePlainCommand(refreshCommand, pageId);
