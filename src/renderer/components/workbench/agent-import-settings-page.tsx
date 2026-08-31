import {
  ActivitySpinnerIcon,
  CheckmarkIcon,
  FolderOpenIcon,
  RefreshIcon,
} from "@/components/shared/icons";
import { useCallback, useEffect, useState } from "react";
import type {
  AgentImportProgress,
  AgentImportResult,
  AgentImportScan,
  AgentImportSourceKind,
} from "../../../shared/agent-import";
import {
  applyAgentImport,
  scanAgentImport,
  scanPickedAgentImportHome,
} from "./workbench-settings-overlay-deps";
import { NodexButton } from "../ui/button";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
  NodexSettingsSection as SectionBlock,
} from "../ui/settings";
import { cn } from "../../lib/utils";

const SOURCE_OPTIONS: readonly {
  readonly kind: AgentImportSourceKind;
  readonly label: string;
  readonly description: string;
  readonly supportsPicker: boolean;
}[] = [
  {
    description:
      "Conversations, instructions, skills, MCP servers, hooks, commands, subagents, and plugins.",
    kind: "claude-code",
    label: "Claude Code",
    supportsPicker: false,
  },
  {
    description: "Recent rollout history plus safe, model-independent configuration and tools.",
    kind: "codex",
    label: "Codex",
    supportsPicker: true,
  },
] as const;

export interface AgentImportSettingsRuntime {
  readonly scan: (sourceKind: AgentImportSourceKind) => Promise<AgentImportScan>;
  readonly scanPickedHome: (sourceKind: AgentImportSourceKind) => Promise<AgentImportScan | null>;
  readonly apply: (scanId: string, itemIds: readonly string[]) => Promise<AgentImportResult>;
  readonly subscribeProgress: (listener: (progress: AgentImportProgress) => void) => () => void;
}

const DEFAULT_RUNTIME: AgentImportSettingsRuntime = {
  apply: applyAgentImport,
  scan: scanAgentImport,
  scanPickedHome: scanPickedAgentImportHome,
  subscribeProgress: (listener) => {
    if (!window.api) return () => undefined;
    return window.api.on("agent-import:progress", (payload) => {
      listener(payload as AgentImportProgress);
    });
  },
};

function ImportItemCheckbox({
  checked,
  disabled,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={`Import ${label}`}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded border-[0.5px] outline-hidden",
        "focus-visible:ring-token-focus focus-visible:ring-2",
        checked
          ? "border-transparent bg-token-foreground text-token-background"
          : "border-token-border bg-token-foreground/5 text-transparent",
        disabled && "cursor-not-allowed opacity-40",
      )}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="checkbox"
      type="button"
    >
      <CheckmarkIcon className="icon-xxs shrink-0" />
    </button>
  );
}

function formatOutcomeSummary(result: AgentImportResult): string {
  const totals = result.outcomes.reduce(
    (current, outcome) => ({
      failures: current.failures + outcome.failureCount,
      skipped: current.skipped + outcome.skippedCount,
      successes: current.successes + outcome.successCount,
    }),
    { failures: 0, skipped: 0, successes: 0 },
  );
  const parts = [`${totals.successes} imported`];
  if (totals.skipped > 0) parts.push(`${totals.skipped} skipped`);
  if (totals.failures > 0) parts.push(`${totals.failures} failed`);
  return parts.join(" · ");
}

