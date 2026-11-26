import { FormattedMessage, useIntl, type IntlShape } from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useEffect, useState } from "react";
import type {
  AgentImportResult,
  AgentImportScan,
  AgentImportSourceKind,
} from "../../../shared/agent-import";
import { ActivitySpinnerIcon, ClaudeIcon, FolderOpenIcon } from "../shared/icons";
import { NodexButton } from "../ui/button";
import { NodexCheckbox, NodexSettingsRow } from "../ui/settings";
import {
  applyAgentImport,
  scanAgentImport,
  scanPickedAgentImportHome,
} from "./workbench-settings-overlay-deps";

export interface CodexSetupImportRuntime {
  readonly scan: (sourceKind: AgentImportSourceKind) => Promise<AgentImportScan>;
  readonly scanPickedHome: (sourceKind: AgentImportSourceKind) => Promise<AgentImportScan | null>;
  readonly apply: (scanId: string, itemIds: readonly string[]) => Promise<AgentImportResult>;
}

const defaultRuntime: CodexSetupImportRuntime = {
  scan: scanAgentImport,
  scanPickedHome: scanPickedAgentImportHome,
  apply: applyAgentImport,
};

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function resultSummary(intl: IntlShape, result: AgentImportResult) {
  const totals = result.outcomes.reduce(
    (sum, outcome) => ({
      added: sum.added + outcome.successCount,
      skipped: sum.skipped + outcome.skippedCount,
      failed: sum.failed + outcome.failureCount,
    }),
    { added: 0, skipped: 0, failed: 0 },
  );
  return [
    intl.formatMessage(
      { id: "workbench.codexSetupImportControl.added", defaultMessage: "{count} added" },
      { count: totals.added },
    ),
    ...(totals.skipped > 0
      ? [
          intl.formatMessage(
            { id: "workbench.codexSetupImportControl.skipped", defaultMessage: "{count} skipped" },
            { count: totals.skipped },
          ),
        ]
      : []),
    ...(totals.failed > 0
      ? [
          intl.formatMessage(
            { id: "workbench.codexSetupImportControl.failed", defaultMessage: "{count} failed" },
            { count: totals.failed },
          ),
        ]
      : []),
  ].join(" · ");
}

/**
 * Copies Agent setup into the active Codex home, which the Codex app and CLI also read. A scan is a
 * reviewable proposal; nothing is written until the selected categories are copied.
 */
