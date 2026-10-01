import { afterEach, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { render, settleAsyncRender } from "@/test/dom";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import {
  createDateMentionClockStore,
  setDateMentionClockStoreForTest,
} from "@/lib/nfm/date-mention-clock";
import { DateMentionInlineContentView, preloadDateMentionCalendar } from "./date-mention-chip";
import {
  dateMentionPayloadToProps,
  type DateMentionInlineContentUpdate,
  type DateMentionProps,
} from "./date-mention-inline-content";

vi.mock("./date-mention-calendar", async () => {
  const { DateMentionCalendarTestSurface } =
    await import("./testkit/date-mention-calendar-test-surface");
  return { DateMentionCalendar: DateMentionCalendarTestSurface };
});

let restoreDateMentionClockStore: (() => void) | null = null;

beforeAll(async () => {
  await act(preloadDateMentionCalendar);
});

afterEach(() => {
  restoreDateMentionClockStore?.();
  restoreDateMentionClockStore = null;
});

function renderDateMentionChip({
  props,
  onUpdate,
}: {
  props: Partial<DateMentionProps>;
  onUpdate?: (update: DateMentionInlineContentUpdate) => void;
}) {
  return render(
    <NodexTooltipProvider>
      <DateMentionInlineContentView
        inlineContent={{ props }}
        updateInlineContent={onUpdate ?? (() => undefined)}
      />
    </NodexTooltipProvider>,
  );
}

function installDateMentionClock(start: string) {
  let currentNow = new Date(start);
  const store = createDateMentionClockStore({
    now: () => new Date(currentNow.getTime()),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  });
  restoreDateMentionClockStore = setDateMentionClockStoreForTest(store);

  return {
    store,
    setNow: (value: string) => {
      currentNow = new Date(value);
    },
  };
}

describe("DateMentionInlineContentView", () => {
  test("renders a text-level date mention chip with stable non-editable guards", () => {
    const view = renderDateMentionChip({
      props: dateMentionPayloadToProps({
        type: "dateMention",
        start: "2050-06-28",
        format: "relative",
      }),
    });

    const chip = view.getByRole("button", { name: "@Jun 28, 2050" });
    expect(chip.getAttribute("contenteditable")).toBe("false");
    expect(chip.textContent).toBe("@Jun 28, 2050");
    expect(chip.getAttribute("data-date-mention-chip")).toBe("true");
    expect(view.container.querySelector('[data-date-mention-guard="start"]')).not.toBeNull();
    expect(view.container.querySelector('[data-date-mention-guard="end"]')).not.toBeNull();
  });

  test("refreshes relative labels across local day without mutating payload", async () => {
    const clock = installDateMentionClock("2026-06-28T12:00:00");
    let updateCount = 0;
    const view = renderDateMentionChip({
      props: dateMentionPayloadToProps({
        type: "dateMention",
        start: "2026-06-28",
        format: "relative",
      }),
      onUpdate: () => {
        updateCount += 1;
      },
    });

    expect(view.getByRole("button").textContent).toBe("@Today");

    await act(async () => {
      clock.setNow("2026-06-29T00:00:02");
      clock.store.refresh();
      await Promise.resolve();
    });

    expect(view.getByRole("button").textContent).toBe("@Yesterday");
    expect(updateCount).toBe(0);
  });

  test("restores the date on a time chip after local midnight without mutating payload", async () => {
    const clock = installDateMentionClock("2026-10-01T16:53:00");
    const onUpdate = vi.fn();
    const view = renderDateMentionChip({
      props: dateMentionPayloadToProps({
        type: "dateMention",
        start: "2026-10-01T16:53:00+08:00",
        format: "relative",
        timeFormat: "12h",
      }),
      onUpdate,
    });

    const chip = view.getByRole("button", { name: "@Oct 1, 2026 4:53 PM" });
    expect(chip.textContent).toBe("@4:53 PM");

    await act(async () => {
      clock.setNow("2026-10-02T00:00:02");
      clock.store.refresh();
      await Promise.resolve();
    });

    expect(chip.textContent).toBe("@Yesterday 4:53 PM");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  test("opens the date popover and updates payload when Include time is toggled", async () => {
    let update: DateMentionInlineContentUpdate | null = null;
    const view = renderDateMentionChip({
      props: dateMentionPayloadToProps({
        type: "dateMention",
        start: "2050-06-28",
        format: "relative",
      }),
      onUpdate: (nextUpdate) => {
        update = nextUpdate;
      },
    });

    fireEvent.click(view.getByRole("button", { name: "@Jun 28, 2050" }));
    await settleAsyncRender();

    expect((view.getByLabelText("Date") as HTMLInputElement).value).toBe("2050-06-28");
    fireEvent.click(view.getByRole("switch", { name: "Include time" }));

    const capturedUpdate = update as DateMentionInlineContentUpdate | null;
    expect(capturedUpdate !== null).toBe(true);
    if (!capturedUpdate) return;
    expect(capturedUpdate.type).toBe("dateMention");
    expect(capturedUpdate.props.start.startsWith("2050-06-28T")).toBe(true);
    expect(
      capturedUpdate.props.start.endsWith("Z") ||
        /[+-]\d{2}:\d{2}$/.test(capturedUpdate.props.start),
    ).toBe(true);
    expect(capturedUpdate.props.tz.length > 0).toBe(true);
  });

  test("resolves pending and overdue reminder tones without mutating payload", () => {
    const pending = renderDateMentionChip({
      props: dateMentionPayloadToProps({
        type: "dateMention",
        start: "2999-06-28",
        format: "relative",
        reminder: "day:0@09:00",
      }),
    });
    expect(pending.getByRole("button").getAttribute("data-reminder-tone")).toBe("pending");
    pending.unmount();

    const overdue = renderDateMentionChip({
      props: dateMentionPayloadToProps({
        type: "dateMention",
        start: "2000-06-28",
        format: "relative",
        reminder: "day:0@09:00",
      }),
    });
    expect(overdue.getByRole("button").getAttribute("data-reminder-tone")).toBe("overdue");
  });

  test("refreshes reminder tone on the minute clock without mutating payload", async () => {
    const clock = installDateMentionClock("2026-06-28T08:59:30");
    let updateCount = 0;
    const view = renderDateMentionChip({
      props: dateMentionPayloadToProps({
        type: "dateMention",
        start: "2026-06-28",
        format: "relative",
        reminder: "day:0@09:00",
      }),
      onUpdate: () => {
        updateCount += 1;
      },
    });

    expect(view.getByRole("button").getAttribute("data-reminder-tone")).toBe("pending");

    await act(async () => {
      clock.setNow("2026-06-28T09:01:00");
      clock.store.refresh();
      await Promise.resolve();
    });

    expect(view.getByRole("button").getAttribute("data-reminder-tone")).toBe("overdue");
    expect(updateCount).toBe(0);
  });
});
