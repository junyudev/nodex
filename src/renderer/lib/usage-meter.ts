import { getIntl } from "@/lib/i18n";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { PlanType } from "@nodex/codex-app-server-protocol";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import type { ClaudeUsageSnapshot } from "../../shared/agent-runtime-api";
import { hasClaudeSubscriptionLimits, meteredClaudeProviders } from "../../shared/claude-usage";
import type { CodexAccountSnapshot, CodexRateLimitsSnapshot } from "./types";
import { agentRuntimeProviderBackendKind } from "./agent-runtime-model-selection";

/**
 * One account's subscription usage, normalized across Agent backends for one shared meter.
 * A reading only ever states what a provider reported: windows whose reset has passed since
 * the reading are unknown, never assumed to be full.
 */
export type UsageProvider = AgentBackendBinding["kind"];

export interface UsageWindowReading {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  /** Epoch milliseconds; null when the provider did not say. */
  readonly resetsAt: number | null;
  readonly durationMins: number | null;
  /** Account windows limit every request; model windows limit only that model's requests. */
  readonly scope: "account" | "model";
}

export interface UsageReading {
  readonly provider: UsageProvider;
  /** Identifies the account whose quota this is, so two readers of one account share a meter. */
  readonly key: string;
  readonly title: string;
  readonly account: string | null;
  readonly plan: string | null;
  /** False when the account has no subscription windows at all, such as an API key. */
  readonly metered: boolean;
  readonly windows: readonly UsageWindowReading[];
  /** Epoch milliseconds when `windows` was read; null when that is unknown. */
  readonly observedAt: number | null;
  /** The latest read failed; `windows` is the previous reading, if there was one. */
  readonly readFailed: boolean;
  /** Prepaid credits that carry the account past a used-up window; null when it has none. */
  readonly credits: UsageCredits | null;
}

/** A positive balance, or an account whose credits never run out. */
export type UsageCredits = number | "unlimited";

export type UsageSeverity = "normal" | "low" | "critical" | "exhausted";

export type UsageWindowView = UsageWindowReading &
  (
    | {
        readonly state: "measured";
        readonly remainingPercent: number;
        readonly severity: UsageSeverity;
      }
    /** The window reset after the reading, so its current level is unknown. */
    | { readonly state: "elapsed" }
  );

export type MeasuredUsageWindowView = Extract<UsageWindowView, { state: "measured" }>;

export interface UsageMeterView {
  readonly reading: UsageReading;
  /**
   * `measured`: at least one window still describes now. `unread`: nothing current is known.
   * `unmetered`: the account has no subscription windows.
   */
  readonly status: "measured" | "unread" | "unmetered";
  /** The account window with the least left: the one that stops work first. */
  readonly binding: MeasuredUsageWindowView | null;
  readonly windows: readonly UsageWindowView[];
  /** The reading is old enough that use elsewhere on the account may have moved it. */
  readonly stale: boolean;
  /** The next moment this view changes without new data: a reset or the reading going stale. */
  readonly nextChangeAt: number | null;
  /** The window that stops work first is used up, and credits are carrying the account past it. */
  readonly creditsInUse: boolean;
}

/** After this long a reading may no longer describe the account; it is shown, but dimmed. */
export const USAGE_READING_STALE_AFTER_MS = 30 * 60_000;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const MINUTES_PER_MONTH = 30 * MINUTES_PER_DAY;
/** Calendar months run 28 to 31 days; anything shorter is counted in weeks. */
const MINUTES_PER_MONTH_MIN = 28 * MINUTES_PER_DAY;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = MINUTES_PER_DAY * MS_PER_MINUTE;

