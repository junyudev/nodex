import { createRef } from "react";
import { render } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { describe, expect, test } from "vite-plus/test";
import {
  IntelligenceSelectorTrigger,
  INTELLIGENCE_SELECTOR_FAST_SLOT_WIDTH_PX,
  INTELLIGENCE_SELECTOR_MENU_WIDTH_PX,
  resolveIntelligenceSelectorAlignOffset,
  resolveIntelligenceSelectorExpandedContentWidth,
} from "@/components/shared/agent-runtime/intelligence-selector-trigger";

describe("intelligence selector trigger geometry", () => {
  test("expands short labels to the menu width without moving its centered anchor", () => {
    const triggerChromeWidth = 36;
    const expandedContentWidth = resolveIntelligenceSelectorExpandedContentWidth({
      maxLabelWidth: 116,
      triggerChromeWidth,
    });

    expect(expandedContentWidth).toBe(
      INTELLIGENCE_SELECTOR_MENU_WIDTH_PX -
        triggerChromeWidth -
        INTELLIGENCE_SELECTOR_FAST_SLOT_WIDTH_PX,
    );
    expect(
      resolveIntelligenceSelectorAlignOffset({
        expandedContentWidth,
        triggerChromeWidth,
      }),
    ).toBe(-1);
  });

  test("keeps enough room for the widest label candidate", () => {
    const triggerChromeWidth = 36;
    const expandedContentWidth = resolveIntelligenceSelectorExpandedContentWidth({
      maxLabelWidth: 181,
      triggerChromeWidth,
    });

    expect(expandedContentWidth).toBe(181);
    expect(
      resolveIntelligenceSelectorAlignOffset({
        expandedContentWidth,
        triggerChromeWidth,
      }),
    ).toBe(4.5);
  });

  test("leaves intrinsic sizing in place until both DOM measurements exist", () => {
    expect(
      resolveIntelligenceSelectorExpandedContentWidth({
        maxLabelWidth: null,
        triggerChromeWidth: 36,
      }),
    ).toBeUndefined();
    expect(
      resolveIntelligenceSelectorExpandedContentWidth({
        maxLabelWidth: 181,
        triggerChromeWidth: null,
      }),
    ).toBeUndefined();
    expect(
      resolveIntelligenceSelectorAlignOffset({
        expandedContentWidth: undefined,
        triggerChromeWidth: 36,
      }),
    ).toBeUndefined();
  });

  test("disables geometry transitions when reduced motion is configured", () => {
    const view = render(
      <MotionConfig reducedMotion="always">
        <IntelligenceSelectorTrigger
          geometry={{
            alignOffset: -1,
            expandedContentWidth: 170,
            measurementRef: createRef<HTMLSpanElement>(),
            triggerRef: createRef<HTMLButtonElement>(),
            wrapperRef: createRef<HTMLSpanElement>(),
          }}
          isOpen
          labelCandidates={[
            {
              id: "gpt-5.6-sol:high",
              modelLabel: "GPT-5.6-Sol",
              reasoningLabel: "High",
            },
          ]}
          modelLabel="GPT-5.6-Sol"
          reasoningLabel="High"
          showFastIndicator={false}
          title="OpenAI · GPT-5.6-Sol · High"
        />
      </MotionConfig>,
    );

    const content = view.container.querySelector<HTMLElement>(
      "[data-intelligence-selector-trigger-content=true]",
    );
    expect(content?.style.transition).toBe("none");
  });
});
