import { describe, expect, test } from "vite-plus/test";
import {
  findAvailableQuotaResetCredit,
  formatQuotaResetAvailability,
  formatQuotaResetCreditExpiration,
} from "./auth-rate-limits";
import type { CodexAccountSnapshot, CodexConnectionState } from "@/lib/types";
import { resolveRailAccountState } from "./rail-account-state";

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

describe("rail account state", () => {
  const connected: CodexConnectionState = { status: "connected", retries: 0, lastConnectedAt: 1 };
  const snapshot = (patch: Partial<CodexAccountSnapshot>): CodexAccountSnapshot => ({
    status: "loading",
    account: null,
    requiresOpenAiAuth: false,
    ...patch,
  });

  describe("resolveRailAccountState", () => {
    test("loads until Nodex has heard about the account", () => {
      expect(resolveRailAccountState(null, undefined)).toEqual({ kind: "loading" });
      expect(resolveRailAccountState(null, { status: "starting", retries: 0 })).toEqual({
        kind: "loading",
      });
      expect(resolveRailAccountState(snapshot({}), connected)).toEqual({ kind: "loading" });
      // An endpoint that has never connected has not started yet; it has not failed.
      expect(resolveRailAccountState(null, { status: "disconnected", retries: 0 })).toEqual({
        kind: "loading",
      });
    });

    test("shows a known account, or sign-in once the account is known to be signed out", () => {
      expect(
        resolveRailAccountState(
          snapshot({
            status: "ready",
            account: { type: "chatgpt", email: "a@example.com", planType: "pro" },
          }),
          connected,
        ),
      ).toEqual({ kind: "signedIn" });
      expect(
        resolveRailAccountState(snapshot({ status: "ready", requiresOpenAiAuth: true }), connected),
      ).toEqual({ kind: "signedOut" });
      expect(
        resolveRailAccountState(null, {
          status: "error",
          retries: 0,
          message: "Login required",
          error: { code: "login-required" },
        }),
      ).toEqual({ kind: "signedOut" });
    });

    test("explains why an unknown account cannot load", () => {
      expect(resolveRailAccountState(snapshot({ status: "unavailable" }), connected)).toEqual({
        kind: "unavailable",
        reason: "Can't reach your Codex account",
      });
      expect(resolveRailAccountState(null, { status: "missingBinary", retries: 0 })).toEqual({
        kind: "unavailable",
        reason: "Codex is not installed",
      });
      expect(
        resolveRailAccountState(null, { status: "disconnected", retries: 2, lastConnectedAt: 1 }),
      ).toEqual({ kind: "unavailable", reason: "Codex disconnected" });
    });

    test("keeps showing a known account while a later read fails", () => {
      expect(
        resolveRailAccountState(
          snapshot({
            status: "unavailable",
            account: { type: "chatgpt", email: "a@example.com", planType: "pro" },
          }),
          connected,
        ),
      ).toEqual({ kind: "signedIn" });
    });
  });
});
