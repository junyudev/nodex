import { describe, expect, test } from "vite-plus/test";
import {
  buildRateLimitViewModel,
  findAvailableQuotaResetCredit,
  formatQuotaResetAvailability,
  formatQuotaResetCreditExpiration,
  formatRateLimitResetLabel,
  formatRateLimitWindowLabel,
  getRemainingRateLimitPercent,
} from "./auth-rate-limits";

describe("auth rate limits", () => {
  test("names quota windows by their duration", () => {
    expect(formatRateLimitWindowLabel(300)).toBe("5-hour");
    expect(formatRateLimitWindowLabel(24 * 60)).toBe("Daily");
    expect(formatRateLimitWindowLabel(7 * 24 * 60)).toBe("Weekly");
    expect(formatRateLimitWindowLabel(14 * 24 * 60)).toBe("2-week");
    expect(formatRateLimitWindowLabel(0)).toBe(null);
  });

  test("names a reset moment only as precisely as it needs", () => {
    const now = new Date(2027, 4, 12, 9, 0).getTime();
    expect(formatRateLimitResetLabel(new Date(2027, 4, 12, 15, 40).getTime(), now, "en-US")).toBe(
      "3:40 PM",
    );
    expect(formatRateLimitResetLabel(new Date(2027, 4, 13, 8, 5).getTime(), now, "en-US")).toBe(
      "Thu 8:05 AM",
    );
    expect(formatRateLimitResetLabel(new Date(2027, 4, 25, 8, 5).getTime(), now, "en-US")).toBe(
      "May 25",
    );
    expect(formatRateLimitResetLabel(now - 1, now, "en-US")).toBe("now");
    expect(formatRateLimitResetLabel(undefined, now)).toBe(null);
  });

  test("clamps remaining percentages for quota rings", () => {
    expect(getRemainingRateLimitPercent(-20)).toBe(100);
    expect(getRemainingRateLimitPercent(18.4)).toBe(82);
    expect(getRemainingRateLimitPercent(140)).toBe(0);
  });

  test("orders quota windows by duration and flags low remaining quota", () => {
    const model = buildRateLimitViewModel({
      primary: {
        usedPercent: 39,
        windowDurationMins: 7 * 24 * 60,
      },
      secondary: {
        usedPercent: 18,
        windowDurationMins: 300,
      },
    });

    expect(model.windows.map((window) => window.label)).toEqual(["5-hour", "Weekly"]);
    expect(model.outer?.remainingPercent).toBe(82);
    expect(model.outer?.color).toBe("var(--color-token-charts-blue)");
    expect(model.inner?.remainingPercent).toBe(61);
    expect(model.inner?.color).toBe("var(--color-token-charts-green)");
    expect(model.ariaLabel).toBe("Usage remaining: 5-hour 82%, weekly 61%");

    const low = buildRateLimitViewModel({ primary: { usedPercent: 82, windowDurationMins: 300 } });
    expect(low.outer?.color).toBe("var(--yellow-text)");
    expect(low.inner).toBe(null);
  });

  test("falls back when quota windows are missing", () => {
    const model = buildRateLimitViewModel({
      primary: undefined,
      secondary: {
        usedPercent: 25,
      },
    });

    expect(model.hasLimits).toBe(false);
    expect(model.outer === null).toBe(true);
    expect(model.inner === null).toBe(true);
    expect(model.ariaLabel).toBe("Usage remaining unavailable");
  });

  test("formats quota-reset expiry from the protocol's Unix-second timestamp", () => {
    const localNoon = new Date(2027, 4, 12, 12).getTime() / 1_000;
    const lastYear = new Date(2026, 9, 20).getTime();
    const sameYear = new Date(2027, 0, 3).getTime();
    expect(formatQuotaResetCreditExpiration(localNoon, "en-US", lastYear)).toBe(
      "Expires May 12, 2027",
    );
    expect(formatQuotaResetCreditExpiration(localNoon, "en-US", sameYear)).toBe("Expires May 12");
    expect(formatQuotaResetCreditExpiration(null, "en-US")).toBe("Doesn’t expire");
  });

  test("selects only an available reset-credit detail", () => {
    const available = findAvailableQuotaResetCredit({
      availableCount: 2,
      credits: [
        {
          id: "redeemed-credit",
          resetType: "codexRateLimits",
          status: "redeemed",
          grantedAt: 1,
          expiresAt: null,
          title: null,
          description: null,
        },
        {
          id: "available-credit",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: 2,
          expiresAt: 3,
          title: null,
          description: null,
        },
      ],
    });

    expect(available?.id).toBe("available-credit");
  });

  test("formats the reset disclosure count with correct plurality", () => {
    expect(formatQuotaResetAvailability(1)).toBe("1 quota reset");
    expect(formatQuotaResetAvailability(2)).toBe("2 quota resets");
  });
});
