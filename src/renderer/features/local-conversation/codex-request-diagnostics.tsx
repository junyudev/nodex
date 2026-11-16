import { useIntl, type IntlShape } from "@/lib/i18n";
import { useCallback, useId, useState, useSyncExternalStore } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import {
  NodexCollapsiblePanel,
  NodexCollapsibleRoot,
  NodexCollapsibleTrigger,
} from "@/components/ui/collapsible";
import { NodexCheckbox } from "@/components/ui/settings";
import { cn } from "@/lib/utils";
import {
  clearCodexRequestRecords,
  type CodexRecordedRequest,
  getCodexRequestRecordsSnapshot,
  subscribeCodexRequestRecords,
} from "./codex-request-recorder";

const requestTimeOptions = {
  fractionalSecondDigits: 3,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
} as const;

const EMPTY_REQUESTS: readonly CodexRecordedRequest[] = [];

function requestDuration(request: CodexRecordedRequest, intl: IntlShape): string {
  if (request.status === "pending")
    return intl.formatMessage({
      id: "conversation.codexRequestDiagnostics.pending",
      defaultMessage: "Pending",
    });
  const durationMs = request.durationMs ?? 0;
  const duration =
    durationMs < 1_000
      ? intl.formatMessage(
          { id: "conversation.codexRequestDiagnostics.milliseconds", defaultMessage: "{value} ms" },
          { value: intl.formatNumber(durationMs, { useGrouping: false }) },
        )
      : intl.formatMessage(
          { id: "conversation.codexRequestDiagnostics.seconds", defaultMessage: "{value} s" },
          {
            value: intl.formatNumber(durationMs / 1000, {
              useGrouping: false,
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }),
          },
        );
  const status =
    request.status === "completed"
      ? intl.formatMessage({
          id: "conversation.codexRequestDiagnostics.completed",
          defaultMessage: "Completed",
        })
      : request.status === "timed-out"
        ? intl.formatMessage({
            id: "conversation.codexRequestDiagnostics.timedOut",
            defaultMessage: "Timed out",
          })
        : intl.formatMessage({
            id: "conversation.codexRequestDiagnostics.failed",
            defaultMessage: "Failed",
          });
  return intl.formatMessage(
    {
      id: "conversation.codexRequestDiagnostics.requestDuration",
      defaultMessage: "{status} · {duration}",
    },
    { status, duration },
  );
}

function isFailedRequest(request: CodexRecordedRequest): boolean {
  return request.status === "failed" || request.status === "timed-out";
}

function PayloadPreview({
  payload,
  kind,
}: {
  payload: string;
  kind: "params" | "result" | "error";
}) {
  const intl = useIntl();
  const title = intl.formatMessage(
    {
      id: "conversation.codexRequestDiagnostics.payloadTitle",
      defaultMessage: "{kind, select, params {Params} result {Result} other {Error}}",
    },
    { kind },
  );
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs semantic-text-secondary">
        <span>{title}</span>
        <NodexButton
          variant="ghost"
          size="xs"
          aria-label={intl.formatMessage(
            {
              id: "conversation.codexRequestDiagnostics.copyPayload",
              defaultMessage:
                "{kind, select, params {Copy params} result {Copy result} other {Copy error}}",
            },
            { kind },
          )}
          onClick={() => {
            void navigator.clipboard?.writeText(payload).catch(() => undefined);
          }}
        >
          {intl.formatMessage({
            id: "conversation.codexRequestDiagnostics.copy",
            defaultMessage: "Copy",
          })}
        </NodexButton>
      </div>
      <pre className="codex-tool-code max-h-52 overflow-auto rounded-md bg-(--color-background-primary-soft) p-2 font-mono text-size-code whitespace-pre-wrap break-words text-default">
        {payload}
      </pre>
    </div>
  );
}

