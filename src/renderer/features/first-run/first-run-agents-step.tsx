import { type AgentSetupTarget } from "@/lib/agent-settings-navigation";
import { FormattedMessage, useIntl } from "@/lib/i18n";
import { useEffect, useState } from "react";
import {
  ActivitySpinnerIcon,
  AgentInstanceIcon,
  AgentProviderIcon,
  NodexLogoMarkIcon,
  ProviderKeyIcon,
  ProviderKeyPresetsIcon,
  SuccessCircleIcon,
} from "@/components/shared/icons";
import { TerminalPanel } from "@/components/workbench/workbench-terminal-panel";
import { NodexHomeMark } from "@/components/ui/nodex-home-mark";
import { NodexButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toastFailure } from "@/lib/failure-toast";
import { NodexTopUpTiers } from "@/features/nodex-account/nodex-top-up";
import { AcpAgentAccount } from "../acp-agents/acp-agent-account";
import { acpInstanceStatus } from "../acp-agents/acp-agent-model";
import { acpAgentsOwner } from "../acp-agents/use-acp-agents";
import { ProviderKeyForm } from "../provider-keys/provider-key-form";
import { useFirstRunAgents } from "./first-run-agents";
import type { FirstRunAgentMark, FirstRunAgentRow, FirstRunEntry } from "./first-run-model";
import { FirstRunCard, FirstRunPrimary, FirstRunRow, FirstRunTitle } from "./first-run-frame";
import { firstRunTerminalSetup, runSetupTerminal } from "./first-run-terminal";

function AgentMark({ mark }: { readonly mark: FirstRunAgentMark }) {
  const className = "size-[18px] shrink-0";
  switch (mark.kind) {
    case "nodex":
      return <NodexLogoMarkIcon monochrome className={className} />;
    case "key":
      return mark.preset ? (
        <ProviderKeyIcon preset={mark.preset} className={className} />
      ) : (
        <ProviderKeyPresetsIcon className="size-[26px] gap-[2px]" />
      );
    case "registry":
      return <AgentInstanceIcon binding={{ driver: mark.driver }} className={className} />;
    default:
      return <AgentProviderIcon kind={mark.driver} className={className} />;
  }
}

/**
 * Each Agent's mark sits on its own small tile, as an app icon does. Sizes are whole pixels (a 36px
 * tile, an 18px mark, or four 12px marks) so the vectors land on the pixel grid at any scale.
 */
function AgentRowIcon({ mark }: { readonly mark: FirstRunAgentMark }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-token-main-surface-primary text-token-text-primary shadow-[0_1px_1px_rgba(0,0,0,0.04)] ring-[0.5px] ring-token-border">
      <AgentMark mark={mark} />
    </span>
  );
}

/** An ACP Agent's own sign-in, in place under its row. */
function AcpSignIn({
  instanceId,
  acp,
}: {
  readonly instanceId: string;
  readonly acp: ReturnType<typeof useFirstRunAgents>["acp"];
}) {
  const instance = acp.settings?.instances.find(({ id }) => id === instanceId);
  if (!instance) return null;
  const provider = acp.providers.get(instance.id);
  const activity = acp.activities.get(instance.id);
  return (
    <div className="ps-[62px] pe-3.5 pb-3.5">
      <AcpAgentAccount
        instance={instance}
        status={acpInstanceStatus({
          instance,
          inspection: acp.inspections.get(instance.id),
          provider,
          activity,
        })}
        provider={provider}
        activity={activity}
        owner={acpAgentsOwner}
      />
    </div>
  );
}

/** One setup command running where the person can answer it. */
function SetupTerminal({
  title,
  command,
  onExit,
}: {
  readonly title: string;
  readonly command: string;
  readonly onExit: (exitCode: number | null) => void;
}) {
  const [terminalId] = useState(() => `first-run:${crypto.randomUUID()}`);
  useEffect(
    () => runSetupTerminal({ terminalId, title, command, onExit }),
    [command, onExit, terminalId, title],
  );
  return (
    <div className="mx-3.5 mb-3 h-44 overflow-hidden rounded-lg border-[0.5px] border-token-border">
      {/* Main opens a Terminal without a usable folder in the person's home directory. */}
      <TerminalPanel terminalId={terminalId} cwd="~" />
    </div>
  );
}

type TerminalSetup =
  | { readonly kind: "preview"; readonly rowId: string; readonly command: string }
  | {
      readonly kind: "running";
      readonly rowId: string;
      readonly title: string;
      readonly command: string;
    };