export function formatRateLimitWindowLabel(windowDurationMins?: number | null): string | null {
  if (!windowDurationMins || windowDurationMins <= 0) return null;

  const minutes = Math.round(windowDurationMins);
  if (minutes >= MINUTES_PER_MONTH_MIN) {
    const months = Math.max(1, Math.round(minutes / MINUTES_PER_MONTH));
    return months === 1
      ? getIntl().formatMessage({ id: "lib.usageMeter.monthly", defaultMessage: "Monthly" })
      : getIntl().formatMessage(
          { id: "lib.usageMeter.monthWindow", defaultMessage: "{count}-month" },
          { count: months },
        );
  }
  if (minutes >= MINUTES_PER_WEEK) {
    const weeks = Math.max(1, Math.round(minutes / MINUTES_PER_WEEK));
    return weeks === 1
      ? getIntl().formatMessage({ id: "lib.usageMeter.weekly", defaultMessage: "Weekly" })
      : getIntl().formatMessage(
          { id: "lib.usageMeter.weekWindow", defaultMessage: "{count}-week" },
          { count: weeks },
        );
  }
  if (minutes >= MINUTES_PER_DAY) {
    const days = Math.round(minutes / MINUTES_PER_DAY);
    return days === 1
      ? getIntl().formatMessage({ id: "lib.usageMeter.daily", defaultMessage: "Daily" })
      : getIntl().formatMessage(
          { id: "lib.usageMeter.dayWindow", defaultMessage: "{count}-day" },
          { count: days },
        );
  }
  if (minutes >= MINUTES_PER_HOUR)
    return getIntl().formatMessage(
      { id: "lib.usageMeter.hourWindow", defaultMessage: "{count}-hour" },
      { count: Math.round(minutes / MINUTES_PER_HOUR) },
    );
  return getIntl().formatMessage(
    { id: "lib.usageMeter.minuteWindow", defaultMessage: "{count}-minute" },
    { count: minutes },
  );
}

/**
 * Names a moment as precisely as it needs to be: a time today, a weekday and time within the
 * surrounding week, otherwise a date.
 */
export function formatUsageMoment(at: number, now: number = Date.now(), locale?: string): string {
  const time = { hour: "numeric", minute: "2-digit" } as const;
  if (new Date(at).toDateString() === new Date(now).toDateString()) {
    return new Intl.DateTimeFormat(locale ?? getIntl().locale, time).format(at);
  }
  if (Math.abs(at - now) < 6 * MS_PER_DAY) {
    return new Intl.DateTimeFormat(locale ?? getIntl().locale, {
      weekday: "short",
      ...time,
    }).format(at);
  }
  return new Intl.DateTimeFormat(locale ?? getIntl().locale, {
    month: "short",
    day: "numeric",
  }).format(at);
}

export function formatRateLimitResetLabel(
  resetsAt?: number | null,
  now: number = Date.now(),
  locale?: string,
): string | null {
  if (!resetsAt) return null;
  if (resetsAt <= now)
    return getIntl().formatMessage({ id: "lib.usageMeter.resetNow", defaultMessage: "now" });
  return formatUsageMoment(resetsAt, now, locale);
}

/** A short distance to a future moment: `in 42 min`, `in 3 h 10 min`, `in 2 days`. */
export function formatUsageCountdown(at: number, now: number = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((at - now) / MS_PER_MINUTE));
  if (minutes < MINUTES_PER_HOUR)
    return getIntl().formatMessage(
      { id: "lib.usageMeter.inMinutes", defaultMessage: "in {count} min" },
      { count: minutes },
    );
  if (minutes < MINUTES_PER_DAY) {
    const hours = Math.floor(minutes / MINUTES_PER_HOUR);
    const rest = minutes % MINUTES_PER_HOUR;
    return rest === 0
      ? getIntl().formatMessage(
          { id: "lib.usageMeter.inHours", defaultMessage: "in {count} h" },
          { count: hours },
        )
      : getIntl().formatMessage(
          { id: "lib.usageMeter.inHoursMinutes", defaultMessage: "in {hours} h {minutes} min" },
          { hours, minutes: rest },
        );
  }
  const days = Math.round(minutes / MINUTES_PER_DAY);
  return days === 1
    ? getIntl().formatMessage({ id: "lib.usageMeter.inOneDay", defaultMessage: "in 1 day" })
    : getIntl().formatMessage(
        { id: "lib.usageMeter.inDays", defaultMessage: "in {count} days" },
        { count: days },
      );
}

