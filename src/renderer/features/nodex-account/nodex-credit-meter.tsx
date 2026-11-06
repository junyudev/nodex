import { useEffect, useMemo } from "react";
import { ChevronRightIcon, NodexLogoMarkIcon } from "@/components/shared/icons";
import { NODEX_BUTTON_COLOR_CLASS } from "@/components/ui/button";
import { NodexHoverCard } from "@/components/ui/hover-card";
import { UsageRingGlyph } from "@/components/workbench/workbench-rail-usage-meter";
import type { UsageSeverity } from "@/lib/usage-meter";
import { cn } from "@/lib/utils";
import { resolveNodexAccountView } from "./nodex-account-identity";
import { nodexCreditBalance } from "../../../shared/nodex-account";
import { formatNodexCredits } from "../../../shared/nodex-models";
import { useNodexAccount, useNodexCreditRefreshOnFocus } from "./use-nodex-account";

type Account = ReturnType<typeof useNodexAccount>;

/** Credits as of the last top-up and now; a top-up refills the gauge. */
export interface CreditGauge {
  readonly baseline: number;
  readonly balance: number;
}

export function nextCreditGauge(previous: CreditGauge | null, balance: number): CreditGauge {
  const refilled = !previous || previous.baseline <= 0 || balance > previous.balance + 0.125;
  return { baseline: refilled ? Math.max(balance, 0) : previous.baseline, balance };
}

/** Remaining share since the last top-up, and how loudly the rail should say so. */
export function describeCreditGauge(gauge: CreditGauge) {
  const percent =
    gauge.baseline > 0
      ? Math.round(Math.max(0, Math.min(1, gauge.balance / gauge.baseline)) * 100)
      : 0;
  const severity: UsageSeverity =
    gauge.balance < 1
      ? "exhausted"
      : gauge.balance < 12 || percent <= 10
        ? "critical"
        : gauge.balance < 50 || percent <= 25
          ? "low"
          : "normal";
  return { percent, severity };
}

const GAUGE_KEY_PREFIX = "nodex.credit-gauge:";

function readGauge(key: string): CreditGauge | null {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? "null") as CreditGauge | null;
  } catch {
    return null;
  }
}

/** Keeps the gauge per account across windows and restarts; it is presentation, not a ledger. */
function useCreditGaugeState(accountKey: string | null, balance: number | null) {
  const key = accountKey === null ? null : GAUGE_KEY_PREFIX + accountKey;
  // Each new balance continues from the last persisted gauge, written below after render.
  const gauge = useMemo(
    () => (key === null || balance === null ? null : nextCreditGauge(readGauge(key), balance)),
    [key, balance],
  );
  useEffect(() => {
    if (key !== null && gauge) window.localStorage.setItem(key, JSON.stringify(gauge));
  }, [key, gauge]);
  // Credit this account has held, now or before; a never-funded account has nothing to meter.
  const funded = ((gauge ?? (key === null ? null : readGauge(key)))?.baseline ?? 0) > 0;
  return { gauge, funded };
}

/** The signed-in account's credits gauge, shared by the rail meter and Account settings. */
export function useNodexCreditGauge(account: Account) {
  const identity = account.snapshot?.account;
  return useCreditGaugeState(
    identity ? `${identity.issuer}|${identity.subject}` : null,
    nodexCreditBalance(account.snapshot),
  );
}

export const CREDIT_SEVERITY_TEXT: Readonly<Record<UsageSeverity, string | undefined>> = {
  normal: undefined,
  low: "text-(--yellow-text)",
  critical: "text-(--red-text)",
  exhausted: "text-(--red-text)",
};

/** Credits remaining since the last top-up, drawn like the rail's usage windows. */
export function NodexCreditBar({ gauge }: { readonly gauge: CreditGauge | null }) {
  const level = gauge ? describeCreditGauge(gauge) : null;
  return (
    <div
      role="meter"
      aria-label="Credits remaining since last top-up"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={level?.percent ?? 0}
      className={cn(
        "h-1 overflow-hidden rounded-full",
        level?.severity === "exhausted" ? "bg-(--red-text)/20" : "bg-token-foreground/10",
      )}
    >
      {level && level.percent > 0 ? (
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{
            width: `${level.percent}%`,
            backgroundColor:
              level.severity === "normal"
                ? "var(--color-token-foreground)"
                : level.severity === "low"
                  ? "var(--yellow-text)"
                  : "var(--red-text)",
            opacity: level.severity === "normal" ? 0.55 : 1,
          }}
        />
      ) : null}
    </div>
  );
}