export function CodexSetupImportControl({
  open,
  runtime = defaultRuntime,
}: {
  readonly open: boolean;
  readonly runtime?: CodexSetupImportRuntime;
}) {
  const intl = useIntl();
  const [scan, setScan] = useState<AgentImportScan | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<AgentImportSourceKind | "apply" | null>(null);
  const [result, setResult] = useState<AgentImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Scans expire; a reopened Settings page starts from the sources again.
  useEffect(() => {
    if (!open) return;
    return () => {
      setScan(null);
      setResult(null);
      setError(null);
    };
  }, [open]);

  const review = async (sourceKind: AgentImportSourceKind) => {
    if (pending) return;
    setPending(sourceKind);
    setError(null);
    setResult(null);
    return runWithCleanup(
      async () => {
        const next =
          sourceKind === "codex"
            ? await runtime.scanPickedHome(sourceKind)
            : await runtime.scan(sourceKind);
        if (!next) return;
        setScan(next);
        setSelected(
          new Set(next.items.filter((item) => item.defaultSelected).map((item) => item.id)),
        );
      },
      {
        onError: (cause) => {
          setScan(null);
          setError(errorMessage(cause));
        },
        cleanup: () => {
          setPending(null);
        },
      },
    );
  };

  const copy = async () => {
    if (!scan || selected.size === 0 || pending) return;
    setPending("apply");
    setError(null);
    return runWithCleanup(
      async () => {
        setResult(await runtime.apply(scan.scanId, [...selected]));
        setScan(null);
      },
      {
        onError: (cause) => {
          setError(errorMessage(cause));
        },
        cleanup: () => {
          setPending(null);
        },
      },
    );
  };

  const busy = pending !== null;
  const failures = result?.outcomes.filter((outcome) => outcome.failureCount > 0) ?? [];

  return (
    <>
      <NodexSettingsRow
        label={intl.formatMessage({
          id: "workbench.codexSetupImportControl.copySetup",
          defaultMessage: "Copy setup from",
        })}
        description={intl.formatMessage({
          id: "workbench.codexSetupImportControl.copyDescription",
          defaultMessage:
            "Brings in instructions, skills, MCP servers and more once you review them. Only what Codex is missing is added.",
        })}
      >
        <NodexButton
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void review("claude-code")}
        >
          {pending === "claude-code" ? (
            <ActivitySpinnerIcon className="size-3.5" />
          ) : (
            <ClaudeIcon className="size-3.5" />
          )}
          Claude Code
        </NodexButton>
        <NodexButton
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void review("codex")}
        >
          {pending === "codex" ? (
            <ActivitySpinnerIcon className="size-3.5" />
          ) : (
            <FolderOpenIcon className="size-3.5" />
          )}
          <FormattedMessage
            id="workbench.codexSetupImportControl.otherCodexHome"
            defaultMessage={"Other Codex home"}
          />
        </NodexButton>
      </NodexSettingsRow>

      {scan ? (
        <div
          role="group"
          aria-label={intl.formatMessage(
            {
              id: "workbench.codexSetupImportControl.setupFrom",
              defaultMessage: "Setup from {source}",
            },
            { source: scan.sourceLabel },
          )}
          className="flex flex-col"
        >
          <div className="flex min-w-0 items-baseline gap-2 px-4 pt-3 pb-1 text-xs">
            <span className="shrink-0 font-medium text-token-text-primary">
              <FormattedMessage
                id="workbench.codexSetupImportControl.from"
                defaultMessage={"From"}
              />{" "}
              {scan.sourceLabel}
            </span>
            <span className="min-w-0 truncate text-token-description-foreground">
              {scan.sourceHome}
            </span>
          </div>
          {scan.items.map((item) => (
            <NodexSettingsRow
              key={item.id}
              variant="nested"
              label={item.label}
              description={item.description}
            >
              <span className="text-xs text-token-description-foreground tabular-nums">
                {item.count}
              </span>
              <NodexCheckbox
                ariaLabel={item.label}
                checked={selected.has(item.id)}
                disabled={busy}
                onCheckedChange={(checked) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked) next.add(item.id);
                    else next.delete(item.id);
                    return next;
                  })
                }
              />
            </NodexSettingsRow>
          ))}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-1 pb-3">
            <p className="min-w-48 flex-1 text-xs text-token-description-foreground">
              {scan.items.length === 0
                ? intl.formatMessage(
                    {
                      id: "workbench.codexSetupImportControl.nothingNew",
                      defaultMessage: "Nothing new to copy from {source}.",
                    },
                    { source: scan.sourceLabel },
                  )
                : intl.formatMessage({
                    id: "workbench.codexSetupImportControl.existingSetup",
                    defaultMessage:
                      "Existing setup is kept. Sign-ins and secrets are never copied.",
                  })}
            </p>
            <div className="ml-auto flex gap-2">
              <NodexButton size="sm" variant="ghost" disabled={busy} onClick={() => setScan(null)}>
                {scan.items.length === 0
                  ? intl.formatMessage({
                      id: "workbench.codexSetupImportControl.close",
                      defaultMessage: "Close",
                    })
                  : intl.formatMessage({
                      id: "workbench.codexSetupImportControl.cancel",
                      defaultMessage: "Cancel",
                    })}
              </NodexButton>
              {scan.items.length > 0 ? (
                <NodexButton
                  size="sm"
                  variant="primary"
                  disabled={busy || selected.size === 0}
                  onClick={() => void copy()}
                >
                  {pending === "apply"
                    ? intl.formatMessage({
                        id: "workbench.codexSetupImportControl.copying",
                        defaultMessage: "Copying…",
                      })
                    : intl.formatMessage({
                        id: "workbench.codexSetupImportControl.copy",
                        defaultMessage: "Copy",
                      })}
                </NodexButton>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {result ? (
        <NodexSettingsRow
          variant="nested"
          label={intl.formatMessage(
            {
              id: "workbench.codexSetupImportControl.copiedFrom",
              defaultMessage: "Copied from {source}",
            },
            { source: result.sourceLabel },
          )}
          description={
            <span role="status" className="flex flex-col gap-0.5">
              <span>{resultSummary(intl, result)}</span>
              {failures.map((outcome) => (
                <span key={outcome.itemId} className="text-danger">
                  {outcome.label}:{" "}
                  {outcome.messages.join(" ") ||
                    intl.formatMessage({
                      id: "workbench.codexSetupImportControl.copyFailed",
                      defaultMessage: "Could not be copied.",
                    })}
                </span>
              ))}
            </span>
          }
        >
          <NodexButton size="sm" variant="ghost" onClick={() => setResult(null)}>
            <FormattedMessage id="workbench.codexSetupImportControl.done" defaultMessage={"Done"} />
          </NodexButton>
        </NodexSettingsRow>
      ) : null}

      {error ? (
        <div role="alert" className="px-4 py-3 text-xs text-danger">
          {error}
        </div>
      ) : null}
    </>
  );
}
