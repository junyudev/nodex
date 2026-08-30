import {
  requireMcpAppScopedResource,
  requireMcpAppScopedTool,
  type McpAppScopeSnapshot,
} from "../../../shared/mcp-app/mcp-app-scope";
import { JsonValueSchema } from "../../../shared/nodex-agent-tools/base-schemas";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererQuery,
} from "../renderer-command";
import { parseMcpAppFollowUpMessage, type McpAppFollowUpMessage } from "./mcp-app-follow-up";
import type { McpAppHostApiHandlers } from "./mcp-app-port-rpc";

const callMcpToolCommand = defineRendererCommand({
  key: "mcp_app.call_tool",
  channel: "codex:mcp-tool:call",
  authority: "external",
  owner: "McpAppHostDispatcher",
  protocol: { kind: "returned_value" },
});

const openMcpExternalUrlCommand = defineRendererCommand({
  key: "mcp_app.open_external",
  channel: "mcp-app:open-external",
  authority: "external",
  owner: "McpAppHostDispatcher",
  protocol: { kind: "pending_operation" },
});

export class McpAppRpcError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = "McpAppRpcError";
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseToolCall(value: unknown): {
  arguments?: Record<string, unknown>;
  name: string;
} {
  const record = asRecord(value);
  if (!record || typeof record.name !== "string" || !record.name.trim()) {
    throw new McpAppRpcError("Invalid MCP tool call params", -32_602);
  }
  const args = record.arguments;
  if (args !== undefined && !asRecord(args)) {
    throw new McpAppRpcError("Invalid MCP tool call arguments", -32_602);
  }
  return {
    name: record.name,
    ...(args === undefined ? {} : { arguments: args as Record<string, unknown> }),
  };
}

export interface McpAppHostDispatcherOptions {
  getScope?(): McpAppScopeSnapshot | Promise<McpAppScopeSnapshot>;
  onBackgroundColor?(value: unknown): void;
  onDisplayMode?(value: unknown): unknown | Promise<unknown>;
  onEnvironmentError?(value: unknown): void;
  onIntrinsicHeight?(value: unknown): void;
  onNavigation?(value: unknown): void;
  onSecurityPolicyViolation?(value: unknown): void;
  onWidgetState?(value: unknown): void;
  scope: McpAppScopeSnapshot;
  sendFollowUpMessage?(value: McpAppFollowUpMessage): unknown | Promise<unknown>;
}

export class McpAppHostDispatcher {
  readonly #options: McpAppHostDispatcherOptions;

  constructor(options: McpAppHostDispatcherOptions) {
    this.#options = options;
  }

  handlers(): McpAppHostApiHandlers {
    return {
      callMcp: (request) => this.#callMcp(request),
      callTool: (name, args) => this.#callTool({ name, arguments: args }),
      notifyBackgroundColor: (value) => this.#options.onBackgroundColor?.(value),
      notifyEnvironmentError: (value) => this.#options.onEnvironmentError?.(value),
      notifyIntrinsicHeight: (value) => this.#options.onIntrinsicHeight?.(value),
      notifyIntrinsicWidth: () => undefined,
      notifyNavigation: (value) => this.#options.onNavigation?.(value),
      notifySecurityPolicyViolation: (value) => this.#options.onSecurityPolicyViolation?.(value),
      openExternal: (value) => this.#openExternal(value),
      requestDisplayMode: (value) => this.#options.onDisplayMode?.(value) ?? { mode: "inline" },
      sendFollowUpMessage: (value) => {
        const message = parseMcpAppFollowUpMessage(value);
        if (!message) {
          throw new McpAppRpcError("Invalid MCP App follow-up message", -32_602);
        }
        if (!this.#options.sendFollowUpMessage) {
          throw new McpAppRpcError("MCP App follow-up messages are unsupported", -32_601);
        }
        return this.#options.sendFollowUpMessage(message);
      },
      sendInstrument: () => undefined,
      updateWidgetState: (value) => this.#options.onWidgetState?.(value),
    };
  }

  async #callTool(value: unknown): Promise<unknown> {
    const toolCall = parseToolCall(value);
    const scope = await this.#getScope();
    const tool = requireMcpAppScopedTool(scope, toolCall.name, toolCall.arguments);
    const args = toolCall.arguments ? JsonValueSchema.parse(toolCall.arguments) : undefined;
    return invokePlainCommand(callMcpToolCommand, {
      threadId: scope.threadId,
      server: scope.server,
      tool: tool.name,
      ...(args ? { arguments: args } : {}),
    });
  }

  async #callMcp(value: unknown): Promise<unknown> {
    const request = asRecord(value);
    if (!request || typeof request.method !== "string") {
      throw new McpAppRpcError("Invalid MCP proxy request", -32_602);
    }
    const params = request.params;
    switch (request.method) {
      case "ping":
        return {};
      case "tools/call":
        return this.#callTool(params);
      case "tools/list": {
        const scope = await this.#getScope();
        return { tools: [...scope.allowedTools.values()] };
      }
      case "resources/list": {
        const scope = await this.#getScope();
        return { resources: scope.resources };
      }
      case "resources/templates/list": {
        const scope = await this.#getScope();
        return { resourceTemplates: scope.resourceTemplates };
      }
      case "prompts/list":
        return { prompts: [] };
      case "resources/read": {
        const resourceParams = asRecord(params);
        if (!resourceParams || typeof resourceParams.uri !== "string") {
          throw new McpAppRpcError("Invalid MCP resource read params", -32_602);
        }
        const scope = await this.#getScope();
        requireMcpAppScopedResource(scope, resourceParams.uri);
        return invokeRendererQuery("codex:mcp-resource:read", {
          threadId: scope.threadId,
          server: scope.server,
          uri: resourceParams.uri,
        });
      }
      case "resources/subscribe":
      case "resources/unsubscribe":
        throw new McpAppRpcError("MCP resource subscriptions are unsupported", -32_601);
      default:
        throw new McpAppRpcError(`Unsupported MCP proxy method: ${request.method}`, -32_601);
    }
  }

  async #openExternal(value: unknown): Promise<void> {
    const record = asRecord(value);
    if (!record || typeof record.href !== "string") {
      throw new McpAppRpcError("Invalid external navigation request", -32_602);
    }
    await invokePlainCommand(openMcpExternalUrlCommand, record.href);
  }

  #getScope(): McpAppScopeSnapshot | Promise<McpAppScopeSnapshot> {
    return this.#options.getScope?.() ?? this.#options.scope;
  }
}
