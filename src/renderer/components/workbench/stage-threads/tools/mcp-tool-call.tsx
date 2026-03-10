import type { CodexItemView } from "../../../../lib/types";
import {
  InlineToolToggle,
  ToolErrorDetail,
  ToolJsonDetail,
} from "./tool-primitives";

interface McpToolCallProps {
  item: CodexItemView;
}

export function McpToolCall({ item }: McpToolCallProps) {
  const tool = item.toolCall;
  const toolName = tool ? `${tool.server ? `${tool.server} / ` : ""}${tool.toolName}` : item.markdownText ?? "tool";
  const label = `Called ${toolName}`;

  return (
    <InlineToolToggle
      label={label}
      leadingLabel="Called"
      status={item.status}
    >
      {tool?.args !== undefined && <ToolJsonDetail label="Arguments" value={tool.args} />}
      {tool?.result !== undefined && <ToolJsonDetail label="Result" value={tool.result} />}

      {tool?.error && <ToolErrorDetail error={tool.error} className="mb-2" />}
    </InlineToolToggle>
  );
}
