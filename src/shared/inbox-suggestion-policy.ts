import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { InboxSettings } from "./inbox";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];
type UsageWindow = NonNullable<Provider["usageLimits"]>["windows"][number];

/** How a usage window is going: room to spare, on track, running short, or used up. */
export type InboxBudgetPace = "ample" | "steady" | "tight" | "spent";

const HOUR_MS = 3_600_000;

/**
 * Compares the share of a window left with the share of its time left. A window that has
 * spent more than its time is tight; one with plenty in hand is ample.
 */
export function inboxBudgetPace(
  leftPercent: number,
  timeLeftFraction: number | null,
): InboxBudgetPace {
  if (leftPercent <= 2) return "spent";
  if (timeLeftFraction === null || timeLeftFraction <= 0)
    return leftPercent >= 50 ? "ample" : "steady";
  const ratio = leftPercent / 100 / timeLeftFraction;
  if (ratio >= 1.25) return "ample";
  if (ratio >= 0.8) return "steady";
  return "tight";
}

/** One usage window as it reads at `now`. */
export interface InboxUsageReading {
  readonly window: UsageWindow;
  /** Share of the window left, 0 to 100. */
  readonly leftPercent: number;
  /** Null when the Agent does not say when the window resets. */
  readonly resetsInHours: number | null;
  readonly pace: InboxBudgetPace;
}

export function inboxUsageReading(window: UsageWindow, now: number): InboxUsageReading {
  const leftPercent = Math.max(0, Math.min(100, 100 - window.usedPercent));
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const resetsInHours = Number.isFinite(resetsAt) ? Math.max(0, (resetsAt - now) / HOUR_MS) : null;
  const durationHours = window.windowDurationMins ? window.windowDurationMins / 60 : null;
  return {
    window,
    leftPercent,
    resetsInHours,
    pace: inboxBudgetPace(
      leftPercent,
      resetsInHours !== null && durationHours ? Math.min(1, resetsInHours / durationHours) : null,
    ),
  };
}

/** Why automatic suggestions stepped back: the suggestion Agent's most constrained window. */
export interface InboxSuggestionPause {
  readonly pace: "tight" | "spent";
  /** The suggestion Agent as the user knows it. */
  readonly agent: string;
  /** The window's own label, such as `Weekly`. */
  readonly window: string;
  /** Rounded share of the window left. */
  readonly leftPercent: number;
  readonly resetsAt: string | null;
}

/**
 * Below this share left, a window spending faster than its time is about to run out, and
 * background spending stops adding to it. Above it, a fast pace alone pauses nothing: suggestions
 * are a small share of what an Agent spends.
 */
const PAUSE_BELOW_LEFT_PERCENT = 10;

/**
 * Automatic suggestions are background spending, so they yield once the suggestion Agent's usage
 * is used up, or is running out fast and nearly gone. A window whose reset time has passed has
 * refilled since it was read.
 */
export function inboxSuggestionPause(
  provider: Provider | undefined,
  now: number,
): InboxSuggestionPause | null {
  const windows = provider?.usageLimits?.windows ?? [];
  const constrained = windows
    .filter((window) => !window.resetsAt || Date.parse(window.resetsAt) > now)
    .map((window) => inboxUsageReading(window, now))
    .filter(
      (reading) =>
        reading.pace === "spent" ||
        (reading.pace === "tight" && reading.leftPercent < PAUSE_BELOW_LEFT_PERCENT),
    )
    .sort(
      (left, right) =>
        Number(right.pace === "spent") - Number(left.pace === "spent") ||
        left.leftPercent - right.leftPercent,
    );
  const reading = constrained[0];
  if (!provider || !reading) return null;
  return {
    pace: reading.pace === "spent" ? "spent" : "tight",
    agent: provider.displayName ?? provider.instanceId,
    window: reading.window.label,
    leftPercent: Math.round(reading.leftPercent),
    resetsAt: reading.window.resetsAt ?? null,
  };
}

/**
 * What suggestions do right now. Main asks Core for automatic advice only while this is
 * `automatic`; the user can still ask for advice while it is `paused` or `on_request`.
 */
export type InboxSuggestionPolicy =
  | { readonly kind: "automatic" }
  | { readonly kind: "paused"; readonly pause: InboxSuggestionPause }
  | { readonly kind: "on_request" }
  | { readonly kind: "off" };

export function inboxSuggestionPolicy(
  settings: Pick<InboxSettings, "suggestions" | "suggestionAgent">,
  providers: readonly Provider[],
  now: number,
): InboxSuggestionPolicy {
  if (settings.suggestions !== "automatic") return { kind: settings.suggestions };
  const pause = inboxSuggestionPause(
    providers.find((provider) => provider.instanceId === settings.suggestionAgent.instanceId),
    now,
  );
  return pause ? { kind: "paused", pause } : { kind: "automatic" };
}

/** Whether the user can ask for advice: every mode but `off`. */
export const inboxSuggestionsOffered = (policy: InboxSuggestionPolicy): boolean =>
  policy.kind !== "off";