/** How long ago a reading was taken: `just now`, `12 min ago`, `3 h ago`, `2 days ago`. */
export function formatUsageAge(observedAt: number, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - observedAt);
  if (elapsed < MS_PER_MINUTE)
    return getIntl().formatMessage({ id: "lib.usageMeter.justNow", defaultMessage: "just now" });
  if (elapsed < MS_PER_HOUR)
    return getIntl().formatMessage(
      { id: "lib.usageMeter.minutesAgo", defaultMessage: "{count} min ago" },
      { count: Math.floor(elapsed / MS_PER_MINUTE) },
    );
  if (elapsed < MS_PER_DAY)
    return getIntl().formatMessage(
      { id: "lib.usageMeter.hoursAgo", defaultMessage: "{count} h ago" },
      { count: Math.floor(elapsed / MS_PER_HOUR) },
    );
  const days = Math.floor(elapsed / MS_PER_DAY);
  return days === 1
    ? getIntl().formatMessage({ id: "lib.usageMeter.oneDayAgo", defaultMessage: "1 day ago" })
    : getIntl().formatMessage(
        { id: "lib.usageMeter.daysAgo", defaultMessage: "{count} days ago" },
        { count: days },
      );
}

export function getRemainingRateLimitPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

export function resolveUsageSeverity(remainingPercent: number): UsageSeverity {
  if (remainingPercent <= 0) return "exhausted";
  if (remainingPercent <= 15) return "critical";
  if (remainingPercent <= 35) return "low";
  return "normal";
}

function compareWindows(left: UsageWindowReading, right: UsageWindowReading): number {
  if (left.scope !== right.scope) return left.scope === "account" ? -1 : 1;
  return (left.durationMins ?? Infinity) - (right.durationMins ?? Infinity);
}

export function describeUsageMeter(
  reading: UsageReading,
  now: number = Date.now(),
): UsageMeterView {
  const windows: UsageWindowView[] = [...reading.windows].sort(compareWindows).map((window) => {
    if (window.resetsAt !== null && window.resetsAt <= now) return { ...window, state: "elapsed" };
    const remainingPercent = getRemainingRateLimitPercent(window.usedPercent);
    return {
      ...window,
      state: "measured",
      remainingPercent,
      severity: resolveUsageSeverity(remainingPercent),
    };
  });
  const measured = windows.filter(
    (window): window is MeasuredUsageWindowView => window.state === "measured",
  );
  const accountWide = measured.filter((window) => window.scope === "account");
  const binding =
    (accountWide.length > 0 ? accountWide : measured).reduce<MeasuredUsageWindowView | null>(
      (least, window) =>
        least === null || window.remainingPercent < least.remainingPercent ? window : least,
      null,
    ) ?? null;
  const status = !reading.metered ? "unmetered" : binding ? "measured" : "unread";
  const staleAt =
    reading.observedAt === null ? null : reading.observedAt + USAGE_READING_STALE_AFTER_MS;
  const stale = status === "measured" && staleAt !== null && staleAt <= now;
  const upcoming = [
    ...(status === "measured" && staleAt !== null && staleAt > now ? [staleAt] : []),
    ...measured.flatMap((window) => (window.resetsAt === null ? [] : [window.resetsAt])),
  ];
  return {
    reading,
    status,
    binding,
    windows,
    stale,
    nextChangeAt: upcoming.length > 0 ? Math.min(...upcoming) : null,
    creditsInUse: binding?.severity === "exhausted" && reading.credits !== null,
  };
}

/** Whole credits, rounded up so a balance that remains never reads as none. */
export function formatUsageCredits(credits: UsageCredits): string {
  return credits === "unlimited"
    ? getIntl().formatMessage({ id: "lib.usageMeter.unlimited", defaultMessage: "Unlimited" })
    : getIntl().formatNumber(Math.ceil(credits));
}

