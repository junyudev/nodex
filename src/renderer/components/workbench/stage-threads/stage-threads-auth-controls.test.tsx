import { describe, expect, test } from "bun:test";
import {
  formatRateLimitResetLabel,
  formatRateLimitWindowLabel,
  RateLimitTooltipSection,
} from "./stage-threads-auth-rate-limits";
import { render } from "../../../test/dom";

describe("stage-threads-auth-controls", () => {
  test("formats rate limit windows with hourly and weekly labels", () => {
    expect(formatRateLimitWindowLabel(300)).toBe("5h");
    expect(formatRateLimitWindowLabel(10080)).toBe("Weekly");
    expect(formatRateLimitWindowLabel(undefined) === null).toBeTrue();
  });

  test("formats reset labels as time for near-term resets and month/day for distant resets", () => {
    const now = Date.UTC(2026, 2, 4, 0, 0, 0);

    const sameDayLabel = formatRateLimitResetLabel(now + 5 * 60 * 60 * 1000, now);
    expect(Boolean(sameDayLabel)).toBeTrue();
    expect((sameDayLabel ?? "").includes(":")).toBeTrue();

    const distantLabel = formatRateLimitResetLabel(now + 7 * 24 * 60 * 60 * 1000, now);
    expect(Boolean(distantLabel)).toBeTrue();
    expect((distantLabel ?? "").includes(":")).toBeFalse();

    expect(formatRateLimitResetLabel(now - 1, now)).toBe("now");
  });

  test("renders remaining rate limits rows", () => {
    const { getByText } = render(
      <RateLimitTooltipSection
        rateLimits={{
          primary: {
            usedPercent: 5,
            windowDurationMins: 300,
            resetsAt: Date.UTC(2026, 2, 4, 11, 40, 0),
          },
          secondary: {
            usedPercent: 33,
            windowDurationMins: 10080,
            resetsAt: Date.UTC(2026, 2, 10, 0, 0, 0),
          },
        }}
      />,
    );

    expect(getByText("Rate limits remaining").textContent).toBe("Rate limits remaining");
    expect(getByText("5h").textContent).toBe("5h");
    expect(getByText("95%").textContent).toBe("95%");
    expect(getByText("Weekly").textContent).toBe("Weekly");
    expect(getByText("67%").textContent).toBe("67%");
  });
});
