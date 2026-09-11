import { describe, expect, test } from "vite-plus/test";
import { render } from "../../../../test/dom";
import { NodexTooltipProvider } from "../../../../components/ui/tooltip";
import {
  ForkMessageIcon,
  MessageTimestamp,
  ThreadActionIconButton,
} from "./thread-message-actions";
import { formatThreadMessageTimestamp } from "./thread-message-timestamp";

function localTimestampMs(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
): number {
  return new Date(year, monthIndex, day, hour, minute).getTime();
}

function formatExpected(dateMs: number, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, options).format(new Date(dateMs));
}

describe("formatThreadMessageTimestamp", () => {
  const nowMs = localTimestampMs(2026, 6, 10, 12, 0);

  test("returns null when sentAtMs is missing or invalid", () => {
    expect(formatThreadMessageTimestamp(null, nowMs)).toBe(null);
    expect(formatThreadMessageTimestamp(undefined, nowMs)).toBe(null);
    expect(formatThreadMessageTimestamp(Number.NaN, nowMs)).toBe(null);
    expect(formatThreadMessageTimestamp(Number.POSITIVE_INFINITY, nowMs)).toBe(null);
  });

  test("renders time only for messages sent today", () => {
    const sentAtMs = localTimestampMs(2026, 6, 10, 9, 35);

    expect(formatThreadMessageTimestamp(sentAtMs, nowMs)).toBe(
      formatExpected(sentAtMs, {
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });

  test("renders weekday and time for messages from the recent past week", () => {
    const yesterdaySentAtMs = localTimestampMs(2026, 6, 9, 9, 35);
    const sixDaysAgoSentAtMs = localTimestampMs(2026, 6, 4, 9, 35);

    expect(formatThreadMessageTimestamp(yesterdaySentAtMs, nowMs)).toBe(
      formatExpected(yesterdaySentAtMs, {
        weekday: "long",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
    expect(formatThreadMessageTimestamp(sixDaysAgoSentAtMs, nowMs)).toBe(
      formatExpected(sixDaysAgoSentAtMs, {
        weekday: "long",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });

  test("renders month, day, and time for messages exactly seven days old", () => {
    const sentAtMs = localTimestampMs(2026, 6, 3, 9, 35);

    expect(formatThreadMessageTimestamp(sentAtMs, nowMs)).toBe(
      formatExpected(sentAtMs, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });

  test("renders month, day, and time for future timestamps", () => {
    const sentAtMs = localTimestampMs(2026, 6, 10, 13, 35);

    expect(formatThreadMessageTimestamp(sentAtMs, nowMs)).toBe(
      formatExpected(sentAtMs, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });
});

describe("MessageTimestamp", () => {
  test("renders no node when sentAtMs is missing", () => {
    const { container } = render(<MessageTimestamp sentAtMs={null} />);

    expect(container.textContent).toBe("");
    expect(container.querySelector("span") === null).toBe(true);
  });

  test("renders the relative calendar timestamp", () => {
    const nowMs = localTimestampMs(2026, 6, 10, 12, 0);
    const sentAtMs = localTimestampMs(2026, 6, 9, 9, 35);
    const expectedTime = formatThreadMessageTimestamp(sentAtMs, nowMs);
    const { container } = render(<MessageTimestamp sentAtMs={sentAtMs} nowMs={nowMs} />);
    const timestamp = container.querySelector("span span");

    expect(timestamp?.textContent).toBe(expectedTime);
  });
});

describe("ThreadActionIconButton", () => {
  test("passes a concise tooltip while preserving the descriptive aria label", () => {
    const { getByRole } = render(
      <NodexTooltipProvider>
        <ThreadActionIconButton label="Fork from this point" tooltip="Fork">
          <ForkMessageIcon />
        </ThreadActionIconButton>
      </NodexTooltipProvider>,
    );

    const button = getByRole("button", { name: "Fork from this point" });
    expect(button.getAttribute("title")).toBe(null);
  });

  test("renders a plain button when no tooltip is requested", () => {
    const { getByRole, container } = render(
      <ThreadActionIconButton label="Edit message">
        <ForkMessageIcon />
      </ThreadActionIconButton>,
    );

    expect(Boolean(container.querySelector("[data-tooltip-content]"))).toBe(false);
    expect(Boolean(getByRole("button", { name: "Edit message" }))).toBe(true);
  });
});
