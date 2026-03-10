import type { CodexItemView } from "../../../../lib/types";
import { InlineToolToggle, ToolErrorDetail, ToolJsonDetail } from "./tool-primitives";

interface WebSearchToolCallProps {
  item: CodexItemView;
}

function extractQuery(item: CodexItemView): string | undefined {
  const args = item.toolCall?.args;
  if (typeof args === "object" && args !== null) {
    const candidate = args as { query?: unknown };
    if (typeof candidate.query === "string" && candidate.query.trim().length > 0) {
      return candidate.query;
    }
  }

  return undefined;
}

export function WebSearchToolCall({ item }: WebSearchToolCallProps) {
  const query = extractQuery(item);

  return (
    <InlineToolToggle
      label={query ? `Searched web for ${query}` : "Searched web"}
      leadingLabel="Searched web"
      status={item.status}
    >
      {item.toolCall?.args !== undefined && <ToolJsonDetail label="Arguments" value={item.toolCall.args} />}
      {item.toolCall?.result !== undefined && <ToolJsonDetail label="Result" value={item.toolCall.result} />}
      {item.toolCall?.error && <ToolErrorDetail error={item.toolCall.error} className="mb-2" />}
    </InlineToolToggle>
  );
}
