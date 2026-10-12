import { queryOptions } from "@tanstack/react-query";
import type { CodexVisualizationReadInput } from "../../shared/types";
import { invokeRendererQuery } from "./renderer-command";
import type { InlineVisualizationVariant } from "./inline-visualization/inline-visualization-presentation";

export function codexVisualizationQueryOptions(
  input: CodexVisualizationReadInput,
  cacheKey: string,
  variant: InlineVisualizationVariant = "inline",
) {
  return queryOptions({
    queryKey: ["codex-visualization", input, cacheKey],
    queryFn: () => invokeRendererQuery("codex:visualization:read", input),
    retry: false,
    staleTime: Infinity,
    gcTime: variant === "live" ? 0 : 15_000,
  });
}
