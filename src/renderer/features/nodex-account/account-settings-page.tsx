import { formatNodexCredits } from "../../../shared/nodex-models";
import { useEffect, useState } from "react";
import { NODEX_ACCOUNT_ERROR_COPY } from "../../../shared/nodex-account-copy";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { NodexSettingsPageSurface, NodexSettingsSection } from "@/components/ui/settings";
import { buildSettingsPath } from "@/components/workbench/workbench-settings-routes";
import { cn } from "@/lib/utils";
import { NodexAccountAvatar, resolveNodexAccountView } from "./nodex-account-identity";
import {
  CREDIT_SEVERITY_TEXT,
  NodexCreditBar,
  describeCreditGauge,
  useNodexCreditGauge,
} from "./nodex-credit-meter";
import { NodexModelPrices } from "./nodex-model-prices";
import { NodexTopUpTiers } from "./nodex-top-up";
import { useNodexAccount, useNodexCreditRefreshOnFocus } from "./use-nodex-account";

export function AccountSettingsPage({
  open,
  onPathChange,
}: {
  open: boolean;
  onPathChange?: (path: string) => void;
}) {
  if (!open) return null;
  return <AccountSettingsContent onPathChange={onPathChange} />;
}

function AccountSettingsContent({
  onPathChange,
}: {
  readonly onPathChange: ((path: string) => void) | undefined;
}) {
  const account = useNodexAccount(true);
  const view = resolveNodexAccountView(account);
  const { refreshModels } = account;
  useNodexCreditRefreshOnFocus(view.signedIn, refreshModels);
  // Only a signed-in account has credit and model access to refresh.
  useEffect(() => {
    if (view.signedIn) refreshModels();
  }, [view.signedIn, refreshModels]);
  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    if (!account.loading) return;
    const timer = window.setTimeout(() => setShowLoading(true), 200);
    return () => window.clearTimeout(timer);
  }, [account.loading]);

  const identity = view.identity;
  const busy = account.pending !== null;
  const spinner = <ActivitySpinnerIcon className="icon-xxs" />;

  function title() {
    if (identity) return identity.label;
    if (view.signedOut) return "Not signed in";
    return "Nodex Account";
  }

  function description() {
    if (account.loading) return showLoading ? "Loading…" : null;
    if (account.failed) return "Couldn't load account status.";
    if (!view.configured) return "Not available in this build.";
    if (view.signingIn) return "Signing in through your browser…";
    if (view.signedOut) return "Optional. Everything local works without signing in.";
    return identity?.detail ?? null;
  }

  const detail = description();
  const modelError = account.snapshot?.modelAccessError;
  const modelNotice =
    modelError === "email_unverified"
      ? "Verify your email to use Nodex models."
      : modelError === "forbidden_client"
        ? "This app cannot access Nodex models."
        : modelError
          ? "Nodex models are unavailable. Try again."
          : null;

  return (
    <NodexSettingsPageSurface title="Account">
      <NodexSettingsSection>
        <div aria-busy={account.loading || view.signingIn}>
          <div className="flex min-h-18 flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
            <div className="flex min-w-32 flex-1 items-center gap-3">
              <NodexAccountAvatar
                identity={identity}
                size="lg"
                className={cn(view.signingIn && "animate-pulse motion-reduce:animate-none")}
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <NodexTooltip tooltipContent={identity?.label} disabled={!identity}>
                  <span className="block truncate text-sm font-medium text-token-text-primary select-text">
                    {title()}
                  </span>
                </NodexTooltip>
                <span
                  aria-live="polite"
                  className="flex min-w-0 flex-col gap-1 text-xs leading-4 text-token-text-secondary"
                >
                  {detail ? (
                    <span
                      role={account.failed ? "alert" : undefined}
                      className={cn(
                        "flex min-w-0 items-center gap-1.5",
                        account.failed && "text-danger",
                      )}
                    >
                      {view.signingIn ? spinner : null}
                      <NodexTooltip tooltipContent={identity?.detail} disabled={!identity?.detail}>
                        <span className="truncate select-text">{detail}</span>
                      </NodexTooltip>
                    </span>
                  ) : null}
                  {view.reauthentication ? (
                    <span role="status" className="text-token-warning-foreground">
                      {NODEX_ACCOUNT_ERROR_COPY["invalid-grant"].message}
                    </span>
                  ) : null}
                  {view.offline ? (
                    <span>Can't reach Nodex Account. Check your connection.</span>
                  ) : null}
                  {view.memoryOnly ? (
                    <span>
                      Secure storage is unavailable, so this sign-in lasts until Nodex quits.
                    </span>
                  ) : null}
                </span>
              </div>
            </div>
            <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
              {account.failed ? (
                <NodexButton
                  variant="secondary"
                  size="sm"
                  disabled={account.retrying}
                  onClick={account.retry}
                >
                  {account.retrying ? spinner : null}
                  Retry
                </NodexButton>
              ) : null}
              {view.signedOut || view.reauthentication ? (
                <NodexButton
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() => account.act("signIn")}
                >
                  {view.reauthentication ? "Sign in again" : "Sign in"}
                </NodexButton>
              ) : null}
              {view.signingIn ? (
                <NodexButton
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => account.act("cancelSignIn")}
                >
                  Cancel
                </NodexButton>
              ) : null}
              {view.signedIn || view.reauthentication ? (
                <NodexButton
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => account.act("signOut")}
                >
                  {account.pending === "signOut" ? spinner : null}
                  Sign out
                </NodexButton>
              ) : null}
              {view.offline || modelError ? (
                <NodexButton
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => account.act("refresh")}
                >
                  {account.pending === "refresh" ? spinner : null}
                  Check again
                </NodexButton>
              ) : null}
            </div>
          </div>
          {view.notice ? (
            <p
              role={view.notice.tone === "warning" ? "status" : "alert"}
              className={cn(
                "px-4 pb-3 text-xs",
                view.notice.tone === "warning" ? "text-token-warning-foreground" : "text-danger",
              )}
            >
              {view.notice.message}
            </p>
          ) : null}
        </div>
      </NodexSettingsSection>
      {view.signedIn ? (
        <AccountCredit account={account} modelNotice={modelNotice} onPathChange={onPathChange} />
      ) : null}
    </NodexSettingsPageSurface>
  );
}