function describeCreditsInUse({ creditsInUse, reading: { credits } }: UsageMeterView): string {
  if (!creditsInUse || credits === null) return "";
  return credits === "unlimited"
    ? getIntl().formatMessage({
        id: "lib.usageMeter.usingCredits",
        defaultMessage: ", using credits",
      })
    : getIntl().formatMessage(
        {
          id: "lib.usageMeter.usingCreditsWithBalance",
          defaultMessage: ", using credits, {balance} left",
        },
        { balance: formatUsageCredits(credits) },
      );
}

/** What the rail announces for one meter; the card carries the rest. */
export function describeUsageMeterLabel(view: UsageMeterView, now: number = Date.now()): string {
  const { reading, binding } = view;
  if (view.status === "unmetered") {
    return getIntl().formatMessage(
      { id: "lib.usageMeter.unmetered", defaultMessage: "{title}: {plan} has no usage limits" },
      {
        title: reading.title,
        plan:
          reading.plan ??
          getIntl().formatMessage({ id: "lib.usageMeter.account", defaultMessage: "this account" }),
      },
    );
  }
  if (!binding) {
    return reading.readFailed
      ? getIntl().formatMessage(
          {
            id: "lib.usageMeter.summaryReadFailed",
            defaultMessage: "{title} usage couldn't be read",
          },
          { title: reading.title },
        )
      : getIntl().formatMessage(
          { id: "lib.usageMeter.summaryNotRead", defaultMessage: "{title} usage not read yet" },
          { title: reading.title },
        );
  }
  const level =
    binding.severity === "exhausted"
      ? binding.resetsAt
        ? getIntl().formatMessage(
            {
              id: "lib.usageMeter.exhaustedReset",
              defaultMessage: "{window} limit reached, resets {countdown}",
            },
            {
              window: binding.label.toLocaleLowerCase(getIntl().locale),
              countdown: formatUsageCountdown(binding.resetsAt, now),
            },
          )
        : getIntl().formatMessage(
            { id: "lib.usageMeter.exhausted", defaultMessage: "{window} limit reached" },
            { window: binding.label.toLocaleLowerCase(getIntl().locale) },
          )
      : getIntl().formatMessage(
          { id: "lib.usageMeter.remaining", defaultMessage: "{percent}% left in {window} window" },
          {
            percent: binding.remainingPercent,
            window: binding.label.toLocaleLowerCase(getIntl().locale),
          },
        );
  const age =
    view.stale && reading.observedAt !== null
      ? getIntl().formatMessage(
          { id: "lib.usageMeter.statusAge", defaultMessage: ", read {age}" },
          { age: formatUsageAge(reading.observedAt, now) },
        )
      : "";
  return getIntl().formatMessage(
    { id: "lib.usageMeter.summary", defaultMessage: "{title} usage: {level}{credits}{age}" },
    { title: reading.title, level, credits: describeCreditsInUse(view), age },
  );
}

/**
 * Where the reading came from and how current it is. The limits belong to the account and count
 * use from every app and device; the reading is only what this computer last saw of them.
 */
export function describeUsageProvenance(
  view: UsageMeterView,
  hostLabel: string,
  now: number = Date.now(),
): { readonly status: string; readonly detail: string | null } {
  const { reading } = view;
  if (reading.readFailed) {
    return view.status === "measured" && reading.observedAt !== null
      ? {
          status: getIntl().formatMessage(
            { id: "lib.usageMeter.refreshFailed", defaultMessage: "Couldn't refresh on {host}" },
            { host: hostLabel },
          ),
          detail: getIntl().formatMessage(
            {
              id: "lib.usageMeter.showingReading",
              defaultMessage: "Showing the reading from {when}.",
            },
            { when: formatUsageMoment(reading.observedAt, now) },
          ),
        }
      : {
          status: getIntl().formatMessage(
            { id: "lib.usageMeter.readFailed", defaultMessage: "Couldn't read usage on {host}" },
            { host: hostLabel },
          ),
          detail: null,
        };
  }
  if (view.status !== "measured" && reading.observedAt === null) {
    return {
      status: getIntl().formatMessage(
        { id: "lib.usageMeter.notRead", defaultMessage: "Not read on {host} yet" },
        { host: hostLabel },
      ),
      detail: null,
    };
  }
  const age = reading.observedAt === null ? "" : ` ${formatUsageAge(reading.observedAt, now)}`;
  return {
    status: getIntl().formatMessage(
      { id: "lib.usageMeter.provenance", defaultMessage: "Account limits · read on {host}{age}" },
      { host: hostLabel, age },
    ),
    detail: null,
  };
}

