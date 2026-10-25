import { describe, expect, test } from "vite-plus/test";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { ClaudeUsageSnapshot } from "../../shared/agent-runtime-api";
import type { CodexAccountSnapshot } from "./types";
import {
  USAGE_READING_STALE_AFTER_MS,
  claudeUsageAccounts,
  claudeUsagePlaceholder,
  codexUsageReading,
  describeUsageMeter,
  describeUsageMeterLabel,
  describeUsageProvenance,
  formatRateLimitResetLabel,
  formatRateLimitWindowLabel,
  formatUsageAge,
  formatUsageCountdown,
  formatUsagePlan,
  getRemainingRateLimitPercent,
  resolveUsageSeverity,
  type UsageReading,
} from "./usage-meter";

type RuntimeProvider = AgentRuntimeOperations["providers.read"]["output"][number];

const HOUR = 60 * 60_000;
const NOW = new Date(2027, 4, 12, 9, 0).getTime();

const reading = (overrides: Partial<UsageReading> = {}): UsageReading => ({
  provider: "claude",
  key: "claude:dev@example.com|",
  title: "Claude",
  account: "dev@example.com",
  plan: "Claude Max",
  metered: true,
  windows: [
    {
      id: "five_hour",
      label: "5-hour",
      usedPercent: 40,
      resetsAt: NOW + 2 * HOUR,
      durationMins: 300,
      scope: "account",
    },
    {
      id: "seven_day",
      label: "Weekly",
      usedPercent: 70,
      resetsAt: NOW + 72 * HOUR,
      durationMins: 7 * 24 * 60,
      scope: "account",
    },
  ],
  observedAt: NOW - 5 * 60_000,
  readFailed: false,
  ...overrides,
});

const read = (
  providers: readonly RuntimeProvider[],
  status: ClaudeUsageSnapshot["status"] = "ready",
): ClaudeUsageSnapshot => ({ status, providers, reason: null });
const claudeReadings = (providers: readonly RuntimeProvider[]) =>
  claudeUsageAccounts(read(providers)).map((account) => account.reading);

const claudeProvider = (overrides: Partial<RuntimeProvider> = {}): RuntimeProvider =>
  ({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    status: "ready",
    checkedAt: new Date(NOW - HOUR).toISOString(),
    auth: { status: "authenticated", email: "dev@example.com", label: "Claude Max", type: "max" },
    usageLimits: {
      checkedAt: new Date(NOW - 10 * 60_000).toISOString(),
      windows: [
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          usedPercent: 10,
          windowDurationMins: 7 * 24 * 60,
        },
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 66,
          resetsAt: new Date(NOW + HOUR).toISOString(),
          windowDurationMins: 300,
        },
      ],
    },
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as RuntimeProvider;

