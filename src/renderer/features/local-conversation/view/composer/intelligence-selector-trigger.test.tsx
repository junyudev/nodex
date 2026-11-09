import { render } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { describe, expect, test } from "vite-plus/test";
import {
  IntelligenceSelectorTrigger,
  intelligenceIndicatorSlotWidth,
} from "@/components/shared/agent-runtime/intelligence-selector-trigger";
import type { IntelligenceModeIndicator } from "@/components/shared/agent-runtime/intelligence-controls";

function renderTrigger(indicators: readonly IntelligenceModeIndicator[]) {
  return render(
    <IntelligenceSelectorTrigger
      modelLabel="GPT-5.6-Sol"
      reasoningLabel="High"
      indicators={indicators}
      title="OpenAI · GPT-5.6-Sol · High"
    />,
  );
}

function indicatorSlot(container: HTMLElement): HTMLElement {
  const slot = container.querySelector<HTMLElement>("[data-fast-mode-slot=true]");
  if (!slot) throw new Error("Expected the mode indicator slot.");
  return slot;
}

describe("intelligence selector trigger", () => {
  test("reserves room before the label only for the modes it shows", () => {
    expect(intelligenceIndicatorSlotWidth(0)).toBe(0);
    expect(intelligenceIndicatorSlotWidth(1)).toBe(18);
    expect(intelligenceIndicatorSlotWidth(2)).toBe(34);

    const plain = indicatorSlot(renderTrigger([]).container);
    expect(plain.style.inlineSize).toBe("0px");
    expect(plain.hasAttribute("data-reserved")).toBe(false);

    const fast = indicatorSlot(renderTrigger(["fast"]).container);
    expect(fast.style.inlineSize).toBe("18px");
    expect(fast.getAttribute("data-reserved")).toBe("true");
  });

  test("disables the slot transition when reduced motion is configured", () => {
    const view = render(
      <MotionConfig reducedMotion="always">
        <IntelligenceSelectorTrigger
          modelLabel="GPT-5.6-Sol"
          reasoningLabel="High"
          indicators={["fast"]}
        />
      </MotionConfig>,
    );

    expect(indicatorSlot(view.container).style.transition).toBe("none");
  });
});
