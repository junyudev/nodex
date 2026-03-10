import type { CodexItemView } from "../../../../lib/types";
import { InlineToolToggle, ToolErrorDetail, ToolJsonDetail } from "./tool-primitives";

interface GenericToolCallProps {
  item: CodexItemView;
}

export function GenericToolCall({ item }: GenericToolCallProps) {
  const tool = item.toolCall;
  const label = tool ? `${tool.server ? `${tool.server} / ` : ""}${tool.toolName}` : item.markdownText ?? "Tool call";

  return (
    <InlineToolToggle
      label={label}
      status={item.status}
    >
      {tool?.args !== undefined && <ToolJsonDetail label="Arguments" value={tool.args} />}
      {tool?.result !== undefined && <ToolJsonDetail label="Result" value={tool.result} />}
      {tool?.error && <ToolErrorDetail error={tool.error} className="mb-2" />}

      {!tool && Boolean(item.rawItem) && (
        <ToolJsonDetail label="Raw Item" value={item.rawItem} />
      )}

      {!tool?.args && !tool?.result && !tool?.error && !item.rawItem && (
        <div className="text-xs text-(--foreground-tertiary)">No structured output available.</div>
      )}
    </InlineToolToggle>
  );
}