function BrowserApiKeyForm({ onSubmit }: { readonly onSubmit: (apiKey: string) => Promise<void> }) {
  const intl = useIntl();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex items-center gap-2 ps-[62px] pe-3.5 pb-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!apiKey.trim() || busy) return;
        setBusy(true);
        void onSubmit(apiKey.trim())
          .catch((cause: unknown) =>
            toastFailure(
              intl.formatMessage({
                id: "firstRun.firstRunAgentsStep.couldnTUseThatAPI",
                defaultMessage: "Couldn’t use that API key",
              }),
              cause,
            ),
          )
          .finally(() => setBusy(false));
      }}
    >
      <Input
        aria-label={intl.formatMessage({
          id: "firstRun.firstRunAgentsStep.openAIAPIKey",
          defaultMessage: "OpenAI API key",
        })}
        autoFocus
        className="h-8 flex-1 text-sm"
        placeholder={intl.formatMessage({
          id: "firstRun.firstRunAgentsStep.aPIKey",
          defaultMessage: "API key",
        })}
        spellCheck={false}
        type="password"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
      />
      <NodexButton size="sm" variant="secondary" disabled={!apiKey.trim() || busy} type="submit">
        <FormattedMessage id="firstRun.firstRunAgentsStep.useKey" defaultMessage="Use key" />
      </NodexButton>
    </form>
  );
}

/** Credits are one way to start among several, so this offers them and never asks for them. */
function NodexCredits({
  account,
}: {
  readonly account: ReturnType<typeof useFirstRunAgents>["nodexAccount"];
}) {
  return (
    <div className="flex flex-col gap-2 ps-[62px] pe-3.5 pb-3.5">
      <NodexTopUpTiers account={account} compact />
      {account.snapshot?.modelStatus?.topUp.available ? (
        <p className="m-0 text-xs text-token-description-foreground">
          <FormattedMessage
            id="firstRun.firstRunAgentsStep.youPayInYourBrowser"
            defaultMessage="You pay in your browser. Or add credits later in Settings → Account."
          />
        </p>
      ) : null}
    </div>
  );
}

