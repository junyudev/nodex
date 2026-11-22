import { useAppComponent } from "@/features/app-components/use-app-components";
import { providerComponentSetup } from "@/features/app-components/provider-component-setup";
import { getIntl, useIntl } from "@/lib/i18n";
import { isRemoteSpace } from "@/lib/renderer-space";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useUsageMeterSettings } from "@/features/usage-meters/usage-meter-settings";
import { useRef, useState } from "react";
import { subscriptionMeter, subscriptionMeters } from "../../../shared/subscription-usage";
import { NodexAccountMenu } from "@/features/nodex-account/nodex-account-menu";
import { NodexCreditMeter } from "@/features/nodex-account/nodex-credit-meter";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { WORKBENCH_RAIL_BUTTON_CLASS } from "./workbench-app-rail";
import { RailUsageMeter, UsageRingGlyph } from "./workbench-rail-usage-meter";
import { shouldRefreshAccountOnConnectionTooltipOpen } from "@/features/local-conversation/view/shared/account-tooltip-refresh";
import {
  AuthPopover,
  signInToCodexMessage,
} from "@/features/local-conversation/view/shared/auth-controls";
import { QuotaResetTooltipSection } from "@/features/local-conversation/view/shared/auth-rate-limits";
import { resolveRailAccountState } from "@/features/local-conversation/view/shared/rail-account-state";
import { cn } from "@/lib/utils";
import { useSubscriptionUsage, type SubscriptionUsage } from "@/lib/use-subscription-usage";
import {
  subscriptionUsageAccounts,
  subscriptionUsagePlaceholder,
  codexUsageReading,
  type SubscriptionUsageAccount,
  type UsageProvider,
} from "@/lib/usage-meter";
import type {
  CodexAccountSnapshot,
  CodexConnectionState,
  CodexRateLimitResetInput,
  CodexRateLimitResetResult,
} from "@/lib/types";
import type { IpcApi } from "../../../shared/ipc-api";

type CodexLoginStartResult = IpcApi["codex:account:login:start"]["result"];

export interface WorkbenchRailAccountControlsProps {
  onOpenSettings: () => void;
  onOpenAccountSettings: () => void;
  settingsShortcutLabel?: string;
  account?: CodexAccountSnapshot | null;
  connection?: CodexConnectionState;
  onRefreshAccount?: () => Promise<CodexAccountSnapshot>;
  onConsumeRateLimitReset?: (input: CodexRateLimitResetInput) => Promise<CodexRateLimitResetResult>;
  onStartChatGptLogin?: () => Promise<CodexLoginStartResult>;
  onStartApiKeyLogin?: (apiKey: string) => Promise<CodexLoginStartResult>;
  onCancelLogin?: (loginId: string) => Promise<unknown>;
  onLogout?: () => Promise<void>;
  onErrorMessage?: (message: string | null) => void;
  /** Subscription usage as Main keeps it: one meter per account. */
  subscriptionUsage?: SubscriptionUsage;
}

type RailUsagePlaceholderState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly reason: string; readonly detail?: string | null };

/**
 * Holds a provider's slot while nothing about it is known yet: an unread meter that breathes
 * while it loads and rests with a status dot when it cannot load. Either way a click asks again.
 */
function RailUsagePlaceholder({
  provider,
  subject,
  state,
  onRetry,
}: {
  readonly provider: UsageProvider;
  /** What is loading, such as `Codex account`. */
  readonly subject: string;
  readonly state: RailUsagePlaceholderState;
  readonly onRetry?: () => Promise<unknown>;
}) {
  const intl = useIntl();
  const [retrying, setRetrying] = useState(false);
  const loading = state.kind === "loading";
  const label = loading
    ? intl.formatMessage(
        {
          id: "workbench.workbenchRailAccountControls.loadingSubjectLabel",
          defaultMessage: "Loading {subject}",
        },
        { subject },
      )
    : intl.formatMessage(
        {
          id: "workbench.workbenchRailAccountControls.retryingLabel",
          defaultMessage: "{reason}. Retrying automatically",
        },
        { reason: state.reason },
      );
  const retry = () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    void onRetry()
      .catch(() => {})
      .finally(() => setRetrying(false));
  };
  return (
    <NodexTooltip
      side="right"
      tooltipContent={
        <span className="flex flex-col gap-0.5">
          <span>
            {loading
              ? intl.formatMessage(
                  {
                    id: "workbench.workbenchRailAccountControls.loadingSubject",
                    defaultMessage: "Loading {subject}…",
                  },
                  { subject },
                )
              : state.reason}
          </span>
          {loading ? null : (
            <span className="text-token-description-foreground">
              {state.detail ? <span className="block">{state.detail}</span> : null}
              {intl.formatMessage({
                id: "workbench.workbenchRailAccountControls.retryHint",
                defaultMessage: "Retrying automatically. Click to try now.",
              })}
            </span>
          )}
        </span>
      }
    >
      <NodexButton
        variant="ghostSecondary"
        size="icon"
        aria-label={label}
        aria-busy={loading || retrying}
        data-rail-account-state={state.kind}
        className={cn(WORKBENCH_RAIL_BUTTON_CLASS, "relative")}
        onClick={retry}
      >
        <span className="inline-flex text-(--sidebar-foreground-tertiary)">
          <UsageRingGlyph
            provider={provider}
            track="dotted"
            pulse={loading || retrying}
            alert={!loading}
          />
        </span>
      </NodexButton>
    </NodexTooltip>
  );
}