/** Credits, what buys them and what they buy, laid out where the person decides. */
function AccountCredit({
  account,
  modelNotice,
  onPathChange,
}: {
  readonly account: ReturnType<typeof useNodexAccount>;
  readonly modelNotice: string | null;
  readonly onPathChange: ((path: string) => void) | undefined;
}) {
  const { gauge } = useNodexCreditGauge(account);
  const level = gauge ? describeCreditGauge(gauge) : null;
  const status = account.snapshot?.modelStatus;
  return (
    <>
      <NodexSettingsSection title="Credits">
        <div className="flex flex-col gap-3 px-4 pt-3.5 pb-4">
          <span className="flex items-baseline gap-1.5">
            <span
              aria-label="Remaining credits"
              className={cn(
                "text-2xl font-medium tracking-tight text-token-text-primary tabular-nums",
                level && CREDIT_SEVERITY_TEXT[level.severity],
              )}
            >
              {gauge ? formatNodexCredits(gauge.balance) : "—"}
            </span>
            {gauge ? <span className="text-sm text-token-text-secondary">credits</span> : null}
          </span>
          <NodexCreditBar gauge={gauge} />
        </div>
        {modelNotice ? (
          <p role="alert" className="px-4 pb-3 text-xs text-danger">
            {modelNotice}
          </p>
        ) : null}
      </NodexSettingsSection>
      <section aria-labelledby="nodex-top-up-title" className="flex flex-col">
        <div className="flex min-h-toolbar items-baseline justify-between gap-3 pb-1.5">
          <h2 id="nodex-top-up-title" className="text-base font-medium text-token-text-primary">
            Top up
          </h2>
          {status ? (
            <span className="text-xs text-token-description-foreground tabular-nums">
              {formatNodexCredits(status.creditsPerUsd)} credits = $1
            </span>
          ) : null}
        </div>
        <NodexTopUpTiers account={account} />
      </section>
      {status?.pricing ? (
        <NodexModelPrices
          pricing={status.pricing}
          creditsPerUsd={status.creditsPerUsd}
          unavailableModels={status.models.filter((model) => !model.available).map(({ id }) => id)}
          onManageModels={onPathChange && (() => onPathChange(buildSettingsPath("models")))}
        />
      ) : null}
    </>
  );
}