describe("usage formatting", () => {
  test("names quota windows by their duration", () => {
    expect(formatRateLimitWindowLabel(300)).toBe("5-hour");
    expect(formatRateLimitWindowLabel(24 * 60)).toBe("Daily");
    expect(formatRateLimitWindowLabel(7 * 24 * 60)).toBe("Weekly");
    expect(formatRateLimitWindowLabel(14 * 24 * 60)).toBe("2-week");
    expect(formatRateLimitWindowLabel(0)).toBe(null);
  });

  test("names a reset moment only as precisely as it needs", () => {
    expect(formatRateLimitResetLabel(new Date(2027, 4, 12, 15, 40).getTime(), NOW, "en-US")).toBe(
      "3:40 PM",
    );
    expect(formatRateLimitResetLabel(new Date(2027, 4, 13, 8, 5).getTime(), NOW, "en-US")).toBe(
      "Thu 8:05 AM",
    );
    expect(formatRateLimitResetLabel(new Date(2027, 4, 25, 8, 5).getTime(), NOW, "en-US")).toBe(
      "May 25",
    );
    expect(formatRateLimitResetLabel(NOW - 1, NOW, "en-US")).toBe("now");
    expect(formatRateLimitResetLabel(undefined, NOW)).toBe(null);
  });

  test("states ages and countdowns at the precision a glance needs", () => {
    expect(formatUsageAge(NOW - 20_000, NOW)).toBe("just now");
    expect(formatUsageAge(NOW - 12 * 60_000, NOW)).toBe("12 min ago");
    expect(formatUsageAge(NOW - 3 * HOUR, NOW)).toBe("3 h ago");
    expect(formatUsageAge(NOW - 50 * HOUR, NOW)).toBe("2 days ago");
    expect(formatUsageCountdown(NOW + 41 * 60_000 + 1, NOW)).toBe("in 42 min");
    expect(formatUsageCountdown(NOW + 3 * HOUR, NOW)).toBe("in 3 h");
    expect(formatUsageCountdown(NOW + 3 * HOUR + 10 * 60_000, NOW)).toBe("in 3 h 10 min");
    expect(formatUsageCountdown(NOW + 50 * HOUR, NOW)).toBe("in 2 days");
  });

  test("names the plan without repeating the provider", () => {
    expect(formatUsagePlan({ title: "Claude", plan: "Claude Max" })).toBe("Max");
    expect(formatUsagePlan({ title: "Codex", plan: "ChatGPT Pro" })).toBe("ChatGPT Pro");
    expect(formatUsagePlan({ title: "Claude (work)", plan: "Claude Max" })).toBe("Claude Max");
    expect(formatUsagePlan({ title: "Claude", plan: "Claude" })).toBe("Claude");
    expect(formatUsagePlan({ title: "Claude", plan: null })).toBe(null);
  });

  test("clamps remaining percentages and grades how much is left", () => {
    expect(getRemainingRateLimitPercent(-20)).toBe(100);
    expect(getRemainingRateLimitPercent(18.4)).toBe(82);
    expect(getRemainingRateLimitPercent(140)).toBe(0);
    expect([36, 35, 16, 15, 1, 0].map(resolveUsageSeverity)).toEqual([
      "normal",
      "low",
      "low",
      "critical",
      "critical",
      "exhausted",
    ]);
  });
});

