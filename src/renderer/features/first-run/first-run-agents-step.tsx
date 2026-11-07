import { useEffect, useState } from "react";
import {
  ActivitySpinnerIcon,
  AgentProviderIcon,
  NodexLogoMarkIcon,
  SuccessCircleIcon,
} from "@/components/shared/icons";
import { TerminalPanel } from "@/components/board/terminal-panel";
import { NodexHomeMark } from "@/components/ui/nodex-home-mark";
import { NodexButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toastFailure } from "@/lib/failure-toast";
import { NodexTopUpTiers } from "@/features/nodex-account/nodex-top-up";
import { useFirstRunAgents } from "./first-run-agents";
import type { FirstRunAgentRow, FirstRunEntry } from "./first-run-model";
import { FirstRunCard, FirstRunPrimary, FirstRunRow, FirstRunTitle } from "./first-run-frame";
import {
  claudeInstallPreview,
  resolveClaudeSignInCommand,
  runSetupTerminal,
} from "./first-run-terminal";

function AgentRowIcon({ id }: { readonly id: FirstRunAgentRow["id"] }) {
  if (id === "nodex") return <NodexLogoMarkIcon monochrome className="size-5 shrink-0" />;
  return <AgentProviderIcon kind={id} className="size-5 shrink-0" />;
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
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex items-center gap-2 px-3.5 pb-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!apiKey.trim() || busy) return;
        setBusy(true);
        void onSubmit(apiKey.trim())
          .catch((cause: unknown) => toastFailure("Couldn’t use that API key", cause))
          .finally(() => setBusy(false));
      }}
    >
      <Input
        aria-label="OpenAI API key"
        autoFocus
        className="h-8 flex-1 text-sm"
        placeholder="API key"
        spellCheck={false}
        type="password"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
      />
      <NodexButton size="sm" variant="secondary" disabled={!apiKey.trim() || busy} type="submit">
        Use key
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
    <div className="flex flex-col gap-2 px-3.5 pb-3">
      <NodexTopUpTiers account={account} compact />
      {account.snapshot?.modelStatus?.topUp.available ? (
        <p className="m-0 text-xs text-token-description-foreground">
          You pay in your browser. Or add credits later in Settings → Account.
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
  const agents = useFirstRunAgents();
  const [claudeSetup, setClaudeSetup] = useState<ClaudeSetup | null>(null);
  const [usingApiKey, setUsingApiKey] = useState(false);

  const withoutAgent = agents.settled && !agents.anyReady;

  const act = (row: FirstRunAgentRow) => {
    const kind = row.action?.kind;
    if (kind === "claude-install") {
      setClaudeSetup({ kind: "preview", command: claudeInstallPreview() });
    } else if (kind === "claude-sign-in") {
      void resolveClaudeSignInCommand()
        .then((command) =>
          setClaudeSetup({ kind: "running", title: "Sign in to Claude Code", command }),
        )
        .catch((cause: unknown) => toastFailure("Couldn’t start signing in", cause));
    } else if (kind) {
      void agents.run(kind);
    }
  };
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
        title="Connect an agent"
        description="Nodex runs the coding agents you already use. Their sign-ins stay with them."
      />
      <FirstRunCard>
        {agents.rows.map((row) => (
          <div key={row.id}>
            <FirstRunRow
              leading={<AgentRowIcon id={row.id} />}
              label={row.label}
              detail={row.detail}
              trailing={
                row.state === "ready" ? (
                  <SuccessCircleIcon aria-label="Ready" className="icon-sm shrink-0 text-info" />
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
                        Use API key
                      </NodexButton>
                    ) : null}
                    {row.action ? (
                      <NodexButton size="sm" variant="secondary" onClick={() => act(row)}>
                        {row.action.label}
                      </NodexButton>
                    ) : row.state === "waiting" ? (
                      <ActivitySpinnerIcon className="icon-xs text-token-description-foreground" />
                    ) : null}
                  </>
                )
              }
            />
            {row.offersTopUp ? <NodexCredits account={agents.nodexAccount} /> : null}
            {row.id === "codex" && usingApiKey && row.state === "action" ? (
              <CodexApiKeyForm onSubmit={agents.useCodexApiKey} />
            ) : null}
            {row.id === "claude" && claudeSetup?.kind === "preview" ? (
              <div className="flex items-center gap-2 px-3.5 pb-3">
                <code className="min-w-0 flex-1 truncate rounded-md bg-token-foreground/5 px-2 py-1.5 font-mono text-xs">
                  {claudeSetup.command}
                </code>
                <NodexButton
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setClaudeSetup({
                      kind: "running",
                      title: "Install Claude Code",
                      command: claudeSetup.command,
                    })
                  }
                >
                  Run
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
        You can add more in Settings → Agents.
      </p>
      {/* Connecting is the whole point of the `connect` entry, and `Close` already leaves it. */}
      {entry !== "connect" || agents.anyReady ? (
        <FirstRunPrimary quiet={!agents.anyReady} onClick={onContinue}>
          {entry === "connect" ? "Done" : withoutAgent ? "Continue without an agent" : "Continue"}
        </FirstRunPrimary>
      ) : null}
    </>
  );
}
