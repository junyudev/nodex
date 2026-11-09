import { render, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { IntelligenceSelectorTrigger } from "@/components/shared/agent-runtime/intelligence-selector-trigger";
import "../../../../globals.css";

describe("IntelligenceSelectorTrigger layout", () => {
  test("fits the Composer control row without adding scrollable height", async () => {
    const view = render(
      <div className="relative h-7 w-80 overflow-y-auto" data-testid="composer-control-row">
        <IntelligenceSelectorTrigger
          modelLabel="GPT-5.6-Sol"
          reasoningLabel="Extra High"
          indicators={[]}
          title="OpenAI · GPT-5.6-Sol · Extra High"
        />
      </div>,
    );

    const trigger = await view.findByRole("button", { name: "Select model" });
    const controlRow = view.getByTestId("composer-control-row");
    expect(trigger.scrollHeight).toBeLessThanOrEqual(trigger.clientHeight);
    expect(controlRow.scrollHeight).toBe(controlRow.clientHeight);
  });

  test("draws the Fast icon inside the room reserved before the label", async () => {
    const view = render(
      <IntelligenceSelectorTrigger
        modelLabel="GPT-5.6-Sol"
        reasoningLabel="Extra High"
        indicators={["fast"]}
        title="OpenAI · GPT-5.6-Sol · Extra High"
      />,
    );

    await waitFor(() => {
      const slot = view.container.querySelector<HTMLElement>("[data-fast-mode-slot=true]");
      const label = view.container.querySelector<HTMLElement>("[data-fast-mode-indicator=true]");
      const icon = label?.querySelector<SVGSVGElement>("svg");
      if (!slot || !label || !icon) throw new Error("Expected the Fast selector geometry.");

      const slotRect = slot.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      expect(slotRect.width).toBeCloseTo(18, 1);
      expect(iconRect.left).toBeGreaterThanOrEqual(slotRect.left - 0.5);
      expect(iconRect.right).toBeLessThanOrEqual(label.getBoundingClientRect().left + 0.5);
    });
  });
});
