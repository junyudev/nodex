import { normalizeMcpToolCall } from "@nodex/provider-core/server/mcpToolCall";

export function claudeMcpToolIdentity(toolName: string) {
  const match = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/u.exec(toolName);
  const server = match?.[1];
  const tool = match?.[2];
  if (!server || !tool || server === "nodex_app") return undefined;
  return { server, tool };
}

export function claudeMcpToolCall({
  toolName,
  ...input
}: Omit<Parameters<typeof normalizeMcpToolCall>[0], "server" | "tool"> & {
  readonly toolName: string;
}) {
  const identity = claudeMcpToolIdentity(toolName);
  return identity && normalizeMcpToolCall({ ...input, ...identity, omitImageSourceNotes: true });
}
