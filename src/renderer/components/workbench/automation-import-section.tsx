import { useEffect, useState } from "react";
import { NodexButton } from "@/components/ui/button";
import { NodexCheckbox, NodexSettingsSection } from "@/components/ui/settings";
import { ActivitySpinnerIcon, AgentProviderIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import { ConversationImportPlacement } from "./conversation-import-list";
import { formatAutomationScheduleLabel } from "@/features/automations/automation-model";
import { defineMessages, useIntl } from "@/lib/i18n";
import { importNativeAutomation } from "@/lib/native-automation-import";
import { buildAutomationsPath } from "@/lib/workbench-automations-routes";
import type {
  NativeAutomationBlocker,
  NativeAutomationCatalogResult,
  NativeAutomationImportRow,
} from "../../../shared/native-automation-import";

const reasons = defineMessages({
  "one-shot": { id: "settings.automationImport.oneTime", defaultMessage: "One-time task" },
  manual: { id: "settings.automationImport.manual", defaultMessage: "Manual-only task" },
  "cron-day-or": {
    id: "settings.automationImport.cronDayOr",
    defaultMessage: "Nodex can’t repeat this schedule",
  },
  invalid: {
    id: "settings.automationImport.invalidSchedule",
    defaultMessage: "Nodex can’t repeat this schedule",
  },
  "missing-folder": {
    id: "settings.automationImport.missingFolder",
    defaultMessage: "Working folder is unavailable",
  },
  "no-claude-profile": {
    id: "settings.automationImport.noProfile",
    defaultMessage: "No enabled Claude profile uses this history folder",
  },
  "missing-heartbeat": {
    id: "settings.automationImport.noTarget",
    defaultMessage: "Target conversation is unavailable",
  },
  "unsupported-task": {
    id: "settings.automationImport.unsupported",
    defaultMessage: "Nodex can’t import this task",
  },
  "deleted-automation": {
    id: "settings.automationImport.deleted",
    defaultMessage: "Imported Automation was deleted",
  },
} satisfies Record<NativeAutomationBlocker, { id: string; defaultMessage: string }>);

export function useAutomationImportCatalog(
  open: boolean,
  read: (() => Promise<NativeAutomationCatalogResult>) | undefined,
) {
  const [catalog, setCatalog] = useState<NativeAutomationCatalogResult>();
  const [failedRequest, setFailedRequest] = useState<number | null>(null);
  const [request, setRequest] = useState(0);
  useEffect(() => {
    if (!open || !read) return;
    let current = true;
    void read().then(
      (value) => {
        if (!current) return;
        setCatalog(value);
        setFailedRequest(null);
      },
      () => {
        if (current) setFailedRequest(request);
      },
    );
    return () => {
      current = false;
    };
  }, [open, read, request]);

  const failed = request === failedRequest;
  return {
    catalog,
    failed,
    loading: Boolean(open && read && !catalog && !failed),
    refresh: () => setRequest((value) => value + 1),
  };
}

/** Scheduled tasks to bring in, each as a paused Automation in the Project for its folder. */
export function AutomationImportSection({
  rows,
  failed,
  refresh,
  onOpen,
}: {
  rows: readonly NativeAutomationImportRow[];
  failed: boolean;
  refresh: () => void;
  onOpen?: (path: string) => void;
}) {
  const intl = useIntl();
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = useState<
    ReadonlyMap<string, { automationId?: string; failure?: string }>
  >(new Map());
  const [importing, setImporting] = useState<string | null>(null);
  if (!rows.length && !failed) return null;

  const busy = importing !== null;
  const automationIdOf = (row: NativeAutomationImportRow) =>
    row.status.kind === "imported" ? row.status.automationId : outcomes.get(row.id)?.automationId;
  const importable = rows.filter((row) => row.status.kind === "ready" && !automationIdOf(row));
  const selected = importable.filter(({ id }) => selection.has(id));
  const toggle = (id: string, checked: boolean) =>
    setSelection((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const submit = async () => {
    for (const row of selected) {
      setImporting(row.id);
      const result = await importNativeAutomation(row.selection).catch(() => ({
        kind: "failed" as const,
        message: intl.formatMessage({
          id: "settings.automationImport.failed",
          defaultMessage: "Couldn’t finish importing this Automation. Try again to continue.",
        }),
      }));
      const outcome =
        result.kind === "imported"
          ? { automationId: result.automationIds[0] }
          : { failure: result.message };
      setOutcomes((current) => new Map(current).set(row.id, outcome));
    }
    setImporting(null);
    setSelection(new Set());
    refresh();
  };

  return (
    <NodexSettingsSection
      title={intl.formatMessage({
        id: "settings.automationImport.heading",
        defaultMessage: "Scheduled tasks",
      })}
      footnote={intl.formatMessage({
        id: "settings.automationImport.footnote",
        defaultMessage:
          "Each comes in paused, as an automation in its folder’s project, with its runs from the last 30 days.",
      })}
    >
      {failed ? (
        <div className="flex items-center justify-between gap-2 px-4 py-2.5">
          <span role="alert" className="text-sm text-danger">
            {intl.formatMessage({
              id: "settings.automationImport.catalogFailed",
              defaultMessage: "Couldn’t read scheduled tasks.",
            })}
          </span>
          <NodexButton size="sm" variant="ghost" onClick={refresh}>
            {intl.formatMessage({
              id: "settings.automationImport.tryAgain",
              defaultMessage: "Try again",
            })}
          </NodexButton>
        </div>
      ) : null}
      {rows.length ? (
        <ul className="flex flex-col py-1.5">
          {rows.map((row) => {
            const outcome = outcomes.get(row.id);
            const automationId = automationIdOf(row);
            const ready = row.status.kind === "ready" && !automationId;
            const checked = ready && selection.has(row.id);
            const schedule =
              row.schedule.kind === "rrule"
                ? formatAutomationScheduleLabel(
                    { kind: row.kind, trigger: { kind: "clock", rrule: row.schedule.rrule } },
                    intl,
                  )
                : null;
            const runs =
              row.kind === "cron" && row.runCount > 0
                ? intl.formatMessage(
                    {
                      id: "settings.automationImport.runCount",
                      defaultMessage: "{count, plural, one {# run} other {# runs}}",
                    },
                    { count: row.runCount },
                  )
                : null;
            const meta = [schedule, runs].filter(Boolean).join(" · ");
            const blocked =
              row.status.kind === "unavailable"
                ? intl.formatMessage(reasons[row.status.reason])
                : null;
            return (
              <li
                key={row.id}
                className={cn(
                  "mx-1.5 flex min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-1.5",
                  checked
                    ? "bg-token-foreground/5"
                    : ready && "hover:bg-token-list-hover-background",
                )}
              >
                <div className="flex min-h-6 min-w-0 items-center gap-3">
                  {ready ? (
                    <NodexCheckbox
                      ariaLabel={row.name}
                      checked={checked}
                      disabled={busy}
                      onCheckedChange={(next) => toggle(row.id, next)}
                    />
                  ) : (
                    <span aria-hidden className="size-3.5 shrink-0" />
                  )}
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <AgentProviderIcon kind={row.agent} className="size-3.5 shrink-0" />
                    <span
                      className={cn(
                        "min-w-0 truncate text-sm",
                        ready ? "text-token-text-primary" : "text-token-text-secondary",
                      )}
                    >
                      {row.name}
                    </span>
                    {meta ? (
                      <span className="shrink-0 truncate text-xs text-token-description-foreground">
                        {meta}
                      </span>
                    ) : null}
                  </div>
                  {importing === row.id ? (
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-token-text-secondary">
                      <ActivitySpinnerIcon className="icon-2xs" />
                      {intl.formatMessage({
                        id: "settings.automationImport.importing",
                        defaultMessage: "Importing…",
                      })}
                    </span>
                  ) : automationId ? (
                    onOpen ? (
                      <NodexButton
                        size="xs"
                        variant="secondary"
                        onClick={() => onOpen(buildAutomationsPath({ automationId }))}
                      >
                        {intl.formatMessage({
                          id: "settings.automationImport.open",
                          defaultMessage: "Open",
                        })}
                      </NodexButton>
                    ) : (
                      <span className="shrink-0 text-xs text-token-description-foreground">
                        {intl.formatMessage({
                          id: "settings.automationImport.imported",
                          defaultMessage: "Imported",
                        })}
                      </span>
                    )
                  ) : blocked ? (
                    <span className="max-w-[40%] shrink-0 truncate text-xs text-token-description-foreground">
                      {blocked}
                    </span>
                  ) : (
                    <ConversationImportPlacement placement={row.placement} />
                  )}
                </div>
                {outcome?.failure && !automationId ? (
                  <p role="alert" className="pl-[26px] text-xs text-danger">
                    {outcome.failure}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {importable.length ? (
        <div className="flex min-w-0 items-center gap-3 border-t-[0.5px] border-token-border px-4 py-2.5">
          <span className="min-w-0 flex-1 text-xs text-token-text-secondary">
            {selected.length
              ? intl.formatMessage(
                  {
                    id: "settings.automationImport.selected",
                    defaultMessage: "{count} selected",
                  },
                  { count: selected.length },
                )
              : null}
          </span>
          <NodexButton
            size="sm"
            variant="primary"
            disabled={busy || !selected.length}
            onClick={() => void submit()}
          >
            {intl.formatMessage(
              {
                id: "settings.automationImport.import",
                defaultMessage:
                  "{count, plural, =0 {Import} one {Import # task} other {Import # tasks}}",
              },
              { count: selected.length },
            )}
          </NodexButton>
        </div>
      ) : null}
    </NodexSettingsSection>
  );
}
