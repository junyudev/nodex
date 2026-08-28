import { describe, expect, test } from "vite-plus/test";
import { render } from "../../../../test/dom";
import {
  formatThreadTimestampSeparator,
  ThreadTimestampSeparator,
} from "./thread-timestamp-separator";

function localTimestampMs(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
): number {
  return new Date(year, monthIndex, day, hour, minute).getTime();
}

describe("formatThreadTimestampSeparator", () => {
  const nowMs = localTimestampMs(2026, 6, 10, 12, 0);

  test("formats today, yesterday, and the recent week without an at preposition", () => {
    expect(
      formatThreadTimestampSeparator(localTimestampMs(2026, 6, 10, 9, 35), nowMs, "en-US"),
    ).toMatchObject({ date: "Today", time: "9:35 AM", includeAt: false });
    expect(
      formatThreadTimestampSeparator(localTimestampMs(2026, 6, 9, 9, 35), nowMs, "en-US"),
    ).toMatchObject({ date: "Yesterday", time: "9:35 AM", includeAt: false });
    expect(
      formatThreadTimestampSeparator(localTimestampMs(2026, 6, 3, 9, 35), nowMs, "en-US"),
    ).toMatchObject({ date: "Friday", time: "9:35 AM", includeAt: false });
  });

  test("uses compact calendar dates and at for older timestamps", () => {
    expect(
      formatThreadTimestampSeparator(localTimestampMs(2026, 6, 2, 9, 35), nowMs, "en-US"),
    ).toEqual({
      date: "Thu, Jul 2",
      time: "9:35 AM",
      includeAt: true,
      label: "Thu, Jul 2 at 9:35 AM",
    });
    expect(
      formatThreadTimestampSeparator(localTimestampMs(2025, 6, 9, 9, 35), nowMs, "en-US"),
    ).toMatchObject({ date: "Jul 9, 2025", includeAt: true });
  });

  test("clamps future calendar dates to the today label", () => {
    expect(
      formatThreadTimestampSeparator(localTimestampMs(2026, 6, 11, 9, 35), nowMs, "en-US"),
    ).toMatchObject({ date: "Today", includeAt: false });
  });
});

describe("ThreadTimestampSeparator", () => {
  test("renders the centered semantic separator and machine-readable time", () => {
    const nowMs = localTimestampMs(2026, 6, 10, 12, 0);
    const sentAtMs = localTimestampMs(2026, 6, 9, 9, 35);
    const expected = formatThreadTimestampSeparator(sentAtMs, nowMs);
    const view = render(<ThreadTimestampSeparator sentAtMs={sentAtMs} nowMs={nowMs} />);

    const separator = view.getByRole("separator", { name: expected.label });
    const time = separator.querySelector("time");
    expect(time?.dateTime).toBe(new Date(sentAtMs).toISOString());
    expect(time?.textContent).toBe(expected.label);
    expect(time?.querySelector("span")?.textContent).toBe(expected.date);
  });

  test("renders nothing for a non-finite timestamp", () => {
    const view = render(<ThreadTimestampSeparator sentAtMs={Number.NaN} />);
    expect(view.container.querySelector("time")).toBeNull();
  });
});
