import { resolveNativeAutomationUpdateRenderState } from "../../../projection/tool-metadata/native-automation-update";
import { AutomationUpdatePage } from "./automation-update-page";
import type { ToolComponentProps } from "./get-tool-component";

export function NativeAutomationToolCall({
  item,
  onOpenSummaryScheduledAutomation,
}: ToolComponentProps) {
  const state = item.automationUpdate
    ? resolveNativeAutomationUpdateRenderState(item.automationUpdate)
    : null;
  if (!state) return null;
  return (
    <AutomationUpdatePage
      initialState={state}
      onOpenSummaryScheduledAutomation={onOpenSummaryScheduledAutomation}
    />
  );
}
