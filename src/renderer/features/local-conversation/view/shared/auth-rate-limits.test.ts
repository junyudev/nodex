import { describe, expect, test } from "vite-plus/test";
import {
  findAvailableQuotaResetCredit,
  formatQuotaResetAvailability,
  formatQuotaResetCreditExpiration,
} from "./auth-rate-limits";

describe("quota reset credits", () => {
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
