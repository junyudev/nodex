import { queryOptions } from "@tanstack/react-query";
import type { CodexVisualizationReadInput } from "../../shared/types";
import { invokeRendererQuery } from "./renderer-command";

export function codexVisualizationQueryOptions(
  input: CodexVisualizationReadInput,
  cacheKey: string,
  live: boolean,
) {
  return queryOptions({
    queryKey: ["codex-visualization", input, cacheKey],
    queryFn: () => invokeRendererQuery("codex:visualization:read", input),
    retry: false,
    staleTime: Infinity,
    gcTime: live ? 0 : 15_000,
  });
}