function NodexCreditCard({
  account,
  gauge,
  onOpenAccountSettings,
}: {
  readonly account: Account;
  readonly gauge: CreditGauge | null;
  readonly onOpenAccountSettings: () => void;
}) {
  const view = resolveNodexAccountView(account);
  const level = gauge ? describeCreditGauge(gauge) : null;
  return (
    <div data-nodex-credit-card="" className="flex w-76 flex-col">
      <div className="flex items-center gap-2.5 py-2.5 pr-2 pl-3">
        <NodexLogoMarkIcon monochrome className="size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-token-foreground">Nodex</div>
          {view.identity ? (
            <div className="truncate text-xs text-token-description-foreground">
              {view.identity.detail ?? view.identity.label}
            </div>
          ) : null}
        </div>
      </div>
      <section
        aria-label="Credits"
        className="flex flex-col gap-1.5 border-t border-token-border p-3"
      >
        <div className="flex items-baseline text-xs text-token-description-foreground">
          <span className="text-sm font-medium text-token-foreground">Credits</span>
          <span className="ml-auto tabular-nums">
            <span
              aria-label="Remaining credits"
              className={cn(
                "text-sm font-medium text-token-foreground",
                level && CREDIT_SEVERITY_TEXT[level.severity],
              )}
            >
              {gauge ? formatNodexCredits(gauge.balance) : "—"}
            </span>
            {gauge ? " left" : null}
          </span>
        </div>
        <NodexCreditBar gauge={gauge} />
      </section>
      <div className="border-t border-token-border p-1.5">
        <button
          type="button"
          onClick={onOpenAccountSettings}
          className="flex w-full items-center rounded-md px-1.5 py-1.5 text-sm text-token-foreground outline-none hover:bg-token-list-hover-background focus-visible:bg-token-list-hover-background"
        >
          Top up
          <ChevronRightIcon className="ml-auto size-3.5 text-token-description-foreground" />
        </button>
      </div>
    </div>
  );
}

/**
 * The rail's Nodex credits: the Nodex mark inside a ring that empties as credits since the last
 * top-up is spent, quiet until it runs low. Its card shows the balance and leads to Account
 * settings, where the tiers are bought.
 */
export function NodexCreditMeter({
  onOpenAccountSettings,
  className,
}: {
  readonly onOpenAccountSettings: () => void;
  readonly className?: string;
}) {
  const account = useNodexAccount(true);
  const view = resolveNodexAccountView(account);
  const { gauge, funded } = useNodexCreditGauge(account);
  const visible = view.signedIn && Boolean(funded || account.snapshot?.checkoutPending);
  useNodexCreditRefreshOnFocus(visible, account.refreshModels);
  if (!visible) return null;
  const level = gauge ? describeCreditGauge(gauge) : null;
  const label = gauge
    ? `Nodex credits, ${formatNodexCredits(gauge.balance)} left`
    : "Nodex credits";
  return (
    <NodexHoverCard
      ariaLabel="Nodex credits details"
      hoverCardContent={
        <NodexCreditCard
          account={account}
          gauge={gauge}
          onOpenAccountSettings={onOpenAccountSettings}
        />
      }
      placement="right-end"
      onOpenChange={(open) => {
        if (open) account.act("refreshModels");
      }}
    >
      <button
        type="button"
        aria-label={label}
        data-nodex-credit-meter={level?.severity ?? "unread"}
        onClick={onOpenAccountSettings}
        className={cn(
          "inline-flex size-9 items-center justify-center rounded-lg outline-none",
          NODEX_BUTTON_COLOR_CLASS.ghostSecondary,
          "focus-visible:bg-(--sidebar-accent) focus-visible:ring-2 focus-visible:ring-(--sidebar-ring)/35",
          className,
        )}
      >
        <UsageRingGlyph
          provider="codex"
          mark={<NodexLogoMarkIcon monochrome />}
          track={!level ? "dotted" : level.severity === "exhausted" ? "spent" : "solid"}
          arc={level ? { percent: level.percent, severity: level.severity, faded: false } : null}
          pulse={Boolean(account.snapshot?.checkoutPending)}
        />
      </button>
    </NodexHoverCard>
  );
}