export function AgentImportSettingsPage({
  open,
  runtime = DEFAULT_RUNTIME,
}: {
  readonly open: boolean;
  readonly runtime?: AgentImportSettingsRuntime;
}) {
  const [scan, setScan] = useState<AgentImportScan | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [scanningSource, setScanningSource] = useState<AgentImportSourceKind | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<AgentImportProgress | null>(null);
  const [result, setResult] = useState<AgentImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    return runtime.subscribeProgress(setProgress);
  }, [open, runtime]);

  const runScan = useCallback(
    async (sourceKind: AgentImportSourceKind, pickHome: boolean) => {
      if (scanningSource || importing) return;
      setScanningSource(sourceKind);
      setError(null);
      setResult(null);
      setProgress(null);
      try {
        const nextScan = pickHome
          ? await runtime.scanPickedHome(sourceKind)
          : await runtime.scan(sourceKind);
        if (!nextScan) return;
        setScan(nextScan);
        setSelectedItemIds(
          new Set(nextScan.items.filter((item) => item.defaultSelected).map((item) => item.id)),
        );
      } catch (scanError) {
        setScan(null);
        setSelectedItemIds(new Set());
        setError(
          scanError instanceof Error ? scanError.message : "Could not scan this agent home.",
        );
      } finally {
        setScanningSource(null);
      }
    },
    [importing, runtime, scanningSource],
  );

  const applyImport = useCallback(async () => {
    if (!scan || selectedItemIds.size === 0 || importing) return;
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const nextResult = await runtime.apply(scan.scanId, [...selectedItemIds]);
      setResult(nextResult);
      setScan(null);
      setSelectedItemIds(new Set());
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Could not import agent data.");
    } finally {
      setImporting(false);
    }
  }, [importing, runtime, scan, selectedItemIds]);

  return (
    <SettingsPageSurface
      title="Import agent data"
      subtitle="Copy selected history and setup into Nodex without changing the source."
    >
      <SectionBlock title="Sources">
        {SOURCE_OPTIONS.map((source) => (
          <SettingRow description={source.description} key={source.kind} label={source.label}>
            {source.supportsPicker ? (
              <NodexButton
                disabled={Boolean(scanningSource) || importing}
                onClick={() => void runScan(source.kind, true)}
                size="sm"
                variant="ghost"
              >
                <FolderOpenIcon className="icon-2xs shrink-0" />
                Choose folder
              </NodexButton>
            ) : null}
            <NodexButton
              disabled={Boolean(scanningSource) || importing}
              onClick={() => void runScan(source.kind, false)}
              size="sm"
              variant="secondary"
            >
              {scanningSource === source.kind ? (
                <ActivitySpinnerIcon className="icon-2xs shrink-0" icon={RefreshIcon} />
              ) : (
                <RefreshIcon className="icon-2xs shrink-0" />
              )}
              {scanningSource === source.kind ? "Scanning…" : "Scan"}
            </NodexButton>
          </SettingRow>
        ))}
      </SectionBlock>

      {scan ? (
        <SectionBlock title={`Import from ${scan.sourceLabel}`}>
          <div className="flex min-w-0 flex-col gap-1 p-3">
            <div className="truncate text-sm text-token-text-primary">{scan.sourceHome}</div>
            <div className="text-sm text-token-text-secondary">
              Source files stay unchanged. Authentication and connection secrets are never imported.
            </div>
          </div>
          {scan.items.map((item) => (
            <SettingRow
              description={item.description}
              key={item.id}
              label={`${item.label} · ${item.count}`}
            >
              <ImportItemCheckbox
                checked={selectedItemIds.has(item.id)}
                disabled={importing}
                label={item.label}
                onChange={(checked) => {
                  setSelectedItemIds((current) => {
                    const next = new Set(current);
                    if (checked) next.add(item.id);
                    else next.delete(item.id);
                    return next;
                  });
                }}
              />
            </SettingRow>
          ))}
          {scan.items.length === 0 ? (
            <div className="p-3 text-sm text-token-text-secondary">
              No new importable data was found.
            </div>
          ) : (
            <SettingRow
              description={
                scan.skippedAlreadyImportedSessions > 0
                  ? `${scan.skippedAlreadyImportedSessions} unchanged conversation${scan.skippedAlreadyImportedSessions === 1 ? " was" : "s were"} already imported.`
                  : "Imported conversations become independent Nodex history with new thread IDs."
              }
              label={
                importing && progress?.activeItemLabel
                  ? progress.activeItemLabel
                  : `${selectedItemIds.size} selected`
              }
            >
              <NodexButton
                disabled={selectedItemIds.size === 0 || importing}
                onClick={() => void applyImport()}
                size="sm"
                variant="primary"
              >
                {importing ? "Importing…" : "Import"}
              </NodexButton>
            </SettingRow>
          )}
        </SectionBlock>
      ) : null}

      {result ? (
        <SectionBlock title="Last import">
          <div className="flex flex-col gap-1 p-3">
            <div className="text-sm text-token-text-primary">
              {result.sourceLabel} · {formatOutcomeSummary(result)}
            </div>
            <div className="text-sm text-token-text-secondary">
              {result.importedThreadIds.length > 0
                ? `${result.importedThreadIds.length} conversation${result.importedThreadIds.length === 1 ? " is" : "s are"} now available in Chats.`
                : "Selected setup data is now owned by this Nodex profile."}
            </div>
          </div>
          {result.outcomes
            .filter((outcome) => outcome.failureCount > 0)
            .map((outcome) => (
              <div className="flex flex-col gap-1 p-3" key={outcome.itemId}>
                <div className="text-sm text-[var(--red-text)]">{outcome.label}</div>
                {outcome.messages.map((message) => (
                  <div className="text-sm text-token-text-secondary" key={message}>
                    {message}
                  </div>
                ))}
              </div>
            ))}
        </SectionBlock>
      ) : null}

      {error ? <div className="text-sm text-[var(--red-text)]">{error}</div> : null}
    </SettingsPageSurface>
  );
}