/** The plan beside the account's title, without repeating it: `Claude` · `Max`, `Codex` · `ChatGPT Pro`. */
export function formatUsagePlan(reading: Pick<UsageReading, "title" | "plan">): string | null {
  const { title, plan } = reading;
  if (!plan) return null;
  const prefix = `${title} `;
  return plan.toLowerCase().startsWith(prefix.toLowerCase()) && plan.length > prefix.length
    ? plan.slice(prefix.length)
    : plan;
}

const CHATGPT_PLAN_LABELS: Readonly<Record<PlanType, string | null>> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  promax: "Pro Max",
  sci: "Academic Researchers",
  sci_plus: "Academic Researchers Plus",
  team: "Team",
  business: "Business",
  self_serve_business_prolite: "Business",
  self_serve_business_usage_based: "Business",
  enterprise: "Enterprise",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
  unknown: null,
};

/** Plans whose credits are the person's own; a workspace's balance is a pool shared with others. */
const PERSONAL_CREDIT_PLANS: ReadonlySet<string> = new Set<PlanType>([
  "free",
  "go",
  "plus",
  "prolite",
  "pro",
  "promax",
]);

function codexCredits(
  planType: string,
  credits: CodexRateLimitsSnapshot["credits"],
): UsageCredits | null {
  if (!credits?.hasCredits || !PERSONAL_CREDIT_PLANS.has(planType)) return null;
  if (credits.unlimited) return "unlimited";
  const balance = Number(credits.balance);
  return Number.isFinite(balance) && balance > 0 ? balance : null;
}

/** Names a ChatGPT plan for display, title-casing plans this build does not know yet. */
export function formatChatGptPlan(planType: string): string {
  const known: Readonly<Record<string, string | null>> = CHATGPT_PLAN_LABELS;
  const label = Object.hasOwn(known, planType)
    ? known[planType]
    : planType
        .split("_")
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
  return label ? `ChatGPT ${label}` : "ChatGPT";
}

function codexWindow(
  id: string,
  window: CodexRateLimitsSnapshot["primary"],
): UsageWindowReading | null {
  const label = formatRateLimitWindowLabel(window?.windowDurationMins);
  if (!window || !label) return null;
  return {
    id,
    label,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt ?? null,
    durationMins: window.windowDurationMins ?? null,
    scope: "account",
  };
}

/** The signed-in Codex account's usage, or null while no account is known. */
export function codexUsageReading(snapshot: CodexAccountSnapshot | null): UsageReading | null {
  const account = snapshot?.account;
  if (!snapshot || !account) return null;
  if (account.type === "apiKey") {
    return {
      provider: "codex",
      key: "codex:api-key",
      title: "Codex",
      account: null,
      plan: getIntl().formatMessage({
        id: "lib.usageMeter.openAiApiKey",
        defaultMessage: "OpenAI API key",
      }),
      metered: false,
      windows: [],
      observedAt: null,
      readFailed: false,
      credits: null,
    };
  }
  const limits = snapshot.rateLimits;
  return {
    provider: "codex",
    key: `codex:${account.email}`,
    title: "Codex",
    account: account.email,
    plan: formatChatGptPlan(account.planType),
    metered: true,
    windows: [
      codexWindow("primary", limits?.primary),
      codexWindow("secondary", limits?.secondary),
    ].filter((window) => window !== null),
    observedAt: snapshot.rateLimitsUpdatedAt ?? null,
    readFailed: snapshot.rateLimitsReadFailed ?? false,
    credits: codexCredits(account.planType, limits?.credits),
  };
}