describe("usage meter", () => {
  test("the ring follows the account window that runs out first", () => {
    const view = describeUsageMeter(reading(), NOW);
    expect(view.status).toBe("measured");
    expect(view.binding?.id).toBe("seven_day");
    expect(view.binding?.remainingPercent).toBe(30);
    expect(view.binding?.severity).toBe("low");
    expect(view.stale).toBe(false);
    expect(describeUsageMeterLabel(view, NOW)).toBe("Claude usage: 30% left in weekly window");
  });

  test("a model window never stands in for the account's headroom", () => {
    const view = describeUsageMeter(
      reading({
        windows: [
          ...reading().windows,
          {
            id: "seven_day_fable",
            label: "Weekly · Fable",
            usedPercent: 95,
            resetsAt: NOW + 72 * HOUR,
            durationMins: 7 * 24 * 60,
            scope: "model",
          },
        ],
      }),
      NOW,
    );
    expect(view.binding?.id).toBe("seven_day");
    expect(view.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_fable",
    ]);
  });

  test("a window that reset since the reading is unknown, not full", () => {
    const later = NOW + 3 * HOUR;
    const view = describeUsageMeter(reading(), later);
    const session = view.windows.find((window) => window.id === "five_hour");
    expect(session?.state).toBe("elapsed");
    expect(view.binding?.id).toBe("seven_day");

    const allReset = describeUsageMeter(reading(), NOW + 100 * HOUR);
    expect(allReset.status).toBe("unread");
    expect(allReset.binding).toBe(null);
    expect(allReset.windows.every((window) => window.state === "elapsed")).toBe(true);
  });

  test("an old reading is kept but marked stale, and says when it changes next", () => {
    const fresh = describeUsageMeter(reading(), NOW);
    expect(fresh.nextChangeAt).toBe(NOW - 5 * 60_000 + USAGE_READING_STALE_AFTER_MS);

    const stale = describeUsageMeter(reading(), NOW + HOUR);
    expect(stale.stale).toBe(true);
    expect(stale.nextChangeAt).toBe(NOW + 2 * HOUR);
    expect(describeUsageMeterLabel(stale, NOW + HOUR)).toBe(
      "Claude usage: 30% left in weekly window, read 1 h ago",
    );
  });

  test("a spent window says when it comes back", () => {
    const view = describeUsageMeter(
      reading({
        windows: [{ ...reading().windows[0]!, usedPercent: 100, resetsAt: NOW + 42 * 60_000 }],
      }),
      NOW,
    );
    expect(view.binding?.severity).toBe("exhausted");
    expect(describeUsageMeterLabel(view, NOW)).toBe(
      "Claude usage: 5-hour limit reached, resets in 42 min",
    );
  });

  test("unknown and failed readings say so instead of showing a level", () => {
    const never = describeUsageMeter(reading({ windows: [], observedAt: null }), NOW);
    expect(never.status).toBe("unread");
    expect(describeUsageMeterLabel(never, NOW)).toBe("Claude usage not read yet");
    expect(describeUsageProvenance(never, "this Mac", NOW)).toEqual({
      status: "Not read on this Mac yet",
      detail: null,
    });

    const failed = describeUsageMeter(
      reading({ windows: [], observedAt: null, readFailed: true }),
      NOW,
    );
    expect(describeUsageMeterLabel(failed, NOW)).toBe("Claude usage couldn't be read");

    const kept = describeUsageMeter(reading({ readFailed: true }), NOW);
    expect(kept.status).toBe("measured");
    expect(describeUsageProvenance(kept, "this Mac", NOW).status).toBe(
      "Couldn't refresh on this Mac",
    );
  });

  test("provenance separates the account's limits from this computer's reading", () => {
    const view = describeUsageMeter(reading(), NOW);
    expect(describeUsageProvenance(view, "this Mac", NOW)).toEqual({
      status: "Account limits · read on this Mac 5 min ago",
      detail: null,
    });
  });
});

