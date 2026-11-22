import { describe, expect, test, vi } from "vite-plus/test";
import { render, textContent } from "../../../../test/dom";
import {
  CODEX_SHIMMER_CADENCE_MS,
  CODEX_SHIMMER_VARIANT,
  CodexShimmerProvider,
  CodexShimmerText,
} from "./codex-shimmer-text";

describe("CodexShimmerText", () => {
  test("renders a plain span when inactive", () => {
    const { container } = render(<CodexShimmerText active={false}>Static</CodexShimmerText>);

    expect(textContent(container)).toBe("Static");
    expect(
      container.querySelector("[data-codex-shimmer]")?.getAttribute("data-codex-shimmer"),
    ).toBe("static");
  });

  test("uses the Codex cadenced shimmer DOM when active", () => {
    const { container } = render(<CodexShimmerText>Loading</CodexShimmerText>);

    expect(
      container.querySelector("[data-codex-shimmer='cadenced']")?.firstChild?.textContent ?? "",
    ).toBe("Loading");
    expect(Boolean(container.querySelector("[data-codex-shimmer-sweep='true']"))).toBe(true);
  });

  test("keeps cadenced shimmer as the exact default variant", () => {
    expect(CODEX_SHIMMER_VARIANT).toBe("cadenced");
  });

  test("exposes Codex cadenced shimmer timing constants", () => {
    expect(CODEX_SHIMMER_CADENCE_MS.initialDelay).toBe(600);
    expect(CODEX_SHIMMER_CADENCE_MS.activeDuration).toBe(1_000);
    expect(CODEX_SHIMMER_CADENCE_MS.interval).toBe(4_000);
  });

  test("renders the optional cadenced shimmer overlay", () => {
    const { container } = render(<CodexShimmerText variant="cadenced">Loading</CodexShimmerText>);

    expect(
      container.querySelector("[data-codex-shimmer]")?.getAttribute("data-codex-shimmer"),
    ).toBe("cadenced");
    expect(Boolean(container.querySelector("[data-codex-shimmer-sweep='true']"))).toBe(true);
  });

  test("suppresses nested shimmer without changing its text", () => {
    const { container } = render(
      <CodexShimmerProvider enabled={false}>
        <CodexShimmerText>Nested activity</CodexShimmerText>
      </CodexShimmerProvider>,
    );

    expect(textContent(container)).toBe("Nested activity");
    expect(
      container.querySelector("[data-codex-shimmer]")?.getAttribute("data-codex-shimmer"),
    ).toBe("static");
    expect(container.querySelector("[data-codex-shimmer-sweep]")).toBe(null);
  });

  test("keeps the cadenced overlay static when reduced motion is requested", () => {
    const originalMatchMedia = window.matchMedia;
    const originalSetTimeout = window.setTimeout;
    let timeoutCount = 0;
    window.matchMedia = (() => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    })) as typeof window.matchMedia;
    window.setTimeout = ((handler: TimerHandler, timeout?: number) => {
      timeoutCount += 1;
      return originalSetTimeout(handler, timeout);
    }) as typeof window.setTimeout;

    try {
      const view = render(<CodexShimmerText>Loading</CodexShimmerText>);
      expect(Boolean(view.container.querySelector("[data-codex-shimmer-sweep='true']"))).toBe(true);
      expect(timeoutCount).toBe(0);
      view.unmount();
    } finally {
      window.matchMedia = originalMatchMedia;
      window.setTimeout = originalSetTimeout;
    }
  });

  test("sweeps a revealed label at once and never reports an end just for being torn down", () => {
    let rectOwner: object | null = document.createElement("span");
    while (rectOwner && !Object.hasOwn(rectOwner, "getBoundingClientRect")) {
      rectOwner = Object.getPrototypeOf(rectOwner) as object | null;
    }
    const onScreen = vi.spyOn(rectOwner as Element, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 200,
      bottom: 20,
      width: 200,
      height: 20,
    } as DOMRect);
    const shown = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const sweeps: boolean[] = [];
    try {
      const view = render(
        <CodexShimmerText startWithSweep onSweepChange={(sweeping) => sweeps.push(sweeping)}>
          Running tests
        </CodexShimmerText>,
      );
      expect(sweeps).toEqual([true]);
      // Unmounting (or a remounted effect) is not the end of a sweep its owner should act on.
      view.unmount();
      expect(sweeps).toEqual([true]);
    } finally {
      shown.mockRestore();
      onScreen.mockRestore();
    }
  });
});
