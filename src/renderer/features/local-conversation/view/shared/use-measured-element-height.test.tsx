import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, test, vi } from "vite-plus/test";
import { useMeasuredElementHeight } from "./use-measured-element-height";

test("measures attachments and resize samples, then clears detached elements under StrictMode", async () => {
  const samples = new Map<Element, () => void>();
  const originalObserver = globalThis.ResizeObserver;
  class Observer {
    constructor(private readonly notify: () => void) {}
    observe(node: Element) {
      samples.set(node, this.notify);
    }
    disconnect() {
      for (const [node, notify] of samples) if (notify === this.notify) samples.delete(node);
    }
  }
  globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;
  const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(48);
  function Probe({ visible }: { visible: boolean }) {
    const { elementHeightPx, elementRef } = useMeasuredElementHeight();
    return (
      <>
        <output aria-label="Measured height">{elementHeightPx}</output>
        {visible ? <div ref={elementRef} /> : null}
      </>
    );
  }
  const view = render(
    <StrictMode>
      <Probe visible />
    </StrictMode>,
  );
  try {
    expect(view.getByLabelText("Measured height").textContent).toBe("48");
    expect(samples.size).toBe(1);
    height.mockReturnValue(96);
    await act(async () => {
      for (const notify of samples.values()) notify();
    });
    expect(view.getByLabelText("Measured height").textContent).toBe("96");
    await act(async () => {
      view.rerender(
        <StrictMode>
          <Probe visible={false} />
        </StrictMode>,
      );
    });
    expect(view.getByLabelText("Measured height").textContent).toBe("0");
    expect(samples.size).toBe(0);
    await act(async () => {
      view.rerender(
        <StrictMode>
          <Probe visible />
        </StrictMode>,
      );
    });
    expect(view.getByLabelText("Measured height").textContent).toBe("96");
    expect(samples.size).toBe(1);
    view.unmount();
    expect(samples.size).toBe(0);
  } finally {
    view.unmount();
    height.mockRestore();
    globalThis.ResizeObserver = originalObserver;
  }
});
