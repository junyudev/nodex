import { describe, expect, test } from "bun:test";
import { shouldRefreshAccountOnConnectionTooltipOpen } from "./stage-threads-account-tooltip-refresh";

describe("shouldRefreshAccountOnConnectionTooltipOpen", () => {
  test("refreshes only when the tooltip opens for a signed-in account and no refresh is pending", () => {
    expect(
      shouldRefreshAccountOnConnectionTooltipOpen({
        isOpen: true,
        hasAccount: true,
        refreshInFlight: false,
      }),
    ).toBeTrue();

    expect(
      shouldRefreshAccountOnConnectionTooltipOpen({
        isOpen: false,
        hasAccount: true,
        refreshInFlight: false,
      }),
    ).toBeFalse();

    expect(
      shouldRefreshAccountOnConnectionTooltipOpen({
        isOpen: true,
        hasAccount: false,
        refreshInFlight: false,
      }),
    ).toBeFalse();

    expect(
      shouldRefreshAccountOnConnectionTooltipOpen({
        isOpen: true,
        hasAccount: true,
        refreshInFlight: true,
      }),
    ).toBeFalse();
  });
});
