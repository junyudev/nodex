import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentHostTool } from "@nodex/agent-runtime/contracts";
import type { AppToolCaller } from "../main/app-tools/AppToolCaller";
import type { AppToolInvocation } from "../main/app-tools/AppToolInvocationInbox";
import { appToolCatalog, appToolGroups } from "../shared/nodex-app-tools/catalog";

export const hostToolGroupByName = new Map(
  Object.entries(appToolGroups).flatMap(([group, tools]) =>
    tools.map((tool) => [tool.name, group as keyof typeof appToolGroups] as const),
  ),
);
export type HostToolGroupExecutor = (input: AppToolInvocation) => Effect.Effect<CallToolResult>;

export const runtimeHostToolCatalog: ReadonlyArray<AgentHostTool> = appToolCatalog.map((tool) => ({
  name: tool.name,
  ...(tool.description
    ? {
        description:
          tool.name === "create_session"
            ? "Create and start a Session using the calling Session's provider and model unless model is supplied. Choose the Project and local or worktree environment explicitly. Reuse operationId with identical arguments for retries."
            : tool.name === "fork_session"
              ? "Fork captured conversation history into an independent Session in the source Project. Omit sessionId to fork the exact calling Thread, including an app-owned child. Choose same-directory or worktree explicitly; reuse operationId for retries."
              : tool.description,
      }
    : {}),
  inputSchema: tool.inputSchema,
  ...(tool.annotations ? { annotations: { ...tool.annotations } } : {}),
}));
export const HostAppToolCatalog = Context.Reference<ReadonlyArray<AgentHostTool>>(
  "nodex/host/HostAppToolCatalog",
  { defaultValue: () => runtimeHostToolCatalog },
);
export type AgentRuntimeHostToolExecutor = (
  caller: AppToolCaller,
  name: string,
  input: Record<string, unknown>,
) => Effect.Effect<CallToolResult>;

/** Product tools with optional platform capabilities supplied by the embedding shell. */
export class HostToolExecutor extends Context.Service<
  HostToolExecutor,
  {
    readonly execute: AgentRuntimeHostToolExecutor;
  }
>()("nodex/host/HostToolExecutor") {}
