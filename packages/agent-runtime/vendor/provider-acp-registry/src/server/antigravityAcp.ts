import type { AcpAdapterV2Flavor } from "@nodex/provider-acp/server/adapter";
import { NODEX_APP_MCP_SERVER } from "@nodex/runtime-shared/nodexAppMcp";

const COMMAND_PREAMBLE =
  /^Created At:[^\r\n]+\r?\nCompleted At:[^\r\n]+\r?\nCommand exited with code -?\d+\.[ \t]*\r?\n(?:[ \t]*\r?\n)*Command output:[ \t]*(?:\r?\n|$)/u;
const MCP_TOOL_NAME = new RegExp(
  `^mcp_(${NODEX_APP_MCP_SERVER}|node_repl)_([A-Za-z0-9_.-]+)$`,
  "u",
);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Translate Antigravity's tool fields before ACP builds or merges its tool-call state. */
export const normalizeAntigravitySessionUpdate: NonNullable<
  AcpAdapterV2Flavor["normalizeSessionUpdate"]
> = (notification) => {
  const { update } = notification;
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return notification;
  }
  const rawInput = record(update.rawInput);
  if (update.name === "run_command" && update.kind === "execute") {
    const rawOutput = record(update.rawOutput);
    const content = update.content?.map((entry) => {
      if (entry.type !== "content" || entry.content.type !== "text") return entry;
      return {
        ...entry,
        content: { ...entry.content, text: entry.content.text.replace(COMMAND_PREAMBLE, "") },
      };
    });
    return {
      ...notification,
      update: {
        ...update,
        ...(typeof rawInput?.CommandLine === "string"
          ? { rawInput: { ...rawInput, command: rawInput.CommandLine } }
          : {}),
        ...(typeof rawOutput?.output === "string"
          ? { rawOutput: { ...rawOutput, output: rawOutput.output.replace(COMMAND_PREAMBLE, "") } }
          : {}),
        ...(content === undefined ? {} : { content }),
      },
    };
  }

  // Server names contain underscores. Match the configured namespaces before
  // taking the tool suffix, then use ACP's existing explicit MCP identity path.
  const match = update.name?.match(MCP_TOOL_NAME);
  if (!match) return notification;
  const [, server, tool] = match;
  if (rawInput === undefined && update.sessionUpdate === "tool_call_update") return notification;
  const { toolSummary: _toolSummary, ...args } = rawInput ?? {};
  return {
    ...notification,
    update: {
      ...update,
      rawInput: { server, tool, arguments: args },
      _meta: { ...update._meta, is_mcp_tool_call: true },
    },
  };
};
