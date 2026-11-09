import { resolveNativeAutomationUpdateRenderState } from "../../../projection/tool-metadata/native-automation-update";
import { AutomationUpdatePage } from "./automation-update-page";
import type { ToolComponentProps } from "./get-tool-component";
import { useToolCallOutputDetail } from "./use-tool-call-output-detail";
import { McpToolCall } from "./mcp-tool-call";

export function NativeAutomationToolCall(props: ToolComponentProps) {
  const { item, onOpenSummaryAutomation } = props;
  const { error, available } = useToolCallOutputDetail(item, true, item.mcpToolCall?.outputOmitted);
  const state = item.automationUpdate
    ? resolveNativeAutomationUpdateRenderState(item.automationUpdate)
    : null;
  if (error) return <p role="alert">{error}</p>;
  if (!state && item.mcpToolCall?.outputOmitted && available)
    return <p role="status">Loading automation…</p>;
  if (!state) return <McpToolCall {...props} />;
  return (
    <AutomationUpdatePage initialState={state} onOpenSummaryAutomation={onOpenSummaryAutomation} />
  );
}
