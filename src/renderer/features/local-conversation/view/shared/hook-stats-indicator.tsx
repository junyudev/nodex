import { footerText, formatFooterNumber } from "./thread-footer-i18n";
import { CODEX_HOOK_EVENT_LABELS } from "@/lib/codex-hooks-model";
import { Fragment } from "react";
import { HooksIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { normalizeCodexHooksSettingsSource } from "@/lib/codex-hooks-route";
import { resolveCodexThreadDetailLevel } from "@/lib/codex-thread-settings";
import { useCodexThreadSettings } from "@/lib/use-codex-thread-settings";
import type { HookStats } from "../../projection/hook-stats";

const sources = {
  admin: "Admin",
  user: "User",
  project: "Project",
  plugin: "Plugin",
  sessionFlags: "Session",
  unknown: "Unknown",
};
const entryLabels = { error: "Error", feedback: "Feedback", stop: "Stop", warning: "Message" };

export function HookStatsIndicator({ stats }: { stats: HookStats }) {
  const { settings } = useCodexThreadSettings();
  const detailed = resolveCodexThreadDetailLevel(settings.detailLevel) === "STEPS_COMMANDS";
  return (
    <NodexTooltip
      side="top"
      delay={700}
      tooltipClassName="rounded-2xl border px-3 py-2"
      style={{ maxWidth: "min(32rem, var(--available-width), calc(100vw - 16px))" }}
      tooltipContent={
        <div className="flex min-w-0 flex-col gap-2 text-start">
          <div className="font-medium">{footerText(detailed ? "Hooks" : "Hooks summary")}</div>
          {detailed ? (
            <ul className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
              {stats.runs.map((run) => (
                <Fragment key={run.id}>
                  <li>{footerText(CODEX_HOOK_EVENT_LABELS[run.eventName])}</li>
                  <li className="flex min-w-0 flex-col">
                    <span className="min-w-0 break-words whitespace-pre-wrap opacity-65">
                      {footerText(sources[normalizeCodexHooksSettingsSource(run.source)])}
                      {run.count > 1
                        ? ` · ${footerText("{count} runs", { count: formatFooterNumber(run.count) })}`
                        : null}
                    </span>
                    {run.statusMessage === null ? null : (
                      <span className="opacity-65">{run.statusMessage}</span>
                    )}
                    {run.entries.map((entry, index) => (
                      <span
                        key={index}
                        className={
                          entry.tone === "error" ? "text-[var(--color-text-warning)]" : "opacity-65"
                        }
                      >
                        {entry.text}
                      </span>
                    ))}
                  </li>
                </Fragment>
              ))}
            </ul>
          ) : (
            <>
              <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-1">
                <span className="opacity-65">{footerText("Ran")}</span>
                <span className="text-end">{formatFooterNumber(stats.count)}</span>
                {stats.blockedCount > 0 ? (
                  <>
                    <span className="opacity-65">{footerText("Blocked")}</span>
                    <span className="text-end">{formatFooterNumber(stats.blockedCount)}</span>
                  </>
                ) : null}
                {stats.errorCount > 0 ? (
                  <>
                    <span className="opacity-65">{footerText("Errors")}</span>
                    <span className="text-end">{formatFooterNumber(stats.errorCount)}</span>
                  </>
                ) : null}
              </div>
              {stats.entries.length > 0 ? (
                <ul className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                  {stats.entries.map((entry, index) => (
                    <li key={index} className="contents">
                      <span className="opacity-65">{footerText(entryLabels[entry.kind])}</span>
                      <span className="min-w-0 break-words whitespace-pre-wrap">{entry.text}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
      }
    >
      <button
        type="button"
        aria-label={footerText("Hooks")}
        className="electron:[&>svg]:icon-sm no-drag flex cursor-default items-center justify-center rounded-full border border-transparent p-0.5 text-token-text-tertiary select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:bg-token-list-hover-background focus-visible:text-token-foreground electron:rounded-md electron:p-1"
      >
        <HooksIcon className="icon-xs shrink-0" />
      </button>
    </NodexTooltip>
  );
}
