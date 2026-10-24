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

function resultSummary(result: AgentImportResult) {
  const totals = result.outcomes.reduce(
    (sum, outcome) => ({
      added: sum.added + outcome.successCount,
      skipped: sum.skipped + outcome.skippedCount,
      failed: sum.failed + outcome.failureCount,
    }),
    { added: 0, skipped: 0, failed: 0 },
  );
  return [
    `${totals.added} added`,
    ...(totals.skipped > 0 ? [`${totals.skipped} skipped`] : []),
    ...(totals.failed > 0 ? [`${totals.failed} failed`] : []),
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
    try {
      const next =
        sourceKind === "codex"
          ? await runtime.scanPickedHome(sourceKind)
          : await runtime.scan(sourceKind);
      if (!next) return;
      setScan(next);
      setSelected(
        new Set(next.items.filter((item) => item.defaultSelected).map((item) => item.id)),
      );
    } catch (cause) {
      setScan(null);
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  const copy = async () => {
    if (!scan || selected.size === 0 || pending) return;
    setPending("apply");
    setError(null);
    try {
      setResult(await runtime.apply(scan.scanId, [...selected]));
      setScan(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  const busy = pending !== null;
  const failures = result?.outcomes.filter((outcome) => outcome.failureCount > 0) ?? [];

  return (
    <>
      <NodexSettingsRow
        label="Copy setup from"
        description="Adds only what this Codex home is missing. The Codex app and CLI use the same setup."
      >
        <NodexButton
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void review("claude-code")}
        >
          {pending === "claude-code" ? (
            <ActivitySpinnerIcon className="icon-2xs" />
          ) : (
            <ClaudeIcon className="size-3.5" />
          )}
          Claude Code
        </NodexButton>
        <NodexButton size="sm" variant="ghost" disabled={busy} onClick={() => void review("codex")}>
          {pending === "codex" ? (
            <ActivitySpinnerIcon className="icon-2xs" />
          ) : (
            <FolderOpenIcon className="icon-2xs" />
          )}
          Other Codex home
        </NodexButton>
      </NodexSettingsRow>

      {scan ? (
        <div role="group" aria-label={`Setup from ${scan.sourceLabel}`} className="flex flex-col">
          <div className="flex min-w-0 items-baseline gap-2 px-4 pt-3 pb-1 text-xs">
            <span className="shrink-0 font-medium text-token-text-primary">
              From {scan.sourceLabel}
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
                ? `Nothing new to copy from ${scan.sourceLabel}.`
                : "Existing setup is kept. Sign-ins and secrets are never copied."}
            </p>
            <div className="ml-auto flex gap-2">
              <NodexButton size="sm" variant="ghost" disabled={busy} onClick={() => setScan(null)}>
                {scan.items.length === 0 ? "Close" : "Cancel"}
              </NodexButton>
              {scan.items.length > 0 ? (
                <NodexButton
                  size="sm"
                  variant="primary"
                  disabled={busy || selected.size === 0}
                  onClick={() => void copy()}
                >
                  {pending === "apply" ? "Copying…" : "Copy"}
                </NodexButton>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {result ? (
        <NodexSettingsRow
          variant="nested"
          label={`Copied from ${result.sourceLabel}`}
          description={
            <span role="status" className="flex flex-col gap-0.5">
              <span>{resultSummary(result)}</span>
              {failures.map((outcome) => (
                <span key={outcome.itemId} className="text-danger">
                  {outcome.label}: {outcome.messages.join(" ") || "Could not be copied."}
                </span>
              ))}
            </span>
          }
        >
          <NodexButton size="sm" variant="ghost" onClick={() => setResult(null)}>
            Done
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
