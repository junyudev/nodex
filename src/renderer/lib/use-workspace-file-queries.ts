import { useQuery } from "@tanstack/react-query";
import {
  workspaceDirectoryQueryOptions,
  workspaceFileBinaryQueryOptions,
  workspaceFileMetadataQueryOptions,
  workspaceFileTextQueryOptions,
} from "./query-options";
import type {
  WorkspaceDirectoryEntriesInput,
  WorkspaceFileMetadataInput,
  WorkspaceFileRequest,
  WorkspaceFileTextReadInput,
} from "./types";

interface QueryEnabledOptions {
  enabled?: boolean;
}

export function useWorkspaceDirectoryEntries(
  input: WorkspaceDirectoryEntriesInput,
  options: QueryEnabledOptions = {},
) {
  const enabled = options.enabled !== false && input.workspaceRoot.trim().length > 0;
  return useQuery({
    ...workspaceDirectoryQueryOptions(input),
    enabled,
  });
}

export function useWorkspaceFileMetadata(
  input: WorkspaceFileMetadataInput,
  options: QueryEnabledOptions = {},
) {
  const enabled = options.enabled !== false && input.path.trim().length > 0;
  return useQuery({
    ...workspaceFileMetadataQueryOptions(input),
    enabled,
  });
}

export function useWorkspaceFileText(
  input: WorkspaceFileTextReadInput,
  options: QueryEnabledOptions = {},
) {
  const enabled = options.enabled !== false && input.path.trim().length > 0;
  return useQuery({
    ...workspaceFileTextQueryOptions(input),
    enabled,
  });
}

export function useWorkspaceFileBinary(
  input: WorkspaceFileRequest,
  options: QueryEnabledOptions = {},
) {
  const enabled = options.enabled !== false && input.path.trim().length > 0;
  return useQuery({
    ...workspaceFileBinaryQueryOptions(input),
    enabled,
  });
}
