import { useEffect, useState } from "react";
import { NODEX_ACCOUNT_ERROR_COPY } from "../../../shared/nodex-account-copy";
import type { NodexAccountSnapshot } from "../../../shared/nodex-account";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  NodexSettingsPageSurface,
  NodexSettingsRow,
  NodexSettingsSection,
} from "@/components/ui/settings";
import { useNodexAccount } from "./use-nodex-account";

function accountIdentity(snapshot: NodexAccountSnapshot): { label: string; email: string | null } {
  const name = snapshot.account?.name?.trim();
  const email = snapshot.account?.email?.trim() || null;
  return {
    label: name || email || "Signed in",
    email: name && name !== email ? email : null,
  };
}

export function AccountSettingsPage({ open }: { open: boolean }) {
  if (!open) return null;
  return <AccountSettingsContent />;
}

function AccountSettingsContent() {
  const account = useNodexAccount(true);
  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    if (!account.loading) return;
    const timer = window.setTimeout(() => setShowLoading(true), 200);
    return () => window.clearTimeout(timer);
  }, [account.loading]);

  const snapshot = account.snapshot;
  const configured = snapshot?.configured === true;
  const signingIn = configured && snapshot.status === "signing-in";
  const signedIn = configured && snapshot.status === "signed-in";
  const reauthentication = configured && snapshot.status === "reauthentication-required";
  const signedOut = configured && snapshot.status === "signed-out";
  const offline = signedIn && snapshot.connection === "unavailable" && snapshot.error === "network";
  const memoryOnly = signedIn && snapshot.persistence === "memory";
  const identity = snapshot && (signedIn || reauthentication) ? accountIdentity(snapshot) : null;
  const pending = account.pending !== null;
  const failure = account.failure;
  const suppressFailure =
    (failure === "not-configured" && !configured) ||
    (failure === "invalid-grant" && reauthentication);
  const message =
    failure === "transport"
      ? { message: "Could not complete the request. Try again.", tone: "error" as const }
      : failure && !suppressFailure
        ? NODEX_ACCOUNT_ERROR_COPY[failure]
        : null;

  function description() {
    if (account.loading) return showLoading ? "Loading…" : "\u00a0";
    if (account.failed) return "Couldn't load account status.";
    if (!configured) return "Not available in this build.";
    if (signingIn) return "Signing in through your browser…";
    if (signedOut) return "Not signed in";
    return identity?.email;
  }

  return (
    <NodexSettingsPageSurface
      title="Account"
      subtitle="Optional. Everything local works without signing in."
    >
      <NodexSettingsSection>
        <div aria-busy={account.loading || signingIn}>
          <NodexSettingsRow
            className="min-h-18"
            label={
              <NodexTooltip tooltipContent={identity?.label} disabled={!identity}>
                <span className="block truncate select-text">
                  {identity?.label ?? "Nodex Account"}
                </span>
              </NodexTooltip>
            }
            description={
              <span aria-live="polite" className="flex min-w-0 flex-col gap-1">
                <span
                  className={account.failed ? "text-danger" : "flex min-w-0 items-center gap-1.5"}
                  role={account.failed ? "alert" : undefined}
                >
                  {signingIn ? <ActivitySpinnerIcon className="icon-xxs" /> : null}
                  <NodexTooltip tooltipContent={identity?.email} disabled={!identity?.email}>
                    <span className="truncate select-text">{description()}</span>
                  </NodexTooltip>
                </span>
                {reauthentication ? (
                  <span role="status" className="text-token-warning-foreground">
                    Session ended. Sign in again to continue.
                  </span>
                ) : null}
                {offline ? <span>Offline. Can't reach Nodex Account.</span> : null}
                {memoryOnly ? (
                  <span>
                    Secure storage is unavailable, so this sign-in lasts until Nodex quits.
                  </span>
                ) : null}
              </span>
            }
          >
            {account.failed ? (
              <NodexButton
                variant="secondary"
                size="sm"
                disabled={account.retrying}
                onClick={account.retry}
              >
                {account.retrying ? "Checking…" : "Retry"}
              </NodexButton>
            ) : null}
            {signedOut || reauthentication ? (
              <NodexButton
                variant="primary"
                size="sm"
                disabled={pending}
                onClick={() => account.act("signIn")}
              >
                {reauthentication ? "Sign in again" : "Sign in"}
              </NodexButton>
            ) : null}
            {signingIn ? (
              <NodexButton
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() => account.act("cancelSignIn")}
              >
                Cancel
              </NodexButton>
            ) : null}
            {signedIn || reauthentication ? (
              <NodexButton
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() => account.act("signOut")}
              >
                {account.pending === "signOut" ? "Signing out…" : "Sign out"}
              </NodexButton>
            ) : null}
            {offline ? (
              <NodexButton
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() => account.act("refresh")}
              >
                {account.pending === "refresh" ? "Checking…" : "Check again"}
              </NodexButton>
            ) : null}
          </NodexSettingsRow>
          {message && !account.failed ? (
            <p
              role={message.tone === "warning" ? "status" : "alert"}
              className={
                message.tone === "warning"
                  ? "px-4 pb-3 text-xs text-token-warning-foreground"
                  : "px-4 pb-3 text-xs text-danger"
              }
            >
              {message.message}
            </p>
          ) : null}
        </div>
      </NodexSettingsSection>
    </NodexSettingsPageSurface>
  );
}
