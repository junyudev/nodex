import { FormattedMessage, getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { CopyIcon, OpenExternalIcon } from "@/components/shared/icons";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NodexSettingsRow } from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import { openExternalUrl } from "@/lib/file-system-operations";
import { focusFallbackRef } from "@/lib/focus-fallback";
import type { AcpAgentInstanceConfig } from "../../../shared/acp-agent-settings";
import {
  acpFailureText,
  acpSignInActionLabel,
  acpSignInMethods,
  isAcpAuthActive,
  type AcpActivity,
  type AcpAuthInteraction,
  type AcpInstanceStatus,
  type AcpProviderSnapshot,
  type AcpSignInMethod,
  type AcpUrlAuthAction,
} from "./acp-agent-model";
import type { AcpAgentsOwner } from "./acp-agents-owner";
import { useAcpAgents } from "./use-acp-agents";

const AcpAuthTerminal = lazy(() => import("./acp-auth-terminal"));

const copy = async (text: string, label: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(
      getIntl().formatMessage(
        { id: "acpAgents.acpAgentAccount.valueCopied", defaultMessage: "{value1} copied" },
        { value1: label },
      ),
    );
  } catch {
    toast.danger(
      getIntl().formatMessage(
        {
          id: "acpAgents.acpAgentAccount.couldnTCopyTheValue",
          defaultMessage: "Couldn't copy the {value1}",
        },
        { value1: label.toLowerCase() },
      ),
    );
  }
};

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
      <div className="flex items-center gap-2">
        <NodexButton
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => void accept(() => openExternalUrl(action.url))}
        >
          <OpenExternalIcon className="icon-2xs" />
          <FormattedMessage
            id="acpAgents.acpAgentAccount.openSignInPage"
            defaultMessage="Open sign-in page"
          />
        </NodexButton>
        <NodexIconButton
          size="sm"
          icon={CopyIcon}
          ariaLabel={intl.formatMessage({
            id: "acpAgents.acpAgentAccount.linkCopy",
            defaultMessage: "Copy sign-in link",
          })}
          disabled={pending}
          onClick={() =>
            void accept(() =>
              copy(
                action.url,
                intl.formatMessage({
                  id: "acpAgents.acpAgentAccount.signInLink",
                  defaultMessage: "Sign-in link",
                }),
              ),
            )
          }
        />
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CredentialsForm({
  interaction,
  disabled,
  onSubmit,
}: {
  readonly interaction: Extract<AcpAuthInteraction, { type: "credentials" }>;
  readonly disabled: boolean;
  readonly onSubmit: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(values);
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      {interaction.fields.map((field, index) => (
        <label key={field.name} className="flex flex-col gap-1 text-xs text-token-text-secondary">
          {field.label}
          <Input
            className="h-8 text-sm"
            type={field.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            autoFocus={index === 0}
            value={values[field.name] ?? ""}
            disabled={disabled}
            onChange={(event) =>
              setValues((current) => ({ ...current, [field.name]: event.target.value }))
            }
          />
        </label>
      ))}
      <div>
        <NodexButton type="submit" size="sm" variant="secondary" disabled={disabled}>
          <FormattedMessage id="acpAgents.acpAgentAccount.continue" defaultMessage="Continue" />
        </NodexButton>
      </div>
    </form>
  );
}

function ActiveInteraction({
  instanceId,
  interaction,
  owner,
  pending,
}: {
  readonly instanceId: string;
  readonly interaction: AcpAuthInteraction;
  readonly owner: AcpAgentsOwner;
  readonly pending: boolean;
}) {
  const intl = useIntl();
  switch (interaction.type) {
    case "terminal":
      return (
        <div className="flex flex-col gap-1.5">
          <Suspense
            fallback={
              <p className="text-xs text-token-text-secondary">
                <FormattedMessage
                  id="acpAgents.acpAgentAccount.openingTerminal"
                  defaultMessage="Opening terminal…"
                />
              </p>
            }
          >
            <AcpAuthTerminal
              key={interaction.id}
              output={interaction.output}
              outputOffset={interaction.outputOffset}
              onInput={(data) => owner.terminalInput(instanceId, data)}
              onResize={(size) => owner.terminalResize(instanceId, size)}
            />
          </Suspense>
          <p className="text-xs text-token-description-foreground">
            <FormattedMessage
              id="acpAgents.acpAgentAccount.finishSigningInHereNodex"
              defaultMessage="Finish signing in here. Nodex checks the account after the command exits."
            />
          </p>
        </div>
      );
    case "browser": {
      const open = async (then: () => Promise<unknown>) => {
        if (interaction.requiresConsent && !(await owner.respondBrowser(instanceId, true))) return;
        await then();
      };
      return (
        <div className="flex items-center gap-2">
          <NodexButton
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => void open(() => openExternalUrl(interaction.url))}
          >
            <OpenExternalIcon className="icon-2xs" />
            <FormattedMessage
              id="acpAgents.acpAgentAccount.openSignInPage"
              defaultMessage="Open sign-in page"
            />
          </NodexButton>
          <NodexIconButton
            size="sm"
            icon={CopyIcon}
            ariaLabel={intl.formatMessage({
              id: "acpAgents.acpAgentAccount.linkCopy",
              defaultMessage: "Copy sign-in link",
            })}
            disabled={pending}
            onClick={() =>
              void open(() =>
                copy(
                  interaction.url,
                  intl.formatMessage({
                    id: "acpAgents.acpAgentAccount.signInLink",
                    defaultMessage: "Sign-in link",
                  }),
                ),
              )
            }
          />
        </div>
      );
    }
    case "deviceCode":
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-token-text-secondary">
            <FormattedMessage id="acpAgents.acpAgentAccount.enter" defaultMessage="Enter" />
          </span>
          <code className="rounded-md bg-token-foreground/5 px-1.5 py-0.5 font-code select-all">
            {interaction.userCode}
          </code>
          <NodexIconButton
            size="sm"
            icon={CopyIcon}
            ariaLabel={intl.formatMessage({
              id: "acpAgents.acpAgentAccount.codeCopy",
              defaultMessage: "Copy code",
            })}
            onClick={() =>
              void copy(
                interaction.userCode,
                intl.formatMessage({
                  id: "acpAgents.acpAgentAccount.code",
                  defaultMessage: "Code",
                }),
              )
            }
          />
          <NodexButton
            size="sm"
            variant="secondary"
            onClick={() => void openExternalUrl(interaction.url)}
          >
            <OpenExternalIcon className="icon-2xs" />
            <FormattedMessage id="acpAgents.acpAgentAccount.openPage" defaultMessage="Open page" />
          </NodexButton>
        </div>
      );
    case "credentials":
      return (
        <CredentialsForm
          interaction={interaction}
          disabled={pending}
          onSubmit={(values) => owner.submitCredentials(instanceId, values)}
        />
      );
  }
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
  const snapshot = useAcpAgents(owner);
  const view = snapshot.auth.get(instance.id);
  const state = view?.state ?? null;
  const active = isAcpAuthActive(state);
  const needsSignIn = status.kind === "sign-in";
  const connecting = status.kind === "connecting" || status.kind === "installing";
  useEffect(() => owner.retainAuth(instance.id), [owner, instance.id]);
  // Methods are read when sign-in is the next step; reading initializes the Agent, never a session.
  const readMethods = needsSignIn && !view;
  useEffect(() => {
    if (readMethods) owner.readAuth(instance.id);
  }, [owner, instance.id, readMethods]);

  const failure = activity?.phase === "failed" ? activity.failure : null;
  const methods = acpSignInMethods(state?.methods, failure?.authMethods);
  const urlAction = provider?.auth.action ?? failure?.authAction ?? null;
  // A newer refusal (the instance's status asks for sign-in) outranks an earlier account read.
  const signedIn =
    !needsSignIn &&
    (provider?.auth.status === "authenticated" || (state?.phase === "succeeded" && !active));
  const pending = view?.request === "start" || view?.request === "respond";
  const busy = pending || view?.request === "cancel" || view?.request === "sign-out";
  // Starting, cancelling or ending a sign-in replaces the control that did it. Its focus moves to
  // the account's first control: Cancel while signing in, then Check again.
  const accountRef = useRef<HTMLDivElement>(null);
  const keepFocusInAccount = focusFallbackRef(() =>
    accountRef.current?.querySelector<HTMLElement>("button:not(:disabled)"),
  );

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
    <div ref={accountRef} className="flex flex-col">
      <NodexSettingsRow
        label={intl.formatMessage({
          id: "acpAgents.acpAgentAccount.account",
          defaultMessage: "Account",
        })}
        description={<span role="status">{description}</span>}
      >
        {active ? (
          state?.cancellable ? (
            <NodexButton
              ref={keepFocusInAccount}
              size="sm"
              variant="ghost"
              disabled={view?.request === "cancel"}
              focusableWhenDisabled
              onClick={() => owner.cancelSignIn(instance.id)}
            >
              <FormattedMessage id="acpAgents.acpAgentAccount.cancel" defaultMessage="Cancel" />
            </NodexButton>
          ) : null
        ) : (
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
              ref={keepFocusInAccount}
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
                ref={keepFocusInAccount}
                size="sm"
                variant="ghost"
                disabled={busy || connecting}
                focusableWhenDisabled
                onClick={() => owner.signOut(instance.id)}
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
        )}
      </NodexSettingsRow>
      {!active && needsSignIn && (methods.length > 0 || urlAction) ? (
        <div className="flex flex-col gap-3 px-4 pb-3">
          {methods.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {methods.map((method) => (
                <MethodAction
                  key={method.id}
                  method={method}
                  disabled={busy || connecting}
                  buttonRef={keepFocusInAccount}
                  onStart={(methodId) => owner.signIn(instance.id, methodId)}
                  onSetVariables={onSetVariables}
                />
              ))}
            </div>
          ) : null}
          {urlAction ? (
            <UrlSignIn instanceId={instance.id} action={urlAction} owner={owner} />
          ) : null}
        </div>
      ) : null}
      {active && state?.interaction ? (
        <div className="px-4 pb-3">
          <ActiveInteraction
            instanceId={instance.id}
            interaction={state.interaction}
            owner={owner}
            pending={pending}
          />
        </div>
      ) : null}
      {failureText ? (
        <p role="alert" className="px-4 pb-3 text-xs text-danger">
          {failureText}
        </p>
      ) : null}
    </div>
  );
}
