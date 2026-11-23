import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "@/lib/i18n";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentAccountBackend } from "../../../shared/agent-accounts-api";
import type { AntigravityAuthMethod } from "../../../shared/agents/antigravity";
import { agentAccountCatalog, agentAccountsRuntime } from "../../lib/agent-accounts-runtime";
import {
  AgentAccountControls,
  useAgentAccount,
  useAgentAccountFocus,
} from "./agent-account-controls";
import { createAgentAccountOwner, type AgentAccountOwner } from "./agent-account-owner";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];
type Backend = AgentAccountBackend;
const accounts = new Map<string, AgentAccountOwner>();

function accountFor(backend: Backend): AgentAccountOwner {
  const existing = accounts.get(backend.instanceId);
  if (existing) return existing;
  const owner = createAgentAccountOwner({ runtime: agentAccountsRuntime, backend });
  accounts.set(backend.instanceId, owner);
  return owner;
}

function useKnownProvider(instanceId: string | null) {
  const [provider, setProvider] = useState<Provider>();
  useEffect(() => {
    if (!instanceId) return;
    let latest: ReturnType<typeof agentAccountCatalog.read> | null = null;
    const read = () => {
      const request = agentAccountCatalog.read();
      latest = request;
      void request
        .then((providers) => {
          if (latest === request)
            setProvider(providers?.find((entry) => entry.instanceId === instanceId));
        })
        .catch(() => {});
    };
    const stop = agentAccountCatalog.subscribe(read);
    read();
    return () => {
      latest = null;
      stop();
    };
  }, [instanceId]);
  return provider;
}

/** The account of an enabled, saved Antigravity profile, as a row of its editor. */
export function AntigravityAccountRow({
  backend,
  authMethod,
}: {
  readonly backend: Backend;
  /** The saved method determines whether the account opens Google or connects directly. */
  readonly authMethod: AntigravityAuthMethod;
}) {
  return <AntigravityAccount key={backend.instanceId} backend={backend} authMethod={authMethod} />;
}

