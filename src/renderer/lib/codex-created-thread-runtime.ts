import { queryOptions } from "@tanstack/react-query";
import type { CodexCreatedThreadResult } from "../../shared/codex-created-thread-result";
import type {
  CodexChildThreadSummaryInput,
  CodexCreatedThreadResolveInput,
} from "../../shared/codex-child-thread-summary";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const openCreatedThreadCommand = defineRendererCommand({
  key: "created_thread.ensure_open",
  channel: "codex:thread:ensure-open",
  authority: "main",
  owner: "WorkbenchSessionCatalog",
  protocol: { kind: "returned_value" },
});

export function createdThreadResolveInput(
  result: CodexCreatedThreadResult,
): CodexCreatedThreadResolveInput | null {
  if (result.kind === "chatgpt") return null;
  return {
    ...("threadId" in result
      ? { threadId: result.threadId }
      : { clientThreadId: result.clientThreadId }),
    ...(result.hostId === undefined ? {} : { expectedHostId: result.hostId }),
  };
}

export function createdThreadResolutionQueryOptions(input: CodexCreatedThreadResolveInput | null) {
  return queryOptions({
    queryKey: ["codex", "created-thread-resolution", input] as const,
    staleTime: 30_000,
    retry: 1,
    enabled: input !== null,
    queryFn: async ({ signal }) => {
      if (!input) return null;
      signal.throwIfAborted();
      const result = await invokeRendererQuery("codex:created-thread:resolve", input);
      signal.throwIfAborted();
      return result;
    },
  });
}

export function childThreadSummaryQueryOptions(input: CodexChildThreadSummaryInput | null) {
  return queryOptions({
    queryKey: ["codex", "child-thread-summary", input] as const,
    staleTime: 30_000,
    retry: 1,
    enabled: input !== null,
    queryFn: async ({ signal }) => {
      if (!input) return null;
      signal.throwIfAborted();
      const result = await invokeRendererQuery("codex:thread:child-summary", input);
      signal.throwIfAborted();
      return result;
    },
  });
}

export function ensureCreatedThreadSession(input: CodexChildThreadSummaryInput) {
  return invokePlainCommand(openCreatedThreadCommand, input);
}

export function resolveCreatedThreadTarget(input: CodexCreatedThreadResolveInput) {
  return invokeRendererQuery("codex:created-thread:resolve", input);
}
