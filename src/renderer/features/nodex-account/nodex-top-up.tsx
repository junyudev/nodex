import type { NodexAccountSnapshot } from "../../../shared/nodex-account";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import type { useNodexAccount } from "./use-nodex-account";

type Account = ReturnType<typeof useNodexAccount>;
type Tier = NonNullable<NodexAccountSnapshot["modelStatus"]>["topUp"]["tiers"][number];

export const dollars = (amount: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(amount);

/** Payment progress or a categorical failure; nothing while idle. */
export function NodexCheckoutNotice({ snapshot }: { snapshot: NodexAccountSnapshot | undefined }) {
  const error = snapshot?.checkoutError;
  const message =
    error === "tier_unavailable"
      ? "This top-up is unavailable."
      : error === "unauthenticated"
        ? "Sign in again to top up."
        : error === "forbidden_client"
          ? "Top up isn't available in this build."
          : error === "browser-open"
            ? "Couldn't open your browser. Try again."
            : error
              ? "Top up is temporarily unavailable."
              : snapshot?.checkoutPending
                ? "Waiting for payment…"
                : null;
  if (!message) return null;
  return (
    <span
      role={error ? "alert" : "status"}
      className="inline-flex items-center gap-1.5 text-xs text-token-text-secondary"
    >
      {!error ? <ActivitySpinnerIcon className="icon-xxs" /> : null}
      {message}
    </span>
  );
}

/** One purchasable tier: what it costs on the left, what it adds on the right. */
function TopUpTile({
  tier,
  disabled,
  onSelect,
}: {
  readonly tier: Tier;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}) {
  const bonus = Math.round((tier.credit / tier.amount - 1) * 100);
  return (
    <button
      type="button"
      aria-label={`Pay ${dollars(tier.amount)} for ${dollars(tier.credit)} credit`}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex items-center justify-between gap-3 rounded-2xl border border-token-border px-4 py-3.5 text-left outline-none",
        "bg-(--color-background-panel,var(--color-token-bg-fog)) transition-colors duration-150",
        "hover:border-token-foreground/20 hover:bg-token-list-hover-background",
        "focus-visible:ring-2 focus-visible:ring-(--sidebar-ring)/35",
        "disabled:pointer-events-none disabled:opacity-45",
      )}
    >
      <span className="text-xl font-medium tracking-tight text-token-foreground tabular-nums">
        {dollars(tier.amount)}
      </span>
      <span className="flex flex-col items-end">
        <span className="text-sm text-token-foreground tabular-nums">
          {dollars(tier.credit)} <span className="text-token-description-foreground">credit</span>
        </span>
        {bonus > 0 ? (
          <span className="text-xs text-(--green-text) tabular-nums">+{bonus}%</span>
        ) : null}
      </span>
    </button>
  );
}

/** The server's tiers, always laid out; paused supply keeps them visible but unavailable. */
export function NodexTopUpTiers({ account }: { account: Account }) {
  const snapshot = account.snapshot;
  const topUp = snapshot?.modelStatus?.topUp;
  if (!topUp) {
    return (
      <p className="m-0 text-xs text-token-text-secondary">Top up is temporarily unavailable.</p>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
        {topUp.tiers.map((tier) => (
          <TopUpTile
            key={tier.amount}
            tier={tier}
            disabled={!topUp.available || !tier.available || account.pending !== null}
            onSelect={() => account.act("openTopUp", tier.amount)}
          />
        ))}
      </div>
      {!topUp.available ? (
        <p className="m-0 text-xs text-token-text-secondary">Top up is paused.</p>
      ) : (
        <div className="empty:hidden">
          <NodexCheckoutNotice snapshot={snapshot} />
        </div>
      )}
    </div>
  );
}
