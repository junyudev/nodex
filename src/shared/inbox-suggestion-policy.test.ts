import { describe, expect, it } from "vitest";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { DEFAULT_INBOX_SETTINGS } from "./inbox";
import {
  inboxBudgetPace,
  inboxUsageReading,
  inboxSuggestionPause,
  inboxSuggestionPolicy,
  inboxSuggestionsOffered,
  type InboxSuggestionPolicy,
} from "./inbox-suggestion-policy";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];
type UsageWindow = NonNullable<Provider["usageLimits"]>["windows"][number];
const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const hoursFromNow = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const window = (overrides: Partial<UsageWindow> = {}): UsageWindow => ({
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 70,
  resetsAt: hoursFromNow(130),
  windowDurationMins: 7 * 24 * 60,
  ...overrides,
});
const provider: Provider = {
  instanceId: "codex",
  displayName: "Codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: hoursFromNow(0),
  models: [],
  slashCommands: [],
  skills: [],
};
const withWindows = (...windows: UsageWindow[]): Provider => ({
  ...provider,
  usageLimits: { checkedAt: hoursFromNow(0), windows },
});

// Pace is shared by background admission and the model guidance given to suggestions.
describe("Inbox budget pace", () => {
  it.each([
    [80, 0.5, "ample"],
    [50, 0.5, "steady"],
    [20, 0.8, "tight"],
    [1, 0.1, "spent"],
    [2, null, "spent"],
    [2.01, null, "steady"],
    [50, null, "ample"],
    [49, 0, "steady"],
    [40, 0.5, "steady"],
    [39.99, 0.5, "tight"],
    [62.5, 0.5, "ample"],
    [62.49, 0.5, "steady"],
  ] as const)("reads %s%% left with time fraction %s as %s", (left, time, expected) => {
    expect(inboxBudgetPace(left, time)).toBe(expected);
  });

  it("reads bounded remaining usage and time from a provider window", () => {
    expect(inboxUsageReading(window(), NOW)).toMatchObject({
      leftPercent: 30,
      resetsInHours: 130,
      pace: "tight",
    });
    expect(inboxUsageReading(window({ usedPercent: 105 }), NOW).leftPercent).toBe(0);
    expect(inboxUsageReading(window({ usedPercent: -5 }), NOW).leftPercent).toBe(100);
    expect(inboxUsageReading(window({ resetsAt: undefined }), NOW)).toMatchObject({
      resetsInHours: null,
      pace: "steady",
    });
  });
});

describe("Inbox suggestion policy", () => {
  it("allows automatic advice when no usage data is known", () => {
    expect(inboxSuggestionPolicy(DEFAULT_INBOX_SETTINGS, [provider], NOW)).toEqual({
      kind: "automatic",
    });
    expect(inboxSuggestionPause(withWindows(), NOW)).toBeNull();
  });

  it("keeps automatic advice while a fast window still has more than 10% left", () => {
    // 30% left with most of the week to go is spending fast, but far from running out.
    expect(inboxUsageReading(window(), NOW).pace).toBe("tight");
    expect(inboxSuggestionPolicy(DEFAULT_INBOX_SETTINGS, [withWindows(window())], NOW)).toEqual({
      kind: "automatic",
    });
    expect(inboxSuggestionPause(withWindows(window({ usedPercent: 90 })), NOW)).toBeNull();
  });

  it("pauses automatic advice once a fast window is under 10% left", () => {
    expect(
      inboxSuggestionPolicy(
        DEFAULT_INBOX_SETTINGS,
        [withWindows(window({ usedPercent: 92 }))],
        NOW,
      ),
    ).toEqual({
      kind: "paused",
      pause: {
        pace: "tight",
        agent: "Codex",
        window: "Weekly",
        leftPercent: 8,
        resetsAt: hoursFromNow(130),
      },
    });
  });

  it("pauses on a spent window whatever its pace", () => {
    expect(
      inboxSuggestionPause(
        withWindows(window({ usedPercent: 99, resetsAt: hoursFromNow(1) })),
        NOW,
      ),
    ).toMatchObject({ pace: "spent", leftPercent: 1 });
  });

  it("gives a spent window priority over a tight window", () => {
    expect(
      inboxSuggestionPause(
        withWindows(window({ usedPercent: 95 }), window({ label: "Session", usedPercent: 98 })),
        NOW,
      ),
    ).toMatchObject({ pace: "spent", window: "Session", leftPercent: 2 });
  });

  it("uses the lowest remaining share among constrained windows regardless of order", () => {
    const weekly = window({ usedPercent: 93 });
    const session = window({ label: "Session", usedPercent: 95 });
    for (const windows of [
      [weekly, session],
      [session, weekly],
    ])
      expect(inboxSuggestionPause(withWindows(...windows), NOW)).toMatchObject({
        window: "Session",
        leftPercent: 5,
      });
  });

  it("ignores windows at or past their reset time", () => {
    expect(
      inboxSuggestionPolicy(
        DEFAULT_INBOX_SETTINGS,
        [
          withWindows(
            window({ resetsAt: hoursFromNow(-1), usedPercent: 100 }),
            window({ resetsAt: hoursFromNow(0), usedPercent: 100 }),
          ),
        ],
        NOW,
      ),
    ).toEqual({ kind: "automatic" });
  });

  it("uses only the suggestion Agent's usage and allows an Agent missing from the catalog", () => {
    const other = { ...withWindows(window()), instanceId: "another-agent" };
    expect(inboxSuggestionPolicy(DEFAULT_INBOX_SETTINGS, [other], NOW)).toEqual({
      kind: "automatic",
    });
    expect(inboxSuggestionPolicy(DEFAULT_INBOX_SETTINGS, [], NOW)).toEqual({ kind: "automatic" });
  });

  it.each(["on_request", "off"] as const)("keeps %s regardless of usage", (suggestions) => {
    expect(
      inboxSuggestionPolicy(
        { ...DEFAULT_INBOX_SETTINGS, suggestions },
        [withWindows(window())],
        NOW,
      ),
    ).toEqual({ kind: suggestions });
  });

  it("offers explicit advice in every policy except off", () => {
    const paused = inboxSuggestionPolicy(DEFAULT_INBOX_SETTINGS, [withWindows(window())], NOW);
    for (const policy of [
      paused,
      { kind: "automatic" },
      { kind: "on_request" },
    ] satisfies InboxSuggestionPolicy[])
      expect(inboxSuggestionsOffered(policy)).toBe(true);
    expect(inboxSuggestionsOffered({ kind: "off" })).toBe(false);
  });
});
