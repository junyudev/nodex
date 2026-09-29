import type { ToolComponentProps } from "./get-tool-component";
import { ThreadActivityDisclosure, ToolJsonDetail } from "./tool-primitives";

/** Tools without a specialized visualization retain their name, state and inspectable output. */
export function GenericToolCall({ item }: ToolComponentProps) {
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
      {tool.args !== undefined ? <ToolJsonDetail label="Input" value={tool.args} /> : null}
      {tool.result !== undefined ? <ToolJsonDetail label="Output" value={tool.result} /> : null}
      {tool.error ? <ToolJsonDetail label="Error" value={tool.error} /> : null}
    </ThreadActivityDisclosure>
  );
}
