import { useIntl } from "@/lib/i18n";
import type { ToolComponentProps } from "./get-tool-component";
import { JsonBlock, ThreadActivityDisclosure } from "./tool-primitives";

/** Tools without a specialized visualization retain their name, state and inspectable output. */
export function GenericToolCall({ item }: ToolComponentProps) {
  const intl = useIntl();
  const tool = item.toolCall;
  if (!tool) return null;
  return (
    <ThreadActivityDisclosure
      summary={tool.toolName}
      status={
        item.status === "inProgress" ? "running" : item.status === "failed" ? "failed" : "completed"
      }
      canExpand={tool.args !== undefined || tool.result !== undefined || tool.error !== undefined}
    >
      {tool.args !== undefined ? (
        <JsonBlock
          title={intl.formatMessage({
            id: "conversation.genericToolCall.input",
            defaultMessage: "Input",
          })}
          value={tool.args}
        />
      ) : null}
      {tool.result !== undefined ? (
        <JsonBlock
          title={intl.formatMessage({
            id: "conversation.genericToolCall.output",
            defaultMessage: "Output",
          })}
          value={tool.result}
        />
      ) : null}
      {tool.error ? (
        <JsonBlock
          title={intl.formatMessage({
            id: "conversation.genericToolCall.error",
            defaultMessage: "Error",
          })}
          value={tool.error}
        />
      ) : null}
    </ThreadActivityDisclosure>
  );
}
