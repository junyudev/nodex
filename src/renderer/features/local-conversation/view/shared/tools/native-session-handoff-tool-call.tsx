import { useIntl } from "@/lib/i18n";
import { useThreadHandoffOperation } from "../../../../../lib/thread-handoff-runtime";
import { resolveNativeSessionHandoffScope } from "../../../projection/tool-metadata/native-session-handoff";
import { HandoffActivity } from "./dynamic-tool-call";
import type { ToolComponentProps } from "./get-tool-component";
import { McpToolCall } from "./mcp-tool-call";

export function NativeSessionHandoffToolCall(props: ToolComponentProps) {
  const intl = useIntl();
  const operation = useThreadHandoffOperation(
    resolveNativeSessionHandoffScope(props.item.mcpToolCall, props.item.threadId),
  );
  if (!operation) return <McpToolCall {...props} />;
  const active = operation.status === "running";
  const failed = operation.status === "error";
  const target =
    operation.threadTitle ??
    intl.formatMessage({
      id: "conversation.nativeSessionHandoffToolCall.session",
      defaultMessage: "session",
    });
  const destination = operation.destinationHostDisplayName;
  const label = intl.formatMessage(
    {
      id: "conversation.nativeSessionHandoffToolCall.handoff",
      defaultMessage:
        "{status, select, active {Handing off} failed {Failed to hand off} other {Handed off}} {target}{hasDestination, select, yes { to {destination}} other {}}",
    },
    {
      target,
      destination: destination ?? "",
      hasDestination: destination ? "yes" : "no",
      status: active ? "active" : failed ? "failed" : "completed",
    },
  );
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
