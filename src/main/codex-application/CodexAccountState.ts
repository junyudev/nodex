import type {
  CodexAccountIdentity,
  CodexAccountSnapshot,
  CodexRateLimitResetCredit,
  CodexRateLimitResetCreditsSummary,
  CodexRateLimitsSnapshot,
} from "../../shared/types";

/** The account before the native endpoint has answered. */
export const loadingAccountSnapshot = (): CodexAccountSnapshot => ({
  status: "loading",
  account: null,
  requiresOpenAiAuth: false,
  pendingLogin: null,
  ...emptyAccountRateLimitState(),
});

/** A known signed-out account: after logout, or when the host requires login. */
export const signedOutAccountSnapshot = (): CodexAccountSnapshot => ({
  ...loadingAccountSnapshot(),
  status: "ready",
  requiresOpenAiAuth: true,
});

/** Everything a usage read decides about the account, including when it last succeeded. */
export type AccountRateLimitState = Pick<
  CodexAccountSnapshot,
  "rateLimits" | "rateLimitResetCredits" | "rateLimitsUpdatedAt" | "rateLimitsReadFailed"
>;

export function emptyAccountRateLimitState(): AccountRateLimitState {
  return {
    rateLimits: null,
    rateLimitResetCredits: null,
    rateLimitsUpdatedAt: null,
    rateLimitsReadFailed: false,
  };
}

/**
 * Folds a sparse `account/rateLimits/updated` notification into the windows last read: omitted
 * values keep what was known, and an update for another metered limit leaves this one alone.
 */
export function mergeRateLimitsUpdate(
  previous: CodexRateLimitsSnapshot | null | undefined,
  update: CodexRateLimitsSnapshot | null,
): CodexRateLimitsSnapshot | null {
  if (!update) return previous ?? null;
  if (!previous) return update;
  if (update.limitId && previous.limitId && update.limitId !== previous.limitId) return previous;
  return {
    limitId: previous.limitId ?? update.limitId,
    limitName: update.limitName ?? previous.limitName,
    primary: update.primary ?? previous.primary,
    secondary: update.secondary ?? previous.secondary,
    credits: update.credits ?? previous.credits,
    planType: update.planType ?? previous.planType,
  };
}

const normalizeTimestamp = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return Date.now();
  if (value > 10_000_000_000) return Math.floor(value);
  return Math.floor(value * 1000);
};

export const parseRateLimitsSnapshot = (value: unknown): CodexRateLimitsSnapshot | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const window = (raw: unknown): CodexRateLimitsSnapshot["primary"] => {
    if (typeof raw !== "object" || raw === null) return undefined;
    const record = raw as Record<string, unknown>;
    return {
      usedPercent: typeof record.usedPercent === "number" ? record.usedPercent : 0,
      windowDurationMins:
        typeof record.windowDurationMins === "number" ? record.windowDurationMins : undefined,
      resetsAt:
        typeof record.resetsAt === "number" ? normalizeTimestamp(record.resetsAt) : undefined,
    };
  };
  const credits =
    typeof candidate.credits === "object" && candidate.credits !== null
      ? {
          hasCredits: Boolean((candidate.credits as Record<string, unknown>).hasCredits),
          unlimited: Boolean((candidate.credits as Record<string, unknown>).unlimited),
          balance:
            typeof (candidate.credits as Record<string, unknown>).balance === "string"
              ? ((candidate.credits as Record<string, unknown>).balance as string)
              : undefined,
        }
      : undefined;
  return {
    limitId: typeof candidate.limitId === "string" ? candidate.limitId : undefined,
    limitName: typeof candidate.limitName === "string" ? candidate.limitName : undefined,
    primary: window(candidate.primary),
    secondary: window(candidate.secondary),
    credits,
    planType: typeof candidate.planType === "string" ? candidate.planType : undefined,
  };
};

const parseNonNegativeInteger = (value: unknown): number | null => {
  const numericValue = typeof value === "bigint" ? Number(value) : value;
  if (typeof numericValue !== "number" || !Number.isSafeInteger(numericValue)) return null;
  return numericValue < 0 ? null : numericValue;
};

const parseRateLimitResetCredit = (value: unknown): CodexRateLimitResetCredit | null => {
  if (typeof value !== "object" || value === null) return null;
  const credit = value as Record<string, unknown>;
  const id = typeof credit.id === "string" ? credit.id.trim() : "";
  const grantedAt = typeof credit.grantedAt === "number" ? credit.grantedAt : null;
  const expiresAt =
    credit.expiresAt === null || typeof credit.expiresAt === "number"
      ? credit.expiresAt
      : undefined;
  const resetType =
    credit.resetType === "codexRateLimits" || credit.resetType === "unknown"
      ? credit.resetType
      : null;
  const status =
    credit.status === "available" ||
    credit.status === "redeeming" ||
    credit.status === "redeemed" ||
    credit.status === "unknown"
      ? credit.status
      : null;
  if (!id || grantedAt === null || !Number.isFinite(grantedAt)) return null;
  if (expiresAt === undefined || (expiresAt !== null && !Number.isFinite(expiresAt))) return null;
  if (resetType === null || status === null) return null;
  return {
    id,
    resetType,
    status,
    grantedAt,
    expiresAt,
    title: typeof credit.title === "string" ? credit.title : null,
    description: typeof credit.description === "string" ? credit.description : null,
  };
};

export const parseRateLimitResetCreditsSummary = (
  value: unknown,
): CodexRateLimitResetCreditsSummary | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const availableCount = parseNonNegativeInteger(candidate.availableCount);
  if (availableCount === null) return null;
  const credits =
    candidate.credits === null
      ? null
      : Array.isArray(candidate.credits)
        ? candidate.credits.flatMap((entry) => {
            const parsed = parseRateLimitResetCredit(entry);
            return parsed ? [parsed] : [];
          })
        : null;
  return { availableCount, credits };
};

export const parseAccountIdentity = (value: unknown): CodexAccountIdentity | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "apiKey") return { type: "apiKey" };
  if (candidate.type !== "chatgpt") return null;
  return {
    type: "chatgpt",
    email: typeof candidate.email === "string" ? candidate.email : "",
    planType: typeof candidate.planType === "string" ? candidate.planType : "unknown",
  };
};
