import { FormattedMessage, getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import { useEffect, useState, type ReactElement, type ReactNode, type Ref } from "react";
import { OpenExternalIcon } from "@/components/shared/icons";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { openExternalUrl } from "@/lib/file-system-operations";
import type { AcpAgentInstanceConfig } from "../../../shared/acp-agent-settings";
import {
  acpFailureText,
  acpSignInActionLabel,
  acpSignInMethods,
  type AcpActivity,
  type AcpInstanceStatus,
  type AcpProviderSnapshot,
  type AcpSignInMethod,
  type AcpUrlAuthAction,
} from "./acp-agent-model";
import type { AcpAgentsOwner } from "./acp-agents-owner";
import {
  AgentAccountControls,
  AgentAccountBrowserActions,
  useAgentAccount,
  useAgentAccountFocus,
} from "../agent-account/agent-account-controls";
import { isAgentAuthActive } from "../agent-account/agent-account-owner";

const expiresText = (
  expiresAt: string | null | undefined,
  intl: IntlShape = getIntl(),
): string | null => {
  if (!expiresAt) return null;
  const time = Date.parse(expiresAt);
  if (!Number.isFinite(time)) return null;
  return intl.formatMessage(
    { id: "acpAgents.acpAgentAccount.expires", defaultMessage: "Expires {time}" },
    { time: intl.formatTime(time, { timeStyle: "short" }) },
  );
};

/** Where the Agent asked to continue in a browser; opening it is recorded as consent first. */
function UrlSignIn({
  instanceId,
  action,
  owner,
}: {
  readonly instanceId: string;
  readonly action: AcpUrlAuthAction;
  readonly owner: AcpAgentsOwner;
}) {
  const intl = useIntl();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = async (then: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    const result = await owner.acceptUrlAuth(instanceId, action.elicitationId);
    setPending(false);
    if (!result.ok) setError(acpFailureText(result.error, "sign-in"));
    else if (!result.value)
      setError(
        intl.formatMessage({
          id: "acpAgents.acpAgentAccount.thisSignInRequestHas",
          defaultMessage: "This sign-in request has expired. Connect again to get a new one.",
        }),
      );
    else await then();
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-token-text-secondary">
        {action.message ||
          intl.formatMessage({
            id: "acpAgents.acpAgentAccount.continueInBrowser",
            defaultMessage: "The Agent asks you to continue in your browser.",
          })}{" "}
        {expiresText(action.expiresAt, intl)}
      </p>
      <AgentAccountBrowserActions url={action.url} pending={pending} authorize={accept} />
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function MethodAction({
  method,
  disabled,
  buttonRef,
  onStart,
  onSetVariables,
}: {
  readonly method: AcpSignInMethod;
  readonly disabled: boolean;
  readonly buttonRef: Ref<HTMLButtonElement>;
  readonly onStart: (methodId: string) => void;
  readonly onSetVariables: ((names: readonly string[]) => void) | undefined;
}) {
  const intl = useIntl();
  const described = (button: ReactElement) =>
    method.description ? (
      <NodexTooltip tooltipContent={method.description} side="top">
        {button}
      </NodexTooltip>
    ) : (
      button
    );
  if (method.kind !== "environment")
    return described(
      <NodexButton
        ref={buttonRef}
        size="sm"
        variant="secondary"
        disabled={disabled}
        focusableWhenDisabled
        onClick={() => onStart(method.id)}
      >
        {acpSignInActionLabel(method, intl)}
      </NodexButton>,
    );
  return (
    <span className="inline-flex items-center gap-1">
      {described(
        <NodexButton
          size="sm"
          variant="secondary"
          disabled={disabled || !onSetVariables || method.variables.length === 0}
          onClick={() => onSetVariables?.(method.variables)}
        >
          {acpSignInActionLabel(method, intl)}
        </NodexButton>,
      )}
      {method.link ? (
        <NodexIconButton
          size="sm"
          icon={OpenExternalIcon}
          ariaLabel={intl.formatMessage(
            { id: "acpAgents.acpAgentAccount.getValue", defaultMessage: "Get {value1}" },
            { value1: method.name },
          )}
          onClick={() => void openExternalUrl(method.link!)}
        />
      ) : null}
    </span>
  );
}

/**
 * The Agent's account: its sign-in methods, the active interaction, and sign-out. Methods come
 * from the Agent itself; an Agent that advertises none signs in with its own command line.
 */
export function AcpAgentAccount({
  instance,
  status,
  provider,
  activity,
  owner,
  documentationUrl,
  onSetVariables,
}: {
  readonly instance: AcpAgentInstanceConfig;
  readonly status: AcpInstanceStatus;
  readonly provider: AcpProviderSnapshot | undefined;
  readonly activity: AcpActivity | undefined;
  readonly owner: AcpAgentsOwner;
  readonly documentationUrl?: string | null;
  /** Adds secret environment rows for these names; absent where the editor is not mounted. */
  readonly onSetVariables?: (names: readonly string[]) => void;
}) {
  const intl = useIntl();
  const account = owner.account(instance.id);
  const view = useAgentAccount(account);
  const { accountRef, keepFocus } = useAgentAccountFocus();
  const state = view?.state ?? null;
  const active = isAgentAuthActive(state);
  const needsSignIn = status.kind === "sign-in";
  const connecting = status.kind === "connecting" || status.kind === "installing";
  // Methods are read when sign-in is the next step; reading initializes the Agent, never a session.
  const readMethods = needsSignIn && !view;
  useEffect(() => {
    if (readMethods) account.read();
  }, [account, readMethods]);

  const failure = activity?.phase === "failed" ? activity.failure : null;
  const methods = acpSignInMethods(state?.methods, failure?.authMethods);
  const urlAction = provider?.auth.action ?? failure?.authAction ?? null;
  // A newer refusal (the instance's status asks for sign-in) outranks an earlier account read.
  const signedIn =
    !needsSignIn &&
    (provider?.auth.status === "authenticated" || (state?.phase === "succeeded" && !active));
  const pending = view?.request === "start" || view?.request === "respond";
  const busy = pending || view?.request === "cancel" || view?.request === "sign-out";
  let description: ReactNode;
  // Another window's sign-in shows only that it is underway; it can't be continued or cancelled here.
  if (active && !state?.cancellable && state?.message) description = state.message;
  else if (active)
    description =
      state?.phase === "starting"
        ? intl.formatMessage({
            id: "acpAgents.acpAgentAccount.startingSignIn",
            defaultMessage: "Starting sign-in…",
          })
        : state?.phase === "verifying"
          ? intl.formatMessage({
              id: "acpAgents.acpAgentAccount.checkingTheAccount",
              defaultMessage: "Checking the account…",
            })
          : state?.interaction?.type === "terminal"
            ? intl.formatMessage({
                id: "acpAgents.acpAgentAccount.signInUsingTheTerminal",
                defaultMessage: "Sign in using the terminal below.",
              })
            : state?.interaction?.type === "credentials"
              ? intl.formatMessage({
                  id: "acpAgents.acpAgentAccount.enterTheDetailsTheAgent",
                  defaultMessage: "Enter the details the Agent asks for.",
                })
              : intl.formatMessage({
                  id: "acpAgents.acpAgentAccount.continueSigningInFromYour",
                  defaultMessage: "Continue signing in from your browser.",
                });
  else if (signedIn)
    description = provider?.auth.email
      ? intl.formatMessage(
          {
            id: "acpAgents.acpAgentAccount.signedInAsValue",
            defaultMessage: "Signed in as {value1}",
          },
          { value1: provider.auth.email },
        )
      : intl.formatMessage({
          id: "acpAgents.acpAgentAccount.signedIn",
          defaultMessage: "Signed in",
        });
  else if (needsSignIn)
    description =
      methods.length > 0 || urlAction
        ? intl.formatMessage({
            id: "acpAgents.acpAgentAccount.signInToUseThis",
            defaultMessage: "Sign in to use this Agent.",
          })
        : intl.formatMessage({
            id: "acpAgents.acpAgentAccount.signInWithTheAgent",
            defaultMessage: "Sign in with the Agent's own command line, then check again.",
          });
  else if (status.kind === "ready")
    // An Agent that reports no account still works; one sharing this computer's setup is signed
    // in however its own command line is.
    description =
      instance.credentials.kind === "inherit-host-profile"
        ? intl.formatMessage({
            id: "acpAgents.acpAgentAccount.usesThisComputersSignIn",
            defaultMessage: "Uses its sign-in on this computer.",
          })
        : intl.formatMessage({
            id: "acpAgents.acpAgentAccount.noSignInReported",
            defaultMessage: "No sign-in reported by the Agent.",
          });
  else
    description = intl.formatMessage({
      id: "acpAgents.acpAgentAccount.connectToCheckAccount",
      defaultMessage: "Connect to check the account.",
    });

  const failureText =
    view?.failure !== null && view?.failure !== undefined
      ? acpFailureText(view.failure.failure, view.failure.context)
      : state?.phase === "failed" && state.message
        ? state.message
        : null;

  return (
    <AgentAccountControls
      owner={account}
      view={view}
      description={description}
      failure={failureText}
      accountRef={accountRef}
      keepFocus={keepFocus}
      actions={
        <>
          {needsSignIn && methods.length === 0 && documentationUrl ? (
            <NodexButton
              size="sm"
              variant="ghost"
              onClick={() => void openExternalUrl(documentationUrl)}
            >
              <OpenExternalIcon className="icon-2xs" />
              <FormattedMessage id="acpAgents.acpAgentAccount.docs" defaultMessage="Docs" />
            </NodexButton>
          ) : null}
          {/* Rechecks after signing in elsewhere, such as with the Agent's own command line. */}
          <NodexButton
            ref={keepFocus}
            size="sm"
            variant="ghost"
            disabled={busy || connecting}
            focusableWhenDisabled
            onClick={() => owner.connect(instance.id)}
          >
            {connecting
              ? intl.formatMessage({
                  id: "acpAgents.acpAgentAccount.checking",
                  defaultMessage: "Checking…",
                })
              : intl.formatMessage({
                  id: "acpAgents.acpAgentAccount.checkAgain",
                  defaultMessage: "Check again",
                })}
          </NodexButton>
          {signedIn && provider?.auth.canLogout ? (
            <NodexButton
              ref={keepFocus}
              size="sm"
              variant="ghost"
              disabled={busy || connecting}
              focusableWhenDisabled
              onClick={account.signOut}
            >
              {view?.request === "sign-out"
                ? intl.formatMessage({
                    id: "acpAgents.acpAgentAccount.signingOut",
                    defaultMessage: "Signing out…",
                  })
                : intl.formatMessage({
                    id: "acpAgents.acpAgentAccount.signOut",
                    defaultMessage: "Sign out",
                  })}
            </NodexButton>
          ) : null}
        </>
      }
      signInMethods={
        needsSignIn && (methods.length > 0 || urlAction) ? (
          <div className="flex flex-col gap-3 px-4 pb-3">
            {methods.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {methods.map((method) => (
                  <MethodAction
                    key={method.id}
                    method={method}
                    disabled={busy || connecting}
                    buttonRef={keepFocus}
                    onStart={account.signIn}
                    onSetVariables={onSetVariables}
                  />
                ))}
              </div>
            ) : null}
            {urlAction ? (
              <UrlSignIn instanceId={instance.id} action={urlAction} owner={owner} />
            ) : null}
          </div>
        ) : null
      }
    />
  );
}
