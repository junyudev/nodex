import { FormattedMessage, getIntl, useIntl } from "@/lib/i18n";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
  type Ref,
  type RefCallback,
} from "react";
import { CopyIcon, OpenExternalIcon } from "@/components/shared/icons";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NodexSettingsRow } from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { openExternalUrl } from "@/lib/file-system-operations";
import { focusFallbackRef } from "@/lib/focus-fallback";
import type { AgentAccountState } from "../../../shared/agent-accounts-api";
import {
  isAgentAuthActive,
  type AgentAccountOwner,
  type AgentAccountView,
} from "./agent-account-owner";

interface BrowserHandoff {
  readonly codeHelp: string;
  readonly callbackLabel: string;
  readonly callbackHelp: string;
}

type AgentAuthInteraction = NonNullable<AgentAccountState["interaction"]>;
const AgentAuthTerminal = lazy(() => import("./agent-auth-terminal"));

export function useAgentAccount(owner: AgentAccountOwner) {
  useEffect(() => owner.retain(), [owner]);
  return useSyncExternalStore(owner.subscribe, owner.getSnapshot);
}

const copyAccountText = async (text: string, label: string) => {
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

export function AgentAccountBrowserActions({
  url,
  pending,
  authorize,
  openBrowserLabel,
}: {
  readonly url: string;
  readonly pending: boolean;
  readonly authorize?: (then: () => Promise<unknown>) => Promise<void>;
  readonly openBrowserLabel?: boolean;
}) {
  const intl = useIntl();
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      if (authorize) await authorize(action);
      else await action();
    } catch {
      setError(
        intl.formatMessage({
          id: "agentAccount.openBrowserFailed",
          defaultMessage: "Couldn't open the sign-in page.",
        }),
      );
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <NodexButton
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            void run(async () => {
              if (!(await openExternalUrl(url))) throw new Error("Browser launch failed");
            })
          }
        >
          <OpenExternalIcon className="icon-2xs" />
          {openBrowserLabel ? (
            <FormattedMessage id="agentAccount.openBrowser" defaultMessage="Open browser" />
          ) : (
            <FormattedMessage
              id="acpAgents.acpAgentAccount.openSignInPage"
              defaultMessage="Open sign-in page"
            />
          )}
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
            void run(() =>
              copyAccountText(
                url,
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
  help,
  onSubmit,
}: {
  readonly interaction: Extract<AgentAuthInteraction, { type: "credentials" }>;
  readonly disabled: boolean;
  readonly help?: string;
  readonly onSubmit: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const helpId = useId();
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
            aria-describedby={help ? helpId : undefined}
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
      {help ? (
        <p id={helpId} className="text-xs text-token-description-foreground">
          {help}
        </p>
      ) : null}
      <div>
        <NodexButton
          type="submit"
          size="sm"
          variant="secondary"
          disabled={
            disabled ||
            (help !== undefined && interaction.fields.some(({ name }) => !values[name]?.trim()))
          }
        >
          <FormattedMessage id="acpAgents.acpAgentAccount.continue" defaultMessage="Continue" />
        </NodexButton>
      </div>
    </form>
  );
}

function ActiveInteraction({
  interaction,
  owner,
  pending,
  authorizationUrl,
  browserHandoff,
}: {
  readonly interaction: AgentAuthInteraction;
  readonly owner: AgentAccountOwner;
  readonly pending: boolean;
  readonly authorizationUrl: string | null;
  readonly browserHandoff?: BrowserHandoff;
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
            <AgentAuthTerminal
              key={interaction.id}
              output={interaction.output}
              outputOffset={interaction.outputOffset}
              onInput={(data) => owner.terminalInput(data)}
              onResize={(size) => owner.terminalResize(size)}
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
        if (interaction.requiresConsent && !(await owner.respondBrowser(true))) return;
        await then();
      };
      return (
        <div className="flex flex-col gap-2">
          <AgentAccountBrowserActions
            url={interaction.url}
            pending={pending}
            authorize={open}
            openBrowserLabel={browserHandoff !== undefined}
          />
          {browserHandoff && interaction.acceptsCallback ? (
            <CredentialsForm
              interaction={{
                type: "credentials",
                id: interaction.id,
                fields: [
                  {
                    name: "callbackUrl",
                    label: browserHandoff.callbackLabel,
                    secret: false,
                  },
                ],
              }}
              disabled={pending}
              help={browserHandoff.callbackHelp}
              onSubmit={({ callbackUrl }) => owner.complete(callbackUrl ?? "")}
            />
          ) : null}
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
              void copyAccountText(
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
        <div className="flex flex-col gap-2">
          {browserHandoff && authorizationUrl ? (
            <AgentAccountBrowserActions url={authorizationUrl} pending={pending} openBrowserLabel />
          ) : null}
          <CredentialsForm
            interaction={interaction}
            disabled={pending}
            help={browserHandoff?.codeHelp}
            onSubmit={owner.submitCredentials}
          />
        </div>
      );
  }
}

export function useAgentAccountFocus() {
  // Restore focus to the next account control when the action that held it disappears.
  const accountRef = useRef<HTMLDivElement>(null);
  const keepFocus = useCallback<RefCallback<HTMLButtonElement>>(
    (control) =>
      focusFallbackRef(() =>
        accountRef.current?.querySelector<HTMLElement>("button:not(:disabled)"),
      )(control),
    [],
  );
  return { accountRef, keepFocus };
}

export function AgentAccountControls({
  owner,
  view,
  description,
  failure,
  accountRef,
  keepFocus,
  actions,
  signInMethods,
  browserHandoff,
  cancellableStart = false,
  variant = "default",
}: {
  readonly owner: AgentAccountOwner;
  readonly view: AgentAccountView | null;
  readonly description: ReactNode;
  readonly failure: string | null;
  readonly accountRef: Ref<HTMLDivElement>;
  readonly keepFocus: Ref<HTMLButtonElement>;
  readonly actions: ReactNode;
  readonly signInMethods?: ReactNode;
  readonly browserHandoff?: BrowserHandoff;
  readonly cancellableStart?: boolean;
  /** Nested when the account is one row of a profile's editor. */
  readonly variant?: "default" | "nested";
}) {
  const intl = useIntl();
  const state = view?.state;
  const active = isAgentAuthActive(state) || (cancellableStart && view?.request === "start");
  return (
    <div ref={accountRef} className="flex flex-col">
      <NodexSettingsRow
        variant={variant}
        label={intl.formatMessage({
          id: "acpAgents.acpAgentAccount.account",
          defaultMessage: "Account",
        })}
        description={<span role="status">{description}</span>}
      >
        {active ? (
          state?.cancellable || (cancellableStart && view?.request === "start") ? (
            <NodexButton
              ref={keepFocus}
              size="sm"
              variant="ghost"
              disabled={view?.request === "cancel"}
              focusableWhenDisabled
              onClick={owner.cancelSignIn}
            >
              <FormattedMessage id="acpAgents.acpAgentAccount.cancel" defaultMessage="Cancel" />
            </NodexButton>
          ) : null
        ) : (
          actions
        )}
      </NodexSettingsRow>
      {!active ? signInMethods : null}
      {active && state?.interaction ? (
        <div className="px-4 pb-3">
          <ActiveInteraction
            key={state.interaction.id}
            interaction={state.interaction}
            owner={owner}
            pending={view?.request === "respond" || view?.request === "cancel"}
            authorizationUrl={state.authorizationUrl}
            browserHandoff={browserHandoff}
          />
        </div>
      ) : null}
      {failure ? (
        <p role="alert" className="px-4 pb-3 text-xs text-danger">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
