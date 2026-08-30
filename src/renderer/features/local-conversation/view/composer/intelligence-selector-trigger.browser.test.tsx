import { createRef } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import {
  buildIntelligenceSelectorLabelMeasurementKey,
  IntelligenceSelectorTrigger,
  useIntelligenceSelectorTriggerGeometry,
} from "@/components/shared/agent-runtime/intelligence-selector-trigger";
import "../../../../globals.css";

function SemanticallyStableCandidatesHarness({ revision }: { readonly revision: number }) {
  const labelCandidates = [
    {
      id: "openai:gpt-5.6-sol:xhigh",
      modelLabel: "GPT-5.6-Sol",
      reasoningLabel: "Extra High",
    },
  ];
  const geometry = useIntelligenceSelectorTriggerGeometry(labelCandidates);

  return (
    <IntelligenceSelectorTrigger
      geometry={geometry}
      isOpen={false}
      labelCandidates={labelCandidates}
      modelLabel="GPT-5.6-Sol"
      reasoningLabel="Extra High"
      showFastIndicator={false}
      data-revision={revision}
    />
  );
}

describe("IntelligenceSelectorTrigger layout", () => {
  test("keys measurement work by rendered label semantics", () => {
    const first = [
      {
        id: "first-id",
        modelLabel: "GPT-5.6-Sol",
        reasoningLabel: "Extra High",
      },
    ];
    const sameLabels = [{ ...first[0], id: "replacement-id" }];
    const changedLabels = [{ ...first[0], reasoningLabel: "High" }];

    expect(buildIntelligenceSelectorLabelMeasurementKey(sameLabels)).toBe(
      buildIntelligenceSelectorLabelMeasurementKey(first),
    );
    expect(buildIntelligenceSelectorLabelMeasurementKey(changedLabels)).not.toBe(
      buildIntelligenceSelectorLabelMeasurementKey(first),
    );
  });

  test("accepts semantically stable label candidates across parent rerenders", async () => {
    const view = render(<SemanticallyStableCandidatesHarness revision={0} />);
    await view.findByRole("button", { name: "Select model" });

    view.rerender(<SemanticallyStableCandidatesHarness revision={1} />);

    await view.findByRole("button", { name: "Select model" });
  });

  test("measures every label candidate without adding scrollable height", async () => {
    const view = render(
      <div className="relative h-7 w-80 overflow-y-auto" data-testid="composer-control-row">
        <IntelligenceSelectorTrigger
          geometry={{
            alignOffset: undefined,
            expandedContentWidth: undefined,
            measurementRef: createRef<HTMLSpanElement>(),
            triggerRef: createRef<HTMLButtonElement>(),
            wrapperRef: createRef<HTMLSpanElement>(),
          }}
          isOpen={false}
          labelCandidates={[
            {
              id: "openai:gpt-5.6-sol:low",
              modelLabel: "GPT-5.6-Sol",
              reasoningLabel: "Low",
            },
            {
              id: "openai:gpt-5.6-sol:xhigh",
              modelLabel: "GPT-5.6-Sol",
              reasoningLabel: "Extra High",
            },
            {
              id: "anthropic:claude-opus:high",
              modelLabel: "Claude Opus",
              reasoningLabel: "High",
            },
          ]}
          modelLabel="GPT-5.6-Sol"
          reasoningLabel="Extra High"
          showFastIndicator={false}
          title="OpenAI · GPT-5.6-Sol · Extra High"
        />
      </div>,
    );

    await waitFor(() => {
      const measurement = view.container.querySelector<HTMLElement>(
        "[data-intelligence-selector-label-measurement=true]",
      );
      if (!measurement) {
        throw new Error("Expected the intelligence selector measurement stack.");
      }

      const candidates = Array.from(measurement.children).filter(
        (candidate): candidate is HTMLElement => candidate instanceof HTMLElement,
      );
      const candidateWidths = candidates.map(
        (candidate) => candidate.getBoundingClientRect().width,
      );
      const candidateHeights = candidates.map(
        (candidate) => candidate.getBoundingClientRect().height,
      );
      const controlRow = view.getByTestId("composer-control-row");
      const trigger = view.getByRole("button", { name: "Select model" });

      expect(candidates).toHaveLength(3);
      expect(measurement.getBoundingClientRect().width).toBeCloseTo(
        Math.max(...candidateWidths),
        1,
      );
      expect(measurement.clientHeight).toBe(Math.max(...candidateHeights));
      expect(measurement.scrollHeight).toBe(measurement.clientHeight);
      expect(trigger.scrollHeight).toBeLessThanOrEqual(trigger.clientHeight);
      expect(controlRow.scrollHeight).toBe(controlRow.clientHeight);
    });
  });

  test("keeps the Fast icon and selected label centered while expanded", async () => {
    const view = render(
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
            id: "openai:gpt-5.6-sol:xhigh",
            modelLabel: "GPT-5.6-Sol",
            reasoningLabel: "Extra High",
          },
        ]}
        modelLabel="GPT-5.6-Sol"
        reasoningLabel="Extra High"
        showFastIndicator
        title="OpenAI · GPT-5.6-Sol · Extra High"
      />,
    );

    await waitFor(() => {
      const wrapper = view.container.querySelector<HTMLElement>(
        "[data-intelligence-selector-trigger-wrapper=true]",
      );
      const label = view.container.querySelector<HTMLElement>("[data-fast-mode-indicator=true]");
      const icon = label?.querySelector<SVGSVGElement>("svg");
      const slot = view.container.querySelector<HTMLElement>("[data-fast-mode-slot=true]");
      if (!wrapper || !label || !icon || !slot) {
        throw new Error("Expected the expanded Fast selector geometry.");
      }

      const wrapperRect = wrapper.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      const compositionCenter = (iconRect.left + labelRect.right) / 2;
      const wrapperCenter = (wrapperRect.left + wrapperRect.right) / 2;

      expect(slot.getBoundingClientRect().width).toBeCloseTo(18, 1);
      expect(compositionCenter).toBeCloseTo(wrapperCenter, 1);
    });
  });
});
