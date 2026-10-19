import { describe, expect, test } from "vite-plus/test";
import type { CodexAccountSnapshot, CodexConnectionState } from "@/lib/types";
import { resolveRailAccountState } from "./rail-account-state";

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
