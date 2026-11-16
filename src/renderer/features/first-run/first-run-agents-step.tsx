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
import { TerminalPanel } from "@/components/board/terminal-panel";
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
import {
  claudeInstallPreview,
  resolveClaudeSignInCommand,
  runSetupTerminal,
} from "./first-run-terminal";

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
    case "acp":
      return (
        <AgentInstanceIcon
          binding={{ kind: "acp", agentDefinitionId: mark.agentDefinitionId }}
          className={className}
        />
      );
    default:
      return <AgentProviderIcon kind={mark.kind} className={className} />;
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

type ClaudeSetup =
  | { readonly kind: "preview"; readonly command: string }
  | { readonly kind: "running"; readonly title: string; readonly command: string };

function CodexApiKeyForm({ onSubmit }: { readonly onSubmit: (apiKey: string) => Promise<void> }) {
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
}: {
  readonly entry: FirstRunEntry;
  readonly onContinue: () => void;
}) {
  const intl = useIntl();
  const agents = useFirstRunAgents();
  const [claudeSetup, setClaudeSetup] = useState<ClaudeSetup | null>(null);
  const [usingApiKey, setUsingApiKey] = useState(false);
  const [addingKey, setAddingKey] = useState(false);
  const [signingIn, setSigningIn] = useState<string | null>(null);

  const withoutAgent = agents.settled && !agents.anyReady;

  const act = (row: FirstRunAgentRow) => {
    const kind = row.action?.kind;
    if (kind === "api-key-add") {
      setAddingKey((current) => !current);
    } else if (kind === "acp-sign-in") {
      setSigningIn((current) =>
        current === row.action?.target ? null : (row.action?.target ?? null),
      );
    } else if (kind === "claude-install") {
      setClaudeSetup({ kind: "preview", command: claudeInstallPreview() });
    } else if (kind === "claude-sign-in") {
      void resolveClaudeSignInCommand()
        .then((command) =>
          setClaudeSetup({
            kind: "running",
            title: intl.formatMessage({
              id: "firstRun.firstRunAgentsStep.signInToClaudeCode",
              defaultMessage: "Sign in to Claude Code",
            }),
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
    (row.action?.kind === "acp-sign-in" && signingIn === row.action.target);
  const finishClaudeSetup = () => {
    setClaudeSetup(null);
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
                    {row.action?.kind === "codex-sign-in" ? (
                      <NodexButton
                        size="sm"
                        variant="ghostSecondary"
                        onClick={() => setUsingApiKey((current) => !current)}
                      >
                        <FormattedMessage
                          id="firstRun.firstRunAgentsStep.useAPIKey"
                          defaultMessage="Use API key"
                        />
                      </NodexButton>
                    ) : null}
                    {row.action ? (
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
            {row.offersTopUp ? <NodexCredits account={agents.nodexAccount} /> : null}
            {row.id === "api-key" && addingKey ? (
              <ProviderKeyForm
                className="ps-[62px] pe-3.5 pb-3.5"
                keys={agents.providerKeys}
                onConnected={() => setAddingKey(false)}
              />
            ) : null}
            {row.action?.kind === "acp-sign-in" && signingIn === row.action.target ? (
              <AcpSignIn instanceId={signingIn} acp={agents.acp} />
            ) : null}
            {row.id === "codex" && usingApiKey && row.state === "action" ? (
              <CodexApiKeyForm onSubmit={agents.useCodexApiKey} />
            ) : null}
            {row.id === "claude" && claudeSetup?.kind === "preview" ? (
              <div className="flex items-center gap-2 ps-[62px] pe-3.5 pb-3.5">
                <code className="min-w-0 flex-1 truncate rounded-md bg-token-foreground/5 px-2 py-1.5 font-mono text-xs">
                  {claudeSetup.command}
                </code>
                <NodexButton
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setClaudeSetup({
                      kind: "running",
                      title: intl.formatMessage({
                        id: "firstRun.firstRunAgentsStep.installClaudeCode",
                        defaultMessage: "Install Claude Code",
                      }),
                      command: claudeSetup.command,
                    })
                  }
                >
                  <FormattedMessage id="firstRun.firstRunAgentsStep.run" defaultMessage="Run" />
                </NodexButton>
              </div>
            ) : null}
            {row.id === "claude" && claudeSetup?.kind === "running" ? (
              <SetupTerminal
                title={claudeSetup.title}
                command={claudeSetup.command}
                onExit={finishClaudeSetup}
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