export function FirstRunAgentsStep({
  entry,
  onContinue,
  onOpenAgentSettings,
}: {
  readonly entry: FirstRunEntry;
  readonly onContinue: () => void;
  readonly onOpenAgentSettings: (target?: AgentSetupTarget) => void;
}) {
  const intl = useIntl();
  const agents = useFirstRunAgents();
  const [terminalSetup, setTerminalSetup] = useState<TerminalSetup | null>(null);
  const [apiKeyRow, setApiKeyRow] = useState<string | null>(null);
  const [addingKey, setAddingKey] = useState(false);
  const [signingIn, setSigningIn] = useState<string | null>(null);

  const withoutAgent = agents.settled && !agents.anyReady;

  const act = (row: FirstRunAgentRow) => {
    const kind = row.action?.kind;
    if (kind === "agent-settings") {
      onOpenAgentSettings(row.action?.binding);
    } else if (kind === "api-key-add") {
      setAddingKey((current) => !current);
    } else if (kind === "inline-sign-in") {
      setSigningIn((current) =>
        current === row.action?.target ? null : (row.action?.target ?? null),
      );
    } else if (kind === "terminal-install" || kind === "terminal-sign-in") {
      const terminal = firstRunTerminalSetup(row.action?.sourceId);
      if (!terminal) return;
      if (kind === "terminal-install") {
        setTerminalSetup({ kind: "preview", command: terminal.previewInstall(), rowId: row.id });
        return;
      }
      void terminal
        .signInCommand()
        .then((command) =>
          setTerminalSetup({
            kind: "running",
            rowId: row.id,
            title: intl.formatMessage(
              {
                id: "agentReadiness.signInToAgent",
                defaultMessage: "Sign in to {label}",
              },
              { label: row.label },
            ),
            command,
          }),
        )
        .catch((cause: unknown) =>
          toastFailure(
            intl.formatMessage({
              id: "firstRun.firstRunAgentsStep.couldnTStartSigningIn",
              defaultMessage: "Couldn’t start signing in",
            }),
            cause,
          ),
        );
    } else if (row.action) {
      void agents.run(row.action);
    }
  };
  /** A row whose form or sign-in is open beneath it; its button closes it again. */
  const opened = (row: FirstRunAgentRow) =>
    (row.action?.kind === "api-key-add" && addingKey) ||
    (row.action?.kind === "inline-sign-in" && signingIn === row.action.target);
  const finishTerminalSetup = () => {
    setTerminalSetup(null);
    void agents.checkAgain();
  };

  return (
    <>
      <div className="mb-5 flex justify-center">
        <NodexHomeMark />
      </div>
      <FirstRunTitle
        title={intl.formatMessage({
          id: "firstRun.firstRunAgentsStep.connectAnAgent",
          defaultMessage: "Connect an agent",
        })}
        description={intl.formatMessage({
          id: "firstRun.firstRunAgentsStep.useTheCodingAgentsYouHave",
          defaultMessage: "Use the coding agents you already have, or a model provider’s API key.",
        })}
      />
      <FirstRunCard>
        {agents.rows.map((row) => (
          <div key={row.id}>
            <FirstRunRow
              leading={<AgentRowIcon mark={row.mark} />}
              label={row.label}
              detail={row.detail}
              trailing={
                row.state === "ready" ? (
                  <SuccessCircleIcon
                    aria-label={intl.formatMessage({
                      id: "firstRun.firstRunAgentsStep.ready",
                      defaultMessage: "Ready",
                    })}
                    className="icon-sm shrink-0 text-info"
                  />
                ) : row.state === "checking" ? (
                  <ActivitySpinnerIcon className="icon-xs text-token-description-foreground" />
                ) : (
                  <>
                    {row.action?.kind === "browser-sign-in" ? (
                      <NodexButton
                        size="sm"
                        variant="ghostSecondary"
                        onClick={() =>
                          setApiKeyRow((current) => (current === row.id ? null : row.id))
                        }
                      >
                        <FormattedMessage
                          id="firstRun.firstRunAgentsStep.useAPIKey"
                          defaultMessage="Use API key"
                        />
                      </NodexButton>
                    ) : null}
                    {row.action?.kind === "check-again" && agents.checkingAgain ? (
                      <ActivitySpinnerIcon className="icon-xs text-token-description-foreground" />
                    ) : row.action ? (
                      <NodexButton
                        size="sm"
                        variant={opened(row) ? "ghostSecondary" : "secondary"}
                        onClick={() => act(row)}
                      >
                        {opened(row)
                          ? intl.formatMessage({
                              id: "firstRun.firstRunAgentsStep.cancel",
                              defaultMessage: "Cancel",
                            })
                          : row.action.label}
                      </NodexButton>
                    ) : row.state === "waiting" ? (
                      <ActivitySpinnerIcon className="icon-xs text-token-description-foreground" />
                    ) : null}
                  </>
                )
              }
            />
            {row.note ? (
              // The Agent's own words, kept selectable so they can be searched or sent to someone.
              // The padding sits outside the clamp, which would otherwise show another line in it.
              <div className="ps-[62px] pe-3.5 pb-3">
                <p className="m-0 line-clamp-3 text-xs break-words text-token-description-foreground select-text">
                  {row.note}
                </p>
              </div>
            ) : null}
            {row.offersTopUp ? <NodexCredits account={agents.nodexAccount} /> : null}
            {row.id === "api-key" && addingKey ? (
              <ProviderKeyForm
                className="ps-[62px] pe-3.5 pb-3.5"
                keys={agents.providerKeys}
                onConnected={() => setAddingKey(false)}
              />
            ) : null}
            {row.action?.kind === "inline-sign-in" && signingIn === row.action.target ? (
              <AcpSignIn instanceId={signingIn} acp={agents.acp} />
            ) : null}
            {row.id === apiKeyRow && row.state === "action" ? (
              <BrowserApiKeyForm onSubmit={agents.useBrowserApiKey} />
            ) : null}
            {terminalSetup?.rowId === row.id && terminalSetup.kind === "preview" ? (
              <div className="flex items-center gap-2 ps-[62px] pe-3.5 pb-3.5">
                <code className="min-w-0 flex-1 truncate rounded-md bg-token-foreground/5 px-2 py-1.5 font-mono text-xs">
                  {terminalSetup.command}
                </code>
                <NodexButton
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setTerminalSetup({
                      kind: "running",
                      rowId: row.id,
                      title: intl.formatMessage(
                        {
                          id: "agentReadiness.installAgent",
                          defaultMessage: "Install {label}",
                        },
                        { label: row.label },
                      ),
                      command: terminalSetup.command,
                    })
                  }
                >
                  <FormattedMessage id="firstRun.firstRunAgentsStep.run" defaultMessage="Run" />
                </NodexButton>
              </div>
            ) : null}
            {terminalSetup?.rowId === row.id && terminalSetup.kind === "running" ? (
              <SetupTerminal
                title={terminalSetup.title}
                command={terminalSetup.command}
                onExit={finishTerminalSetup}
              />
            ) : null}
          </div>
        ))}
      </FirstRunCard>
      <p className="mt-3 text-center text-xs text-token-description-foreground">
        <FormattedMessage
          id="firstRun.firstRunAgentsStep.youCanAddMoreIn"
          defaultMessage="You can add more in Settings → Agents."
        />
      </p>
      {/* Connecting is the whole point of the `connect` entry, and `Close` already leaves it. */}
      {entry !== "connect" || agents.anyReady ? (
        <FirstRunPrimary quiet={!agents.anyReady} onClick={onContinue}>
          {entry === "connect"
            ? intl.formatMessage({ id: "firstRun.firstRunAgentsStep.done", defaultMessage: "Done" })
            : withoutAgent
              ? intl.formatMessage({
                  id: "firstRun.firstRunAgentsStep.continueWithoutAnAgent",
                  defaultMessage: "Continue without an agent",
                })
              : intl.formatMessage({
                  id: "firstRun.firstRunAgentsStep.continue",
                  defaultMessage: "Continue",
                })}
        </FirstRunPrimary>
      ) : null}
    </>
  );
}
