import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { useClippedFocusSafety } from "./use-clipped-focus-safety";

type IntersectionCallback = ConstructorParameters<typeof IntersectionObserver>[0];

class IntersectionObserverMock {
  static instances: IntersectionObserverMock[] = [];

  readonly observed: Element[] = [];

  constructor(private readonly callback: IntersectionCallback) {
    IntersectionObserverMock.instances.push(this);
  }

  disconnect() {}
  unobserve() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  observe(element: Element) {
    this.observed.push(element);
  }

  publish(element: Element, intersectionRatio: number) {
    this.callback(
      [
        {
          intersectionRatio,
          isIntersecting: intersectionRatio > 0,
          target: element,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

function FocusSafetyHarness({ clipped }: { readonly clipped: boolean }) {
  const contentRef = useRef<HTMLDivElement>(null);
  useClippedFocusSafety(contentRef, clipped);
  return (
    <div ref={contentRef}>
      <a href="https://example.com">Link</a>
      <button type="button">Control</button>
    </div>
  );
}

describe("useClippedFocusSafety", () => {
  const originalIntersectionObserver = globalThis.IntersectionObserver;

  afterEach(() => {
    globalThis.IntersectionObserver = originalIntersectionObserver;
    IntersectionObserverMock.instances = [];
  });

  test("makes clipped controls inert and restores their prior accessibility state", async () => {
    globalThis.IntersectionObserver =
      IntersectionObserverMock as unknown as typeof IntersectionObserver;
    const view = render(<FocusSafetyHarness clipped />);
    const link = view.getByRole("link", { hidden: true });
    const observer = IntersectionObserverMock.instances[0];
    if (!observer) throw new Error("Expected focus safety observer");

    await act(async () => {
      observer.publish(link, 0);
    });
    expect(link.inert).toBe(true);
    expect(link.getAttribute("aria-hidden")).toBe("true");

    view.rerender(<FocusSafetyHarness clipped={false} />);
    expect(link.inert).toBe(false);
    expect(link.hasAttribute("inert")).toBe(false);
    expect(link.hasAttribute("aria-hidden")).toBe(false);
  });

  test("keeps partially visible links usable while controls require full visibility", async () => {
    globalThis.IntersectionObserver =
      IntersectionObserverMock as unknown as typeof IntersectionObserver;
    const view = render(<FocusSafetyHarness clipped />);
    const link = view.getByRole("link", { hidden: true });
    const button = view.getByRole("button", { hidden: true });
    const observer = IntersectionObserverMock.instances[0];
    if (!observer) throw new Error("Expected focus safety observer");
    expect(link.inert).toBe(true);
    await act(async () => {
      observer.publish(link, 0.25);
      observer.publish(button, 0.25);
    });
    expect(link.inert).toBe(false);
    expect(button.inert).toBe(true);
    await act(async () => {
      observer.publish(link, 0);
      observer.publish(button, 1);
    });
    expect(link.inert).toBe(true);
    expect(button.inert).toBe(false);
  });

  test("checks clipped geometry when intersection observation is unavailable", () => {
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
    const geometry = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return this.tagName === "DIV" ? new DOMRect(0, 0, 100, 100) : new DOMRect(0, 90, 100, 20);
      });
    try {
      const view = render(<FocusSafetyHarness clipped />);
      expect(view.getByRole("link").inert).toBe(false);
      expect(view.getByRole("button", { hidden: true }).inert).toBe(true);
      view.rerender(<FocusSafetyHarness clipped={false} />);
      expect(view.getByRole("button").inert).toBe(false);
    } finally {
      geometry.mockRestore();
    }
  });
});