type RuntimeProvider = AgentRuntimeOperations["providers.read"]["output"][number];

/** Claude's account-wide windows; every other window it reports belongs to one model. */
const CLAUDE_ACCOUNT_WINDOWS = new Set(["five_hour", "seven_day"]);

function epochMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A runtime Agent's catalog usage, retaining only the limits and account identity it reports. */
export function runtimeUsageReading(provider: RuntimeProvider, readFailed: boolean): UsageReading {
  const kind = agentRuntimeProviderBackendKind(provider);
  const limits = provider.usageLimits;
  const auth = provider.auth;
  const windows = (limits?.windows ?? []).map((window): UsageWindowReading => {
    const scope = kind !== "claude" || CLAUDE_ACCOUNT_WINDOWS.has(window.id) ? "account" : "model";
    return {
      id: window.id,
      label:
        scope === "account"
          ? (formatRateLimitWindowLabel(window.windowDurationMins) ?? window.label)
          : window.label,
      usedPercent: window.usedPercent,
      resetsAt: epochMs(window.resetsAt),
      durationMins: window.windowDurationMins ?? null,
      scope,
    };
  });
  const identity =
    auth.email || auth.workspaceId
      ? `${auth.email ?? ""}|${auth.workspaceId ?? ""}`
      : (limits?.credentialFingerprint ?? `instance:${provider.instanceId}`);
  return {
    provider: kind,
    key: `${kind}:${identity}`,
    title: provider.displayName ?? (kind === "claude" ? "Claude" : provider.instanceId),
    account: auth.email ?? null,
    plan: auth.label ?? null,
    // Only Claude says when an account has no subscription limits. Another Agent that reports
    // none, such as an OpenCode server whose credentials Nodex cannot see, is unread, not unmetered.
    metered: kind !== "claude" || hasClaudeSubscriptionLimits(provider),
    windows,
    observedAt: windows.length > 0 ? epochMs(limits?.checkedAt) : null,
    readFailed: readFailed || limits?.unavailable?.reason === "probeFailed",
    // The Agent catalog reports windows only; the signed-in account's own reading has credits.
    credits: null,
  };
}

/** One Claude account's meter and the Agents that read it. */
export interface ClaudeUsageAccount {
  readonly reading: UsageReading;
  readonly instanceIds: readonly string[];
}

/**
 * One meter per Claude subscription account in Main's snapshot. Agents that read one account
 * collapse into its freshest reading; a read that failed marks every reading it kept.
 */
export function claudeUsageAccounts(
  snapshot: ClaudeUsageSnapshot | null | undefined,
): readonly ClaudeUsageAccount[] {
  const readFailed = snapshot?.status === "unavailable";
  const byAccount = new Map<string, ClaudeUsageAccount>();
  for (const provider of meteredClaudeProviders(snapshot?.providers)) {
    const reading = runtimeUsageReading(provider, readFailed);
    const existing = byAccount.get(reading.key);
    if (!existing) {
      byAccount.set(reading.key, { reading, instanceIds: [provider.instanceId] });
      continue;
    }
    const fresher =
      (reading.observedAt ?? -1) > (existing.reading.observedAt ?? -1) ? reading : existing.reading;
    byAccount.set(reading.key, {
      reading: { ...fresher, title: "Claude" },
      instanceIds: [...existing.instanceIds, provider.instanceId],
    });
  }
  return [...byAccount.values()];
}

/** What holds the Claude slot before anything is known: a read in progress, or why it failed. */
export type ClaudeUsagePlaceholder =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly reason: string | null };

export function claudeUsagePlaceholder(
  snapshot: ClaudeUsageSnapshot | null | undefined,
): ClaudeUsagePlaceholder | null {
  if (!snapshot || snapshot.providers !== null) return null;
  if (snapshot.status === "loading") return { kind: "loading" };
  if (snapshot.status === "unavailable") return { kind: "unavailable", reason: snapshot.reason };
  return null;
}
