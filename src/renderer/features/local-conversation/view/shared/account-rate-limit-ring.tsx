import { useCallback, useRef, useState } from "react";
import { NodexHoverCard } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import type {
  CodexAccountSnapshot,
  CodexConnectionState,
  CodexRateLimitResetInput,
  CodexRateLimitResetResult,
} from "../../../../lib/types";
import { shouldRefreshAccountOnConnectionTooltipOpen } from "./account-tooltip-refresh";
import { buildRateLimitViewModel, type RateLimitWindowView } from "./auth-rate-limits";
import { ConnectionAccountCard } from "./auth-controls";

interface AccountRateLimitRingProps {
  account: CodexAccountSnapshot | null;
  connection: CodexConnectionState;
  onRefreshAccount: () => Promise<CodexAccountSnapshot>;
  onConsumeRateLimitReset?: (input: CodexRateLimitResetInput) => Promise<CodexRateLimitResetResult>;
  onLogout: () => Promise<void>;
  onErrorMessage?: (message: string | null) => void;
  className?: string;
}

const OUTER_RING_RADIUS = 10.5;
const INNER_RING_RADIUS = 6.5;
const OUTER_RING_CIRCUMFERENCE = 2 * Math.PI * OUTER_RING_RADIUS;
const INNER_RING_CIRCUMFERENCE = 2 * Math.PI * INNER_RING_RADIUS;

function resolveRingDashOffset(remainingPercent: number, circumference: number): number {
  return circumference * (1 - remainingPercent / 100);
}

function formatDashValue(value: number): string {
  return value.toFixed(3);
}

function connectionFallbackLabel(connection: CodexConnectionState): string {
  if (connection.status === "starting")
    return "Agent runtime connecting. Usage remaining unavailable";
  if (connection.status === "missingBinary")
    return "Codex CLI missing. Usage remaining unavailable";
  if (connection.status === "error")
    return "Agent runtime connection error. Usage remaining unavailable";
  if (connection.status === "disconnected")
    return "Agent runtime disconnected. Usage remaining unavailable";
  return "Usage remaining unavailable";
}

function RateLimitRingSvg({
  outer,
  inner,
  hasLimits,
}: {
  outer: RateLimitWindowView | null;
  inner: RateLimitWindowView | null;
  hasLimits: boolean;
}) {
  return (
    <svg
      viewBox="0 0 28 28"
      className="size-5.5 shrink-0 overflow-visible"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="14"
        cy="14"
        r={OUTER_RING_RADIUS}
        stroke="var(--sidebar-foreground-tertiary)"
        strokeWidth="2.2"
        opacity={hasLimits ? 0.22 : 0.16}
      />
      {outer ? (
        <circle
          data-rate-limit-ring="outer"
          cx="14"
          cy="14"
          r={OUTER_RING_RADIUS}
          stroke={outer.color}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeDasharray={formatDashValue(OUTER_RING_CIRCUMFERENCE)}
          strokeDashoffset={formatDashValue(
            resolveRingDashOffset(outer.remainingPercent, OUTER_RING_CIRCUMFERENCE),
          )}
          transform="rotate(-90 14 14)"
        />
      ) : null}
      <circle
        cx="14"
        cy="14"
        r={INNER_RING_RADIUS}
        stroke="var(--sidebar-foreground-tertiary)"
        strokeWidth="2"
        opacity={hasLimits ? 0.18 : 0.12}
      />
      {inner ? (
        <circle
          data-rate-limit-ring="inner"
          cx="14"
          cy="14"
          r={INNER_RING_RADIUS}
          stroke={inner.color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={formatDashValue(INNER_RING_CIRCUMFERENCE)}
          strokeDashoffset={formatDashValue(
            resolveRingDashOffset(inner.remainingPercent, INNER_RING_CIRCUMFERENCE),
          )}
          transform="rotate(-90 14 14)"
        />
      ) : null}
      {!hasLimits ? (
        <circle cx="14" cy="14" r="2" fill="var(--sidebar-foreground-tertiary)" opacity={0.55} />
      ) : null}
    </svg>
  );
}

export function AccountRateLimitRing({
  account,
  connection,
  onRefreshAccount,
  onConsumeRateLimitReset,
  onLogout,
  onErrorMessage,
  className,
}: AccountRateLimitRingProps) {
  const [isSigningOut, setIsSigningOut] = useState(false);
  const refreshInFlightRef = useRef(false);
  const authenticatedAccount = account?.account ?? null;

  const handleTooltipOpenChange = useCallback(
    (isOpen: boolean) => {
      if (
        !shouldRefreshAccountOnConnectionTooltipOpen({
          isOpen,
          hasAccount: Boolean(account?.account),
          refreshInFlight: refreshInFlightRef.current,
        })
      ) {
        return;
      }

      refreshInFlightRef.current = true;
      void onRefreshAccount()
        .catch(() => {})
        .finally(() => {
          refreshInFlightRef.current = false;
        });
    },
    [account?.account, onRefreshAccount],
  );

  const handleLogout = useCallback(async () => {
    setIsSigningOut(true);
    onErrorMessage?.(null);
    try {
      await onLogout();
    } catch (error) {
      onErrorMessage?.(error instanceof Error ? error.message : "Logout failed");
    } finally {
      setIsSigningOut(false);
    }
  }, [onErrorMessage, onLogout]);

  if (!authenticatedAccount) return null;

  const viewModel = buildRateLimitViewModel(account?.rateLimits);
  const ariaLabel =
    viewModel.hasLimits && connection.status === "connected"
      ? viewModel.ariaLabel
      : connectionFallbackLabel(connection);
  return (
    <NodexHoverCard
      ariaLabel="Account and usage details"
      hoverCardContent={
        <ConnectionAccountCard
          account={authenticatedAccount}
          rateLimits={account?.rateLimits}
          rateLimitResetCredits={account?.rateLimitResetCredits}
          onConsumeRateLimitReset={onConsumeRateLimitReset}
          onSignOut={() => void handleLogout()}
          isSigningOut={isSigningOut}
        />
      }
      placement="right-end"
      onOpenChange={handleTooltipOpenChange}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        data-testid="sidebar-account-rate-limit-ring"
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-lg outline-none",
          "text-(--sidebar-foreground-secondary) hover:bg-(--sidebar-accent) hover:text-(--sidebar-foreground)",
          "focus-visible:bg-(--sidebar-accent) focus-visible:ring-2 focus-visible:ring-(--sidebar-ring)/35",
          !viewModel.hasLimits && "opacity-70",
          className,
        )}
      >
        <RateLimitRingSvg
          outer={viewModel.outer}
          inner={viewModel.inner}
          hasLimits={viewModel.hasLimits}
        />
      </button>
    </NodexHoverCard>
  );
}