function RequestDetails({ request }: { request: CodexRecordedRequest }) {
  const intl = useIntl();
  return (
    <details className="group/request min-w-0">
      <summary className="flex cursor-interaction list-none items-center justify-between gap-3 py-2 outline-none marker:content-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-token-focus-border">
        <div className="flex min-w-0 items-center gap-2">
          <ChevronRightIcon className="icon-2xs shrink-0 semantic-text-secondary group-open/request:rotate-90" />
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-size-code text-default">{request.method}</span>
            <span className="shrink-0 text-xs text-tertiary tabular-nums">
              #{request.matchingRequestSequenceNumber}
            </span>
          </div>
        </div>
        <div className="shrink-0 text-right text-xs semantic-text-secondary tabular-nums">
          <div>{intl.formatTime(request.startedAtMs, requestTimeOptions)}</div>
          <div className={isFailedRequest(request) ? "text-danger" : undefined}>
            {requestDuration(request, intl)}
          </div>
        </div>
      </summary>
      <div className="min-w-0 space-y-3 border-t-[0.5px] border-default pt-3 pb-2">
        <div className="grid gap-2 text-xs break-words semantic-text-secondary md:grid-cols-2">
          <div>
            {intl.formatMessage(
              {
                id: "conversation.codexRequestDiagnostics.requestId",
                defaultMessage: "Request ID: {id}",
              },
              { id: request.id },
            )}
          </div>
          <div>
            {intl.formatMessage(
              {
                id: "conversation.codexRequestDiagnostics.timeout",
                defaultMessage: "Timeout: {duration}",
              },
              {
                duration:
                  request.timeoutMs > 0
                    ? request.timeoutMs
                    : intl.formatMessage({
                        id: "conversation.codexRequestDiagnostics.noTimeout",
                        defaultMessage: "none",
                      }),
              },
            )}
          </div>
          <div>
            {intl.formatMessage(
              {
                id: "conversation.codexRequestDiagnostics.priority",
                defaultMessage: "Priority: {priority}",
              },
              { priority: request.priority },
            )}
          </div>
          <div>
            {intl.formatMessage(
              {
                id: "conversation.codexRequestDiagnostics.source",
                defaultMessage: "Source: {source}",
              },
              { source: request.source },
            )}
          </div>
          <div>
            {intl.formatMessage(
              {
                id: "conversation.codexRequestDiagnostics.queued",
                defaultMessage: "Queued: {duration}ms",
              },
              { duration: request.queueWaitMs },
            )}
          </div>
          <div>
            {intl.formatMessage(
              { id: "conversation.codexRequestDiagnostics.ended", defaultMessage: "Ended: {time}" },
              {
                time:
                  request.endedAtMs === null
                    ? intl.formatMessage({
                        id: "conversation.codexRequestDiagnostics.pendingEnd",
                        defaultMessage: "pending",
                      })
                    : intl.formatTime(request.endedAtMs, requestTimeOptions),
              },
            )}
          </div>
        </div>
        <PayloadPreview payload={request.paramsPreview} kind="params" />
        {request.resultPreview === null ? null : (
          <PayloadPreview payload={request.resultPreview} kind="result" />
        )}
        {request.errorPreview === null ? null : (
          <PayloadPreview payload={request.errorPreview} kind="error" />
        )}
      </div>
    </details>
  );
}

function HostRequests({
  hostId,
  requests,
}: {
  hostId: string;
  requests: readonly CodexRecordedRequest[];
}) {
  const [failedOnly, setFailedOnly] = useState(false);
  const intl = useIntl();
  const filterId = useId();
  const failed = requests.filter(isFailedRequest);
  const visible = failedOnly ? failed : requests;

  return (
    <section
      aria-label={intl.formatMessage(
        {
          id: "conversation.codexRequestDiagnostics.hostRequests",
          defaultMessage: "Requests for {hostId}",
        },
        { hostId },
      )}
      className="min-w-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-default">{hostId}</div>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs semantic-text-secondary">
          <span className="tabular-nums">
            {intl.formatMessage(
              {
                id: "conversation.codexRequestDiagnostics.requestCount",
                defaultMessage: "{count} requests",
              },
              { count: requests.length },
            )}
          </span>
          {failed.length > 0 || failedOnly ? (
            <div className="flex items-center gap-1.5">
              <NodexCheckbox
                id={filterId}
                ariaLabel={intl.formatMessage({
                  id: "conversation.codexRequestDiagnostics.failedRequests",
                  defaultMessage: "Failed requests",
                })}
                checked={failedOnly}
                onCheckedChange={setFailedOnly}
              />
              <label htmlFor={filterId} className="cursor-interaction tabular-nums">
                {intl.formatMessage(
                  {
                    id: "conversation.codexRequestDiagnostics.failedCount",
                    defaultMessage: "Failed ({count})",
                  },
                  { count: failed.length },
                )}
              </label>
            </div>
          ) : null}
          <NodexButton
            variant="ghost"
            size="xs"
            disabled={requests.length === 0}
            onClick={() => {
              clearCodexRequestRecords(hostId);
            }}
          >
            {intl.formatMessage({
              id: "conversation.codexRequestDiagnostics.clear",
              defaultMessage: "Clear",
            })}
          </NodexButton>
        </div>
      </div>
      <div>
        {visible.length > 0 ? (
          <div className="flex max-h-[360px] flex-col [&>*+*]:border-t-[0.5px] [&>*+*]:border-default overflow-y-auto">
            {visible.map((request) => (
              <RequestDetails key={String(request.id)} request={request} />
            ))}
          </div>
        ) : (
          <div className="py-3 text-xs semantic-text-secondary">
            {failedOnly
              ? intl.formatMessage({
                  id: "conversation.codexRequestDiagnostics.noFailedRequests",
                  defaultMessage: "No failed requests",
                })
              : intl.formatMessage({
                  id: "conversation.codexRequestDiagnostics.noRequests",
                  defaultMessage: "No requests recorded yet",
                })}
          </div>
        )}
      </div>
    </section>
  );
}

