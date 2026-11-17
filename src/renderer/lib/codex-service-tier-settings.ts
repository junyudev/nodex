import type { CodexModelOption, CodexServiceTier } from "./types";
import {
  fitCodexServiceTierSelection,
  normalizeCodexServiceTier as normalizeSharedCodexServiceTier,
} from "../../shared/codex-service-tier";

export const CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY = "nodex-codex-default-service-tier-v1";

export function normalizeCodexServiceTier(value: unknown): CodexServiceTier {
  return normalizeSharedCodexServiceTier(value);
}

export function readCodexServiceTier(): CodexServiceTier {
  if (typeof localStorage === "undefined") {
    return null;
  }

  try {
    return normalizeCodexServiceTier(localStorage.getItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeCodexServiceTier(value: unknown): CodexServiceTier {
  const normalized = normalizeCodexServiceTier(value);
  if (typeof localStorage === "undefined") {
    return normalized;
  }

  try {
    if (normalized === null) {
      localStorage.removeItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY);
    } else {
      localStorage.setItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY, normalized);
    }
  } catch {
    // Ignore localStorage failures.
  }

  return normalized;
}

export function toServiceTierReportingValue(value: unknown): string {
  return normalizeCodexServiceTier(value) ?? "standard";
}

export function resolveCodexRequestServiceTier<T extends { serviceTier?: CodexServiceTier }>(
  request: T | null | undefined,
  defaultServiceTier: CodexServiceTier,
  model: Pick<CodexModelOption, "serviceTiers"> | undefined,
): CodexServiceTier {
  return fitCodexServiceTierSelection(
    model?.serviceTiers.map((tier) => tier.id),
    request?.serviceTier === undefined ? defaultServiceTier : request.serviceTier,
  );
}

/** Omission inherits the Thread tier; an explicit Standard selection clears it. */
export function buildCodexServiceTierRequestOverride(serviceTier: CodexServiceTier | undefined): {
  serviceTier?: CodexServiceTier;
} {
  return serviceTier !== undefined ? { serviceTier } : {};
}
