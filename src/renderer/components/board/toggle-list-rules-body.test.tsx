import { StrictMode } from "react";
import { act, fireEvent } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { getDefaultToggleListSettings } from "@/lib/toggle-list/settings";
import { formatRulesV2AsJsonLogic } from "@/lib/toggle-list/rules-v2-jsonlogic";
import { render } from "@/test/dom";
import { ToggleListRulesBody } from "./toggle-list-rules-body";

test("keeps an unfinished rules draft until the authoritative rules change", async () => {
  const settings = getDefaultToggleListSettings();
  const updateSettings = vi.fn();
  const body = (value: typeof settings) => (
    <StrictMode>
      <NodexTooltipProvider>
        <ToggleListRulesBody
          settings={value}
          availableTags={[]}
          statusOptions={[]}
          updateSettings={updateSettings}
        />
      </NodexTooltipProvider>
    </StrictMode>
  );
  const view = render(body(settings));
  await act(async () => {
    fireEvent.click(view.getByRole("switch", { name: "Raw" }));
    await Promise.resolve();
  });
  const draft = view.getByRole("textbox") as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.change(draft, { target: { value: '{ "unfinished":' } });
    await Promise.resolve();
  });
  view.rerender(body({ ...settings, showEmptyEstimate: !settings.showEmptyEstimate }));
  expect(draft.value).toBe('{ "unfinished":');
  expect(updateSettings).not.toHaveBeenCalled();

  const replacement = getDefaultToggleListSettings();
  replacement.rulesV2.includeHostCard = !settings.rulesV2.includeHostCard;
  view.rerender(body(replacement));
  expect(draft.value).toBe(formatRulesV2AsJsonLogic(replacement.rulesV2));
});
