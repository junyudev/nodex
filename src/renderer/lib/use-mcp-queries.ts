import { useQuery } from "@tanstack/react-query";
import {
  codexExperimentalFeaturesListQueryOptions,
  mcpAppsQueryOptions,
  mcpResourceQueryOptions,
  mcpServerStatusesQueryOptions,
} from "./query-options";
import type { ProtocolMcpResourceReadParams } from "../../shared/types";
import { isHostedChat } from "./hosted-chat";

interface QueryEnabledOptions {
  enabled?: boolean;
}

export function useCodexExperimentalFeatures(options: QueryEnabledOptions = {}) {
  return useQuery({
    ...codexExperimentalFeaturesListQueryOptions(),
    enabled: options.enabled !== false,
  });
}

export function useMcpApps(options: QueryEnabledOptions = {}) {
  return useQuery({
    ...mcpAppsQueryOptions(),
    enabled: options.enabled !== false && !isHostedChat(),
  });
}

const EMPTY_RESOURCE_PARAMS: ProtocolMcpResourceReadParams = {
  threadId: null,
  server: "",
  uri: "",
};

export function useMcpServerStatuses(options: QueryEnabledOptions = {}) {
  return useQuery({
    ...mcpServerStatusesQueryOptions(),
    enabled: options.enabled !== false && !isHostedChat(),
  });
}

export function useMcpResource(
  params: ProtocolMcpResourceReadParams | null,
  options: QueryEnabledOptions = {},
) {
  const effectiveParams = params ?? EMPTY_RESOURCE_PARAMS;
  const enabled = Boolean(
    options.enabled !== false && params && params.server.trim() && params.uri.trim(),
  );

  return useQuery({
    ...mcpResourceQueryOptions(effectiveParams),
    enabled,
  });
}
