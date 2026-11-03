import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { createRef, type ReactElement } from "react";
import { render, textContent } from "../../../../test/dom";
import {
  THREAD_SUMMARY_PANEL_SECTION_AUTO_COLLAPSE_MS,
  THREAD_SUMMARY_PANEL_SECTION_EXPANDED_STORAGE_PREFIX,
  ThreadSummaryPanelSection,
  type ThreadSummaryPanelSectionHandle,
} from "./thread-summary-panel-section";

function clearSectionStorage(sectionKey: string) {
  window.localStorage.removeItem(
    `${THREAD_SUMMARY_PANEL_SECTION_EXPANDED_STORAGE_PREFIX}${sectionKey}`,
  );
}

function renderReducedMotion(ui: ReactElement) {
  return render(<MotionConfig reducedMotion="always">{ui}</MotionConfig>);
}

describe("ThreadSummaryPanelSection", () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  test("renders the section chevron after the title and persists explicit collapse state", () => {
    const sectionKey = "test-environment";
    clearSectionStorage(sectionKey);

    const view = renderReducedMotion(
      <ThreadSummaryPanelSection sectionKey={sectionKey} title="Environment">
        <div>Changes</div>
      </ThreadSummaryPanelSection>,
    );

    const button = view.getByRole("button");
    const label = button.querySelector("span");
    const icon = button.querySelector("svg");
    const labelIndex = Array.from(button.childNodes).indexOf(label as ChildNode);
    const iconIndex = Array.from(button.childNodes).indexOf(icon as ChildNode);

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(label?.textContent).toBe("Environment");
    expect(iconIndex > labelIndex).toBe(true);
    expect(textContent(view.container).includes("Changes")).toBe(true);

    fireEvent.click(button);

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(
      window.localStorage.getItem(
        `${THREAD_SUMMARY_PANEL_SECTION_EXPANDED_STORAGE_PREFIX}${sectionKey}`,
      ),
    ).toBe("false");
    expect(textContent(view.container).includes("Changes")).toBe(false);

    view.unmount();
    const nextView = renderReducedMotion(
      <ThreadSummaryPanelSection sectionKey={sectionKey} title="Environment">
        <div>Changes</div>
      </ThreadSummaryPanelSection>,
    );

    expect(nextView.getByRole("button").getAttribute("aria-expanded")).toBe("false");
    expect(textContent(nextView.container).includes("Changes")).toBe(false);
  });

  test("shows title suffix only while the section is collapsed", () => {
    const sectionKey = "test-output-suffix";
    clearSectionStorage(sectionKey);
    const view = renderReducedMotion(
      <ThreadSummaryPanelSection
        sectionKey={sectionKey}
        title="Outputs"
        titleSuffix={<span>2</span>}
      >
        <div>thread-layout.tsx</div>
      </ThreadSummaryPanelSection>,
    );

    const button = view.getByRole("button");
    expect(textContent(button).includes("2")).toBe(false);

    fireEvent.click(button);

    expect(textContent(button).includes("2")).toBe(true);
  });

  test("supports headerless sections without rendering a toggle", () => {
    const sectionKey = "test-headerless";
    clearSectionStorage(sectionKey);
    const view = renderReducedMotion(
      <ThreadSummaryPanelSection sectionKey={sectionKey} title="Computer use" mode="headerless">
        <div>Browser preview</div>
      </ThreadSummaryPanelSection>,
    );

    expect(view.queryByRole("button") === null).toBe(true);
    expect(textContent(view.container).includes("Browser preview")).toBe(true);
  });

  test("passes expanded state to the after slot", () => {
    const sectionKey = "test-after-slot";
    clearSectionStorage(sectionKey);
    const view = renderReducedMotion(
      <ThreadSummaryPanelSection
        sectionKey={sectionKey}
        title="Progress"
        after={({ isExpanded }) => <span>{isExpanded ? "Open" : "Closed"}</span>}
      >
        <div>Inspect</div>
      </ThreadSummaryPanelSection>,
    );

    const button = view.getByRole("button");
    expect(textContent(view.container).includes("Open")).toBe(true);

    fireEvent.click(button);

    expect(textContent(view.container).includes("Closed")).toBe(true);
  });

  test("exposes imperative expand and collapse methods", () => {
    const sectionKey = "test-imperative";
    clearSectionStorage(sectionKey);
    const ref = createRef<ThreadSummaryPanelSectionHandle>();
    const view = renderReducedMotion(
      <ThreadSummaryPanelSection ref={ref} sectionKey={sectionKey} title="Sources">
        <div>Context7</div>
      </ThreadSummaryPanelSection>,
    );

    expect(ref.current !== null).toBe(true);
    act(() => {
      ref.current?.collapse();
    });

    expect(view.getByRole("button").getAttribute("aria-expanded")).toBe("false");
    expect(textContent(view.container).includes("Context7")).toBe(false);

    act(() => {
      ref.current?.expand();
    });

    expect(view.getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(textContent(view.container).includes("Context7")).toBe(true);
  });

  test("auto-collapses pending sections and cancels when the user interacts", () => {
    type TimeoutCallback = Parameters<typeof window.setTimeout>[0];
    const originalSetTimeout = window.setTimeout;
    const originalClearTimeout = window.clearTimeout;
    let nextTimerId = 1;
    const scheduled = new Map<number, () => void>();

    const installTimerMock = () => {
      window.setTimeout = ((callback: TimeoutCallback, delay?: number) => {
        expect(delay).toBe(THREAD_SUMMARY_PANEL_SECTION_AUTO_COLLAPSE_MS);
        const timerId = nextTimerId;
        nextTimerId += 1;
        scheduled.set(timerId, () => {
          if (typeof callback === "function") callback();
        });
        return timerId as unknown as ReturnType<typeof window.setTimeout>;
      }) as typeof window.setTimeout;
      window.clearTimeout = ((timerId?: number) => {
        if (timerId == null) return;
        scheduled.delete(timerId);
      }) as typeof window.clearTimeout;
    };
    const restoreTimerMock = () => {
      window.setTimeout = originalSetTimeout;
      window.clearTimeout = originalClearTimeout;
    };

    installTimerMock();

    const collapseKey = "test-auto-collapse";
    const cancelKey = "test-auto-collapse-cancel";
    clearSectionStorage(collapseKey);
    clearSectionStorage(cancelKey);

    try {
      const view = renderReducedMotion(
        <ThreadSummaryPanelSection sectionKey={collapseKey} title="Subagents" autoCollapse>
          <div>Subagent output</div>
        </ThreadSummaryPanelSection>,
      );

      expect(scheduled.size).toBe(1);
      restoreTimerMock();
      act(() => {
        Array.from(scheduled.values())[0]?.();
      });

      expect(view.getByRole("button").getAttribute("aria-expanded")).toBe("false");
      expect(textContent(view.container).includes("Subagent output")).toBe(false);

      view.unmount();
      scheduled.clear();
      installTimerMock();
      const cancelView = renderReducedMotion(
        <ThreadSummaryPanelSection sectionKey={cancelKey} title="Subagents" autoCollapse>
          <div>Keep visible</div>
        </ThreadSummaryPanelSection>,
      );

      expect(scheduled.size).toBe(1);
      act(() => {
        fireEvent.click(cancelView.getByText("Keep visible"));
      });
      restoreTimerMock();

      expect(scheduled.size).toBe(0);
      expect(cancelView.getByRole("button").getAttribute("aria-expanded")).toBe("true");
      expect(textContent(cancelView.container).includes("Keep visible")).toBe(true);
    } finally {
      restoreTimerMock();
    }
  });
});

test("changing section identity restarts auto-collapse and new activity reopens it", async () => {
  vi.useFakeTimers();
  clearSectionStorage("first-timer");
  clearSectionStorage("second-timer");
  const section = (sectionKey: string, autoCollapse: boolean) => (
    <MotionConfig reducedMotion="always">
      <ThreadSummaryPanelSection
        sectionKey={sectionKey}
        title="Subagents"
        autoCollapse={autoCollapse}
      >
        <div>Agent work</div>
      </ThreadSummaryPanelSection>
    </MotionConfig>
  );
  const view = render(section("first-timer", true));
  try {
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await act(async () => {
      view.rerender(section("second-timer", true));
    });
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(view.getByRole("button").getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(view.getByRole("button").getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      view.rerender(section("second-timer", false));
    });
    expect(view.getByRole("button").getAttribute("aria-expanded")).toBe("true");
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