describe("usage readings", () => {
  const codexAccount: CodexAccountSnapshot = {
    status: "ready",
    account: { type: "chatgpt", email: "dev@example.com", planType: "plus" },
    requiresOpenAiAuth: false,
    rateLimits: {
      primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: NOW + HOUR },
      secondary: { usedPercent: 39, windowDurationMins: 7 * 24 * 60 },
    },
    rateLimitsUpdatedAt: NOW,
    rateLimitsReadFailed: false,
  };

  test("a Codex account reads its two windows and plan", () => {
    const codex = codexUsageReading(codexAccount);
    expect(codex?.plan).toBe("ChatGPT Plus");
    expect(codex?.windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ["5-hour", 18],
      ["Weekly", 39],
    ]);
    expect(codex?.observedAt).toBe(NOW);
    expect(codexUsageReading({ ...codexAccount, account: null })).toBe(null);
    const apiKey = codexUsageReading({ ...codexAccount, account: { type: "apiKey" } });
    expect(apiKey?.metered).toBe(false);
    expect(describeUsageMeter(apiKey!, NOW).status).toBe("unmetered");
  });

  test("Claude accounts come from the provider snapshot the Agent already published", () => {
    const [claude] = claudeReadings([claudeProvider()]);
    expect(claude?.plan).toBe("Claude Max");
    expect(claude?.observedAt).toBe(NOW - 10 * 60_000);
    expect(claude?.windows.map((window) => [window.id, window.label, window.scope])).toEqual([
      ["seven_day_fable", "Weekly · Fable", "model"],
      ["five_hour", "5-hour", "account"],
    ]);
    expect(describeUsageMeter(claude!, NOW).binding?.id).toBe("five_hour");
  });

  test("only Claude accounts that can have limits get a meter", () => {
    expect(
      claudeReadings([
        claudeProvider({ enabled: false }),
        claudeProvider({ installed: false }),
        claudeProvider({ auth: { status: "unauthenticated" }, usageLimits: undefined }),
        claudeProvider({
          auth: { status: "authenticated", type: "apiKey", label: "Claude API Key" },
        }),
        claudeProvider({
          usageLimits: {
            checkedAt: new Date(NOW).toISOString(),
            windows: [],
            unavailable: { reason: "unsupported" },
          },
        }),
        { ...claudeProvider(), driver: "codex", instanceId: "codex" } as RuntimeProvider,
      ]),
    ).toEqual([]);
  });

  test("a reading kept through a failed refresh stays dated by its own read and says so", () => {
    const kept = claudeProvider({
      usageLimits: {
        ...claudeProvider().usageLimits!,
        unavailable: { reason: "probeFailed" },
      },
    });
    const [account] = claudeReadings([kept]);
    expect(account?.readFailed).toBe(true);
    expect(account?.observedAt).toBe(NOW - 10 * 60_000);
    expect(describeUsageMeter(account!, NOW).status).toBe("measured");

    // Main could not read at all: everything it kept is marked the same way.
    const [unreachable] = claudeUsageAccounts(read([claudeProvider()], "unavailable"));
    expect(unreachable?.reading.readFailed).toBe(true);
  });

  test("only a snapshot Main has never read holds the Claude slot", () => {
    expect(claudeUsagePlaceholder(null)).toBe(null);
    expect(claudeUsagePlaceholder({ status: "loading", providers: null, reason: null })).toEqual({
      kind: "loading",
    });
    expect(
      claudeUsagePlaceholder({ status: "unavailable", providers: null, reason: "Timed out" }),
    ).toEqual({ kind: "unavailable", reason: "Timed out" });
    expect(
      claudeUsagePlaceholder({ status: "unavailable", providers: [], reason: "Timed out" }),
    ).toBe(null);
  });

  test("a signed-in account without a reading is shown as unread or failed", () => {
    const [unread] = claudeReadings([claudeProvider({ usageLimits: undefined })]);
    expect(unread?.observedAt).toBe(null);
    expect(unread?.readFailed).toBe(false);
    const [failed] = claudeReadings([
      claudeProvider({
        usageLimits: {
          checkedAt: new Date(NOW).toISOString(),
          windows: [],
          unavailable: { reason: "probeFailed" },
        },
      }),
    ]);
    expect(failed?.readFailed).toBe(true);
    expect(describeUsageMeter(failed!, NOW).status).toBe("unread");
  });

  test("instances that read one account share its freshest meter", () => {
    const older = claudeProvider({ instanceId: "claude-a" as RuntimeProvider["instanceId"] });
    const newer = claudeProvider({
      instanceId: "claude-b" as RuntimeProvider["instanceId"],
      displayName: "Claude (work)",
      usageLimits: {
        checkedAt: new Date(NOW).toISOString(),
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 80,
            windowDurationMins: 300,
          },
        ],
      },
    });
    const other = claudeProvider({
      instanceId: "claude-c" as RuntimeProvider["instanceId"],
      auth: { status: "authenticated", email: "other@example.com", label: "Claude Pro" },
    });
    const accounts = claudeUsageAccounts(read([older, newer, other]));
    expect(
      accounts.map(({ reading, instanceIds }) => [
        reading.account,
        reading.observedAt,
        reading.title,
        instanceIds,
      ]),
    ).toEqual([
      ["dev@example.com", NOW, "Claude", ["claude-a", "claude-b"]],
      ["other@example.com", NOW - 10 * 60_000, "Claude", ["claude-c"]],
    ]);
  });
});
