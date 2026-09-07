import { useThreadHandoffOperation } from "../../../../../lib/thread-handoff-runtime";
import { resolveNativeSessionHandoffScope } from "../../../projection/tool-metadata/native-session-handoff";
import { HandoffActivity } from "./dynamic-tool-call";
import type { ToolComponentProps } from "./get-tool-component";
import { McpToolCall } from "./mcp-tool-call";

export function NativeSessionHandoffToolCall(props: ToolComponentProps) {
  const operation = useThreadHandoffOperation(
    resolveNativeSessionHandoffScope(props.item.mcpToolCall, props.item.threadId),
  );
  if (!operation) return <McpToolCall {...props} />;
  const active = operation.status === "running";
  const failed = operation.status === "error";
  const target = operation.threadTitle ?? "session";
  const destination = operation.destinationHostDisplayName;
  const label = `${active ? "Handing off" : failed ? "Failed to hand off" : "Handed off"} ${target}${destination ? ` to ${destination}` : ""}`;
  return (
    <HandoffActivity
      operation={operation}
      state={{
        active,
        label,
        activityStatus: active ? "running" : failed ? "failed" : "completed",
      }}
    />
  );
}
