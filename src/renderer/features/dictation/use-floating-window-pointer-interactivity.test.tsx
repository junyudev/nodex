import { useRef } from "react";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { render } from "../../test/dom";
import { useFloatingWindowPointerInteractivity } from "./use-floating-window-pointer-interactivity";

function Region({ nonce, publish }: { nonce: number; publish: (interactive: boolean) => void }) {
  const interactiveRegionRef = useRef<HTMLDivElement>(null);
  useFloatingWindowPointerInteractivity({
    activationNonce: nonce,
    interactiveRegionRef,
    onInteractiveChange: publish,
  });
  return <div ref={interactiveRegionRef} data-testid="region" />;
}

test("a new activation releases pointer capture and samples the next mouse position again", async () => {
  const publish = vi.fn();
  const previousHitTest = Object.getOwnPropertyDescriptor(document, "elementsFromPoint");
  const view = render(<Region nonce={1} publish={publish} />);
  const region = view.getByTestId("region");
  vi.spyOn(region, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON: () => ({}),
  });
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: () => [region],
  });
  try {
    await act(async () => {
      fireEvent.mouseMove(window, { clientX: 20, clientY: 20 });
      await Promise.resolve();
    });
    await waitFor(() => expect(publish).toHaveBeenLastCalledWith(true));
    await act(async () => {
      fireEvent.mouseLeave(window);
      await Promise.resolve();
    });
    expect(publish).toHaveBeenLastCalledWith(false);
    await act(async () => {
      view.rerender(<Region nonce={1} publish={publish} />);
    });
    expect(publish).toHaveBeenLastCalledWith(false);
    await act(async () => {
      view.rerender(<Region nonce={2} publish={publish} />);
    });
    expect(publish).toHaveBeenLastCalledWith(true);
    publish.mockClear();
    await act(async () => {
      fireEvent.mouseMove(window, { clientX: 20, clientY: 20 });
      await Promise.resolve();
    });
    await waitFor(() => expect(publish).toHaveBeenCalledWith(true));
  } finally {
    view.unmount();
    if (previousHitTest) Object.defineProperty(document, "elementsFromPoint", previousHitTest);
    else Reflect.deleteProperty(document, "elementsFromPoint");
  }
});
