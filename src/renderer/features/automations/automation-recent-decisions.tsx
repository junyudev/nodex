import { FormattedMessage, useIntl } from "@/lib/i18n";
import { useQuery } from "@tanstack/react-query";
import { automationDecisionsQueryOptions } from "@/lib/query-options";

export function AutomationRecentDecisions({
  automationId,
  timezone,
}: {
  automationId: string;
  timezone: string;
}) {
  const intl = useIntl();
  const decisions = useQuery(automationDecisionsQueryOptions(automationId));
  if (decisions.isPending) return null;
  return (
    <section
      aria-label={intl.formatMessage({
        id: "automations.automationRecentDecisions.recentDecisions",
        defaultMessage: "Recent decisions",
      })}
      className="flex flex-col gap-2"
    >
      <h2 className="text-sm text-token-text-secondary">
        <FormattedMessage
          id="automations.automationRecentDecisions.recentDecisions"
          defaultMessage="Recent decisions"
        />
      </h2>
      {decisions.isError ? (
        <button
          type="button"
          className="self-start text-sm text-token-text-secondary"
          onClick={() => void decisions.refetch()}
        >
          <FormattedMessage
            id="automations.automationRecentDecisions.couldNotLoadDecisionsRetry"
            defaultMessage="Could not load decisions · Retry"
          />
        </button>
      ) : decisions.data.length === 0 ? (
        <p className="text-sm text-token-description-foreground">
          <FormattedMessage
            id="automations.automationRecentDecisions.noDecisionsYet"
            defaultMessage="No decisions yet"
          />
        </p>
      ) : (
        <ol className="divide-y divide-token-border-light">
          {decisions.data.map((decision) => (
            <li key={decision.id} className="flex items-start gap-3 py-2 text-sm">
              <time
                className="shrink-0 text-token-description-foreground"
                dateTime={new Date(decision.occurredAt).toISOString()}
              >
                {new Intl.DateTimeFormat(intl.locale, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  timeZone: timezone,
                }).format(decision.occurredAt)}
              </time>
              <span className="min-w-0 flex-1 text-token-text-secondary">{decision.reason}</span>
              <span className="shrink-0 capitalize text-token-description-foreground">
                {decision.status === "failed"
                  ? intl.formatMessage({
                      id: "automations.automationRecentDecisions.failed",
                      defaultMessage: "Failed",
                    })
                  : decision.matched === false
                    ? intl.formatMessage({
                        id: "automations.automationRecentDecisions.notMatched",
                        defaultMessage: "Not matched",
                      })
                    : decision.matched === true
                      ? intl.formatMessage({
                          id: "automations.automationRecentDecisions.matched",
                          defaultMessage: "Matched",
                        })
                      : decision.mode === "dry_run"
                        ? intl.formatMessage({
                            id: "automations.automationRecentDecisions.dryRun",
                            defaultMessage: "Dry run",
                          })
                        : intl.formatMessage(
                            {
                              id: "automations.automationRecentDecisions.assessmentStatus",
                              defaultMessage:
                                "{status, select, completed {completed} failed {failed} other {{status}}}",
                            },
                            { status: decision.status },
                          )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
