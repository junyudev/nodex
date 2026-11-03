import { useLayoutEffect } from "react";
import { render, waitFor } from "@testing-library/react";
import { motion } from "motion/react";
import { describe, expect, test } from "vite-plus/test";
import { useElementSizeMotionValues } from "./resize-observer-motion-values";

describe("ResizeObserver MotionValue geometry", () => {
  test("updates observed dimensions without re-rendering the React owner", async () => {
    let renderCount = 0;

    function Harness() {
      useLayoutEffect(() => {
        renderCount += 1;
      });
      const { ref, height, width } = useElementSizeMotionValues();
      return (
        <div ref={ref} data-testid="measured-shell" style={{ height: 80, width: 120 }}>
          <motion.div data-testid="geometry-consumer" style={{ height, width }} />
        </div>
      );
    }

    const view = render(<Harness />);
    const measuredShell = view.getByTestId("measured-shell");
    const geometryConsumer = view.getByTestId("geometry-consumer");

    await waitFor(() => {
      expect(geometryConsumer.style.width).toBe("120px");
      expect(geometryConsumer.style.height).toBe("80px");
    });
    const renderCountAfterMount = renderCount;

    measuredShell.style.width = "180px";
    measuredShell.style.height = "96px";

    await waitFor(() => {
      expect(geometryConsumer.style.width).toBe("180px");
      expect(geometryConsumer.style.height).toBe("96px");
    });
    expect(renderCount).toBe(renderCountAfterMount);
  });
});