function AntigravityAccount({
  backend,
  authMethod,
}: {
  readonly backend: Backend;
  readonly authMethod: AntigravityAuthMethod;
}) {
  const intl = useIntl();
  const owner = accountFor(backend);
  const view = useAgentAccount(owner);
  const { accountRef, keepFocus } = useAgentAccountFocus();
  const provider = useKnownProvider(backend.instanceId);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => owner.read(), [owner]);

  const computer = authMethod === "computer";
  const browser = computer || authMethod === "oauth-personal" || authMethod === "oauth-business";
  const state = view?.state;
  const starting = view?.request === "start" || state?.phase === "starting";
  const signedIn =
    provider?.auth.status === "authenticated" &&
    (!provider.auth.type || provider.auth.type === authMethod);
  const signingOut = view?.request === "sign-out";
  const description = (() => {
    if (starting)
      return browser
        ? intl.formatMessage({
            id: "acpAgents.acpAgentAccount.startingSignIn",
            defaultMessage: "Starting sign-in…",
          })
        : intl.formatMessage({ id: "agentAccount.connecting", defaultMessage: "Connecting…" });
    if (state?.phase === "verifying" || view?.request === "respond")
      return intl.formatMessage({
        id: "agentAccount.checkingAccess",
        defaultMessage: "Checking Antigravity access and models…",
      });
    if (state?.phase === "waiting")
      return state.cancellable
        ? intl.formatMessage({
            id: "agentAccount.finishInBrowser",
            defaultMessage: "Finish signing in in your browser.",
          })
        : state.message;
    if (signedIn && provider.auth.email)
      return intl.formatMessage(
        {
          id: "acpAgents.acpAgentAccount.signedInAsValue",
          defaultMessage: "Signed in as {value1}",
        },
        { value1: provider.auth.email },
      );
    if (signedIn)
      return browser
        ? intl.formatMessage({
            id: "acpAgents.acpAgentAccount.signedIn",
            defaultMessage: "Signed in",
          })
        : intl.formatMessage({ id: "agentAccount.connected", defaultMessage: "Connected" });
    return browser
      ? intl.formatMessage({
          id: "agentAccount.signInToUseProfile",
          defaultMessage: "Sign in to use this profile.",
        })
      : intl.formatMessage({
          id: "agentAccount.connectToUseProfile",
          defaultMessage: "Connect to use this profile.",
        });
  })();
  const failure =
    view?.failure?.failure.message ?? (state?.phase === "failed" ? state.message : null);

  const actionLabel = (() => {
    if (signingOut)
      return intl.formatMessage({
        id: "acpAgents.acpAgentAccount.signingOut",
        defaultMessage: "Signing out…",
      });
    if (signedIn)
      return intl.formatMessage({
        id: "acpAgents.acpAgentAccount.signOut",
        defaultMessage: "Sign out",
      });
    return browser
      ? intl.formatMessage({ id: "agentAccount.signIn", defaultMessage: "Sign in" })
      : intl.formatMessage({ id: "agentAccount.connect", defaultMessage: "Connect" });
  })();

  return (
    <>
      <AgentAccountControls
        owner={owner}
        view={view}
        description={description}
        failure={failure}
        cancellableStart
        variant="nested"
        browserHandoff={{
          codeHelp: intl.formatMessage({
            id: "agentAccount.codeHelp",
            defaultMessage: "The page's full URL works too.",
          }),
          callbackLabel: intl.formatMessage({
            id: "agentAccount.returnUrl",
            defaultMessage: "Antigravity page URL",
          }),
          callbackHelp: intl.formatMessage({
            id: "agentAccount.callbackHelp",
            defaultMessage: "Paste the full URL of the final Antigravity page.",
          }),
        }}
        accountRef={accountRef}
        keepFocus={keepFocus}
        actions={
          !signedIn || provider.auth.canLogout !== false ? (
            <NodexButton
              ref={keepFocus}
              size="sm"
              variant={signedIn ? "ghost" : "secondary"}
              disabled={view?.request === "read" || signingOut}
              focusableWhenDisabled
              onClick={() => (signedIn ? setConfirm(true) : owner.signIn())}
            >
              {actionLabel}
            </NodexButton>
          ) : null
        }
      />
      {confirm ? (
        <NodexDialog open onOpenChange={setConfirm}>
          <NodexDialogContent size="compact" showCloseButton={false}>
            <NodexDialogFrame>
              <NodexDialogHeader>
                <NodexDialogTitle>
                  <FormattedMessage
                    id="agentAccount.signOutTitle"
                    defaultMessage="Sign out of Antigravity?"
                  />
                </NodexDialogTitle>
                <NodexDialogDescription>
                  {computer ? (
                    <FormattedMessage
                      id="agentAccount.signOutComputerDescription"
                      defaultMessage="agy on this computer signs out too. Running chats on this profile will stop. Their history is kept."
                    />
                  ) : (
                    <FormattedMessage
                      id="agentAccount.signOutDescription"
                      defaultMessage="Running chats on this profile will stop. Their history is kept."
                    />
                  )}
                </NodexDialogDescription>
              </NodexDialogHeader>
              <NodexDialogFooter>
                <NodexDialogAction onClick={() => setConfirm(false)}>
                  <FormattedMessage id="acpAgents.acpAgentAccount.cancel" defaultMessage="Cancel" />
                </NodexDialogAction>
                <NodexDialogAction
                  tone="danger"
                  onClick={() => {
                    setConfirm(false);
                    owner.signOut();
                  }}
                >
                  <FormattedMessage
                    id="acpAgents.acpAgentAccount.signOut"
                    defaultMessage="Sign out"
                  />
                </NodexDialogAction>
              </NodexDialogFooter>
            </NodexDialogFrame>
          </NodexDialogContent>
        </NodexDialog>
      ) : null}
    </>
  );
}