/** Asks once for a fresh reading each time a usage card opens, never twice at a time. */
function useRefreshOnOpen(refresh: () => Promise<unknown>): (open: boolean) => void {
  const inFlight = useRef(false);
  return (open) => {
    if (
      !shouldRefreshAccountOnConnectionTooltipOpen({
        isOpen: open,
        hasAccount: true,
        refreshInFlight: inFlight.current,
      })
    )
      return;
    inFlight.current = true;
    void refresh()
      .catch(() => {})
      .finally(() => {
        inFlight.current = false;
      });
  };
}

/** A usage card's header action that signs the account out on this computer. */
function UsageSignOutButton({
  onSignOut,
  onErrorMessage,
}: {
  readonly onSignOut: () => Promise<unknown>;
  readonly onErrorMessage?: (message: string | null) => void;
}) {
  const intl = useIntl();
  const [signingOut, setSigningOut] = useState(false);
  const signOut = async () => {
    setSigningOut(true);
    onErrorMessage?.(null);
    await runWithCleanup(
      async () => {
        await onSignOut();
      },
      {
        onError: (error) => {
          onErrorMessage?.(
            error instanceof Error
              ? error.message
              : getIntl().formatMessage({
                  id: "workbench.workbenchRailAccountControls.logoutFailed",
                  defaultMessage: "Logout failed",
                }),
          );
        },
        cleanup: () => {
          setSigningOut(false);
        },
      },
    );
  };
  return (
    <button
      type="button"
      className="h-6 shrink-0 rounded-md px-1.5 text-xs text-token-text-secondary outline-none hover:bg-token-foreground/5 hover:text-token-foreground focus-visible:ring-2 focus-visible:ring-(--ring)/35 disabled:opacity-40"
      onClick={() => void signOut()}
      disabled={signingOut}
    >
      {intl.formatMessage({
        id: "workbench.workbenchRailAccountControls.signOut",
        defaultMessage: "Sign out",
      })}
    </button>
  );
}

/**
 * The signed-in Codex account's meter. Its card adds signing out and spending a quota reset.
 * Opening it asks Codex once for a fresh reading, as Codex also does on its own every minute.
 */
function CodexUsageMeter({
  account,
  onRefreshAccount,
  onConsumeRateLimitReset,
  onLogout,
  onErrorMessage,
}: {
  readonly account: CodexAccountSnapshot;
  readonly onRefreshAccount: () => Promise<CodexAccountSnapshot>;
  readonly onConsumeRateLimitReset?: (
    input: CodexRateLimitResetInput,
  ) => Promise<CodexRateLimitResetResult>;
  readonly onLogout: () => Promise<void>;
  readonly onErrorMessage?: (message: string | null) => void;
}) {
  const refreshOnOpen = useRefreshOnOpen(onRefreshAccount);
  const reading = codexUsageReading(account);
  if (!reading) return null;
  return (
    <RailUsageMeter
      reading={reading}
      onOpenChange={refreshOnOpen}
      action={<UsageSignOutButton onSignOut={onLogout} onErrorMessage={onErrorMessage} />}
    >
      {account.rateLimitResetCredits && onConsumeRateLimitReset ? (
        <QuotaResetTooltipSection
          summary={account.rateLimitResetCredits}
          onReset={onConsumeRateLimitReset}
        />
      ) : null}
    </RailUsageMeter>
  );
}

/**
 * Opening a subscription card asks Main for a fresh reading. Claude also offers sign-out
 * across the profiles that share its account.
 */