function groupRequestsByHost(
  requests: readonly CodexRecordedRequest[],
): ReadonlyMap<string, readonly CodexRecordedRequest[]> {
  const grouped = new Map<string, CodexRecordedRequest[]>();
  for (const request of requests) {
    const entries = grouped.get(request.hostId);
    if (entries) entries.push(request);
    else grouped.set(request.hostId, [request]);
  }
  return grouped;
}

/** The enclosing Settings section owns the surface; this disclosure owns capture lifetime. */
export function CodexRequestDiagnostics({ enabled }: { enabled: boolean }) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(false);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!enabled || !expanded) return () => undefined;
      return subscribeCodexRequestRecords(onStoreChange);
    },
    [enabled, expanded],
  );
  const getSnapshot = useCallback(
    () => (enabled && expanded ? getCodexRequestRecordsSnapshot() : EMPTY_REQUESTS),
    [enabled, expanded],
  );
  const requests = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_REQUESTS);
  const grouped = groupRequestsByHost(requests);

  return (
    <NodexCollapsibleRoot className="min-w-0" open={expanded} onOpenChange={setExpanded}>
      <NodexCollapsibleTrigger
        aria-label={intl.formatMessage({
          id: "conversation.codexRequestDiagnostics.appServerRequests",
          defaultMessage: "App server requests",
        })}
        className="flex w-full cursor-interaction items-center justify-between gap-3 px-4 py-3 text-left outline-none hover:bg-(--color-background-primary-soft) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-token-focus-border"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-default">
            {intl.formatMessage({
              id: "conversation.codexRequestDiagnostics.appServerRequests",
              defaultMessage: "App server requests",
            })}
          </span>
          <span className="text-xs leading-4 semantic-text-secondary">
            {intl.formatMessage({
              id: "conversation.codexRequestDiagnostics.recordRequests",
              defaultMessage: "Record requests while expanded.",
            })}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs semantic-text-secondary">
          {expanded ? (
            <span className="tabular-nums">
              {intl.formatMessage(
                {
                  id: "conversation.codexRequestDiagnostics.requestCount",
                  defaultMessage: "{count} requests",
                },
                { count: requests.length },
              )}
            </span>
          ) : null}
          <ChevronDownIcon className={cn("icon-2xs shrink-0", !expanded && "-rotate-90")} />
        </span>
      </NodexCollapsibleTrigger>
      <NodexCollapsiblePanel className="mx-4 min-w-0 border-t-[0.5px] border-default py-2 data-[closed]:hidden">
        {grouped.size === 0 ? (
          <div className="py-2 text-xs semantic-text-secondary">
            {intl.formatMessage({
              id: "conversation.codexRequestDiagnostics.noRequests",
              defaultMessage: "No requests recorded yet",
            })}
          </div>
        ) : (
          <div className="flex min-w-0 flex-col [&>*+*]:border-t-[0.5px] [&>*+*]:border-default">
            {[...grouped].map(([hostId, hostRequests]) => (
              <HostRequests key={hostId} hostId={hostId} requests={hostRequests} />
            ))}
          </div>
        )}
      </NodexCollapsiblePanel>
    </NodexCollapsibleRoot>
  );
}
