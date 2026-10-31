import type { NodexAccountSnapshot } from "../../../shared/nodex-account";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDropdownContent,
  NodexDropdownItem,
  NodexDropdownMessage,
  NodexDropdownPortal,
  NodexDropdownRoot,
  NodexDropdownTrigger,
} from "@/components/ui/dropdown";
import type { useNodexAccount } from "./use-nodex-account";

type Account = ReturnType<typeof useNodexAccount>;
const dollars = (amount: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(amount);

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
    <span role={error ? "alert" : "status"} className="text-xs text-token-text-secondary">
      {message}
    </span>
  );
}

/** Both Account surfaces offer the same server-owned tiers and categorical failures. */
export function NodexTopUpItems({ account }: { account: Account }) {
  const topUp = account.snapshot?.modelStatus?.topUp;
  return (
    <>
      {!topUp?.available ? (
        <NodexDropdownMessage compact tone="muted">
          {topUp ? "Top up is paused." : "Top up is temporarily unavailable."}
        </NodexDropdownMessage>
      ) : null}
      {topUp?.tiers.map((tier) => (
        <NodexDropdownItem
          key={tier.amount}
          disabled={!topUp.available || !tier.available || account.pending !== null}
          onSelect={() => account.act("openTopUp", tier.amount)}
        >
          {dollars(tier.amount)} → {dollars(tier.credit)} credit
        </NodexDropdownItem>
      ))}
    </>
  );
}

export function NodexTopUpButton({ account }: { account: Account }) {
  return (
    <NodexDropdownRoot
      onOpenChange={(open) => {
        if (open) account.act("refreshModels");
      }}
    >
      <NodexDropdownTrigger nativeButton>
        <NodexButton variant="secondary" size="sm" disabled={account.pending !== null}>
          Top up
        </NodexButton>
      </NodexDropdownTrigger>
      <NodexDropdownPortal>
        <NodexDropdownContent align="end">
          <NodexTopUpItems account={account} />
        </NodexDropdownContent>
      </NodexDropdownPortal>
    </NodexDropdownRoot>
  );
}