function SubscriptionUsageMeter({
  account,
  usage,
  onErrorMessage,
}: {
  readonly account: SubscriptionUsageAccount;
  readonly usage: SubscriptionUsage;
  readonly onErrorMessage?: (message: string | null) => void;
}) {
  const refreshOnOpen = useRefreshOnOpen(usage.refresh);
  return (
    <RailUsageMeter
      reading={account.reading}
      onOpenChange={refreshOnOpen}
      action={
        subscriptionMeter(account.reading.provider)?.signOut ? (
          <UsageSignOutButton
            onSignOut={() => usage.logoutClaude(account.instanceIds)}
            onErrorMessage={onErrorMessage}
          />
        ) : undefined
      }
    />
  );
}

/**
 * App-wide controls at the foot of the navigation rail, read from the bottom up: the account
 * menu, which shows the current Space and the Nodex Account, the Nodex credit meter while signed
 * in, then the Codex account control (its usage meter when signed in, an open Codex
 * ring that signs in when signed out, an unread Codex meter while the account is unknown), then
 * one usage meter per subscription account (an unread Claude meter until Main has read
 * any). The slots that always exist sit lowest, so subscription meters coming and going never move
 * them.
 */
export function WorkbenchRailAccountControls({
  onOpenSettings,
  onOpenAccountSettings,
  settingsShortcutLabel,
  account,
  connection,
  onRefreshAccount,
  onConsumeRateLimitReset,
  onStartChatGptLogin,
  onStartApiKeyLogin,
  onCancelLogin,
  onLogout,
  onErrorMessage,
  subscriptionUsage,
}: WorkbenchRailAccountControlsProps) {
  const intl = useIntl();
  const { settings: meters } = useUsageMeterSettings();
  // A team window never reads this desktop's own Codex account; its Agents run on its host.
  const codexMeter = meters.codex && !isRemoteSpace();
  const [loginBusy, setLoginBusy] = useState(false);
  const codexComponent = useAppComponent("codex");
  const codexSetup = providerComponentSetup(undefined, codexComponent, intl);
  const accountState = resolveRailAccountState(account ?? null, connection);
  const showUsageMeter = Boolean(
    codexMeter && accountState.kind === "signedIn" && connection && onRefreshAccount && onLogout,
  );
  const showSignIn = Boolean(
    codexMeter &&
    (accountState.kind === "signedOut" || Boolean(codexComponent?.enabled && !account?.account)) &&
    onStartChatGptLogin &&
    onStartApiKeyLogin &&
    onCancelLogin,
  );
  const subscriptionAccounts = subscriptionUsageAccounts(subscriptionUsage?.snapshot);
  const placeholder = subscriptionUsagePlaceholder(subscriptionUsage?.snapshot);

  const handleChatGptLogin = async () => {
    if (!onStartChatGptLogin) return;

    setLoginBusy(true);
    onErrorMessage?.(null);

    await runWithCleanup(
      async () => {
        const result = await onStartChatGptLogin();
        if (result.type === "chatgpt" && result.authUrl) {
          window.open(result.authUrl, "_blank");
        }
      },
      {
        onError: (error) => {
          onErrorMessage?.(
            error instanceof Error
              ? error.message
              : getIntl().formatMessage({
                  id: "workbench.workbenchRailAccountControls.loginFailed",
                  defaultMessage: "Login failed",
                }),
          );
        },
        cleanup: () => {
          setLoginBusy(false);
        },
      },
    );
  };

  const handleApiKeyLogin = async (apiKey: string) => {
    if (!onStartApiKeyLogin) return;

    setLoginBusy(true);
    onErrorMessage?.(null);

    await runWithCleanup(
      async () => {
        await onStartApiKeyLogin(apiKey);
      },
      {
        onError: (error) => {
          onErrorMessage?.(
            error instanceof Error
              ? error.message
              : getIntl().formatMessage({
                  id: "workbench.workbenchRailAccountControls.loginFailed",
                  defaultMessage: "Login failed",
                }),
          );
        },
        cleanup: () => {
          setLoginBusy(false);
        },
      },
    );
  };

  const handleCancelLogin = async (loginId: string) => {
    if (!onCancelLogin) return;

    onErrorMessage?.(null);

    try {
      await onCancelLogin(loginId);
    } catch (error) {
      onErrorMessage?.(
        error instanceof Error
          ? error.message
          : getIntl().formatMessage({
              id: "workbench.workbenchRailAccountControls.cancelLoginFailed",
              defaultMessage: "Failed to cancel login",
            }),
      );
    }
  };

  return (
    <div
      data-workbench-rail-account-controls=""
      className="mt-auto flex flex-col items-center gap-2"
    >
      <div data-workbench-rail-account="" className="contents">
        {subscriptionUsage
          ? subscriptionAccounts
              .filter(({ reading }) => meters[reading.provider] !== false)
              .toSorted((left, right) =>
                left.reading.provider.localeCompare(right.reading.provider),
              )
              .map((account) => (
                <span
                  key={account.reading.key}
                  className="inline-flex animate-in duration-200 fade-in-0 zoom-in-90 motion-reduce:animate-none"
                >
                  <SubscriptionUsageMeter
                    account={account}
                    usage={subscriptionUsage}
                    onErrorMessage={onErrorMessage}
                  />
                </span>
              ))
          : null}
        {subscriptionUsage && placeholder
          ? subscriptionMeters
              .filter(
                ({ preference, showPlaceholder }) =>
                  showPlaceholder && meters[preference] !== false,
              )
              .map(({ preference, label }) => (
                <RailUsagePlaceholder
                  key={preference}
                  provider={preference}
                  subject={intl.formatMessage(
                    {
                      id: "agentReadiness.usageSubject",
                      defaultMessage: "{label} usage",
                    },
                    { label },
                  )}
                  state={
                    placeholder.kind === "loading"
                      ? placeholder
                      : {
                          kind: "unavailable",
                          reason: intl.formatMessage(
                            {
                              id: "agentReadiness.usageUnavailable",
                              defaultMessage: "Can't read {label} usage",
                            },
                            { label },
                          ),
                          detail: placeholder.reason,
                        }
                  }
                  onRetry={subscriptionUsage.refresh}
                />
              ))
          : null}
        {showUsageMeter && account && onRefreshAccount && onLogout ? (
          <span className="inline-flex animate-in duration-200 fade-in-0 zoom-in-90 motion-reduce:animate-none">
            <CodexUsageMeter
              account={account}
              onRefreshAccount={onRefreshAccount}
              onConsumeRateLimitReset={onConsumeRateLimitReset}
              onLogout={onLogout}
              onErrorMessage={onErrorMessage}
            />
          </span>
        ) : showSignIn && onCancelLogin ? (
          <AuthPopover
            account={account ?? null}
            busy={loginBusy}
            setupStatus={codexSetup?.title}
            side="right"
            sideOffset={8}
            trigger={
              <NodexButton
                variant="ghostSecondary"
                size="icon"
                aria-label={intl.formatMessage(signInToCodexMessage)}
                data-rail-account-state="signedOut"
                className={WORKBENCH_RAIL_BUTTON_CLASS}
              >
                <UsageRingGlyph provider="codex" track="open" />
              </NodexButton>
            }
            onChatGptLogin={() => void handleChatGptLogin()}
            onApiKeyLogin={(apiKey) => void handleApiKeyLogin(apiKey)}
            onCancelLogin={(loginId) => void handleCancelLogin(loginId)}
          />
        ) : codexMeter &&
          (accountState.kind === "loading" || accountState.kind === "unavailable") ? (
          <RailUsagePlaceholder
            provider="codex"
            subject={intl.formatMessage({
              id: "workbench.workbenchRailAccountControls.codexAccount",
              defaultMessage: "Codex account",
            })}
            state={accountState}
            onRetry={onRefreshAccount}
          />
        ) : null}
      </div>
      {meters.nodexCredit ? (
        <NodexCreditMeter
          onOpenAccountSettings={onOpenAccountSettings}
          className={WORKBENCH_RAIL_BUTTON_CLASS}
        />
      ) : null}
      <NodexAccountMenu
        onOpenSettings={onOpenSettings}
        onOpenAccountSettings={onOpenAccountSettings}
        settingsShortcutLabel={settingsShortcutLabel}
        className={WORKBENCH_RAIL_BUTTON_CLASS}
      />
    </div>
  );
}

/**
 * The rail foot with Main's subscription usage. Kept as its own leaf so a new reading re-renders only
 * these controls.
 */
export function WorkbenchRailFoot(
  props: Omit<WorkbenchRailAccountControlsProps, "subscriptionUsage">,
) {
  return (
    <WorkbenchRailAccountControls
      {...props}
      subscriptionUsage={useSubscriptionUsage() ?? undefined}
    />
  );
}
