import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { PlanType } from "@nodex/codex-app-server-protocol";
import type { ClaudeUsageSnapshot } from "../../shared/agent-runtime-api";
import {
  claudeUsageReadAt,
  hasClaudeSubscriptionLimits,
  meteredClaudeProviders,
} from "../../shared/claude-usage";
import type { CodexAccountSnapshot, CodexRateLimitsSnapshot } from "./types";

/**
 * One account's subscription usage, normalized across providers so Codex and Claude share one
 * meter. A reading only ever states what a provider reported: windows whose reset has passed
 * since the reading are unknown, never assumed to be full.
 */
export type UsageProvider = "codex" | "claude";

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
}

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
}

/** After this long a reading may no longer describe the account; it is shown, but dimmed. */
export const USAGE_READING_STALE_AFTER_MS = 30 * 60_000;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = MINUTES_PER_DAY * MS_PER_MINUTE;

export function formatRateLimitWindowLabel(windowDurationMins?: number | null): string | null {
  if (!windowDurationMins || windowDurationMins <= 0) return null;

  const minutes = Math.round(windowDurationMins);
  if (minutes >= MINUTES_PER_WEEK) {
    const weeks = Math.max(1, Math.round(minutes / MINUTES_PER_WEEK));
    return weeks === 1 ? "Weekly" : `${weeks}-week`;
  }
  if (minutes >= MINUTES_PER_DAY) {
    const days = Math.round(minutes / MINUTES_PER_DAY);
    return days === 1 ? "Daily" : `${days}-day`;
  }
  if (minutes >= MINUTES_PER_HOUR) return `${Math.round(minutes / MINUTES_PER_HOUR)}-hour`;
  return `${minutes}-minute`;
}

/**
 * Names a moment as precisely as it needs to be: a time today, a weekday and time within the
 * surrounding week, otherwise a date.
 */
export function formatUsageMoment(at: number, now: number = Date.now(), locale?: string): string {
  const time = { hour: "numeric", minute: "2-digit" } as const;
  if (new Date(at).toDateString() === new Date(now).toDateString()) {
    return new Intl.DateTimeFormat(locale, time).format(at);
  }
  if (Math.abs(at - now) < 6 * MS_PER_DAY) {
    return new Intl.DateTimeFormat(locale, { weekday: "short", ...time }).format(at);
  }
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(at);
}

export function formatRateLimitResetLabel(
  resetsAt?: number | null,
  now: number = Date.now(),
  locale?: string,
): string | null {
  if (!resetsAt) return null;
  if (resetsAt <= now) return "now";
  return formatUsageMoment(resetsAt, now, locale);
}

/** A short distance to a future moment: `in 42 min`, `in 3 h 10 min`, `in 2 days`. */
export function formatUsageCountdown(at: number, now: number = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((at - now) / MS_PER_MINUTE));
  if (minutes < MINUTES_PER_HOUR) return `in ${minutes} min`;
  if (minutes < MINUTES_PER_DAY) {
    const hours = Math.floor(minutes / MINUTES_PER_HOUR);
    const rest = minutes % MINUTES_PER_HOUR;
    return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
  }
  const days = Math.round(minutes / MINUTES_PER_DAY);
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

/** How long ago a reading was taken: `just now`, `12 min ago`, `3 h ago`, `2 days ago`. */
export function formatUsageAge(observedAt: number, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - observedAt);
  if (elapsed < MS_PER_MINUTE) return "just now";
  if (elapsed < MS_PER_HOUR) return `${Math.floor(elapsed / MS_PER_MINUTE)} min ago`;
  if (elapsed < MS_PER_DAY) return `${Math.floor(elapsed / MS_PER_HOUR)} h ago`;
  const days = Math.floor(elapsed / MS_PER_DAY);
  return days === 1 ? "1 day ago" : `${days} days ago`;
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
  };
}

/** What the rail announces for one meter; the card carries the rest. */
export function describeUsageMeterLabel(view: UsageMeterView, now: number = Date.now()): string {
  const { reading, binding } = view;
  if (view.status === "unmetered") {
    return `${reading.title}: ${reading.plan ?? "this account"} has no usage limits`;
  }
  if (!binding) {
    return `${reading.title} usage ${reading.readFailed ? "couldn't be read" : "not read yet"}`;
  }
  const level =
    binding.severity === "exhausted"
      ? `${binding.label.toLowerCase()} limit reached${
          binding.resetsAt ? `, resets ${formatUsageCountdown(binding.resetsAt, now)}` : ""
        }`
      : `${binding.remainingPercent}% left in ${binding.label.toLowerCase()} window`;
  const age =
    view.stale && reading.observedAt !== null
      ? `, read ${formatUsageAge(reading.observedAt, now)}`
      : "";
  return `${reading.title} usage: ${level}${age}`;
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
          status: `Couldn't refresh on ${hostLabel}`,
          detail: `Showing the reading from ${formatUsageMoment(reading.observedAt, now)}.`,
        }
      : { status: `Couldn't read usage on ${hostLabel}`, detail: null };
  }
  if (view.status !== "measured" && reading.observedAt === null) {
    return { status: `Not read on ${hostLabel} yet`, detail: null };
  }
  const age = reading.observedAt === null ? "" : ` ${formatUsageAge(reading.observedAt, now)}`;
  return { status: `Account limits · read on ${hostLabel}${age}`, detail: null };
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
      plan: "OpenAI API key",
      metered: false,
      windows: [],
      observedAt: null,
      readFailed: false,
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

function claudeReading(provider: RuntimeProvider, readFailed: boolean): UsageReading {
  const limits = provider.usageLimits;
  const auth = provider.auth;
  const windows = (limits?.windows ?? []).map((window): UsageWindowReading => {
    const scope = CLAUDE_ACCOUNT_WINDOWS.has(window.id) ? "account" : "model";
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
    provider: "claude",
    key: `claude:${identity}`,
    title: provider.displayName ?? "Claude",
    account: auth.email ?? null,
    plan: auth.label ?? null,
    metered: hasClaudeSubscriptionLimits(provider),
    windows,
    observedAt: claudeUsageReadAt(provider),
    readFailed: readFailed || limits?.unavailable?.reason === "probeFailed",
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
    const reading = claudeReading(provider, readFailed);
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
