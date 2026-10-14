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

const REQUEST_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  fractionalSecondDigits: 3,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const EMPTY_REQUESTS: readonly CodexRecordedRequest[] = [];

function requestDuration(request: CodexRecordedRequest): string {
  if (request.status === "pending") return "Pending";
  const durationMs = request.durationMs ?? 0;
  const duration = durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(2)} s`;
  const status =
    request.status === "completed"
      ? "Completed"
      : request.status === "timed-out"
        ? "Timed out"
        : "Failed";
  return `${status} · ${duration}`;
}

function isFailedRequest(request: CodexRecordedRequest): boolean {
  return request.status === "failed" || request.status === "timed-out";
}

function PayloadPreview({ payload, title }: { payload: string; title: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs semantic-text-secondary">
        <span>{title}</span>
        <NodexButton
          variant="ghost"
          size="xs"
          aria-label={`Copy ${title.toLowerCase()}`}
          onClick={() => {
            void navigator.clipboard?.writeText(payload).catch(() => undefined);
          }}
        >
          Copy
        </NodexButton>
      </div>
      <pre className="codex-tool-code max-h-52 overflow-auto rounded-md bg-(--color-background-primary-soft) p-2 font-mono text-size-code whitespace-pre-wrap break-words text-default">
        {payload}
      </pre>
    </div>
  );
}

function RequestDetails({ request }: { request: CodexRecordedRequest }) {
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
          <div>{REQUEST_TIME_FORMATTER.format(request.startedAtMs)}</div>
          <div className={isFailedRequest(request) ? "text-danger" : undefined}>
            {requestDuration(request)}
          </div>
        </div>
      </summary>
      <div className="min-w-0 space-y-3 border-t-[0.5px] border-default pt-3 pb-2">
        <div className="grid gap-2 text-xs break-words semantic-text-secondary md:grid-cols-2">
          <div>Request ID: {request.id}</div>
          <div>Timeout: {request.timeoutMs > 0 ? request.timeoutMs : "none"}</div>
          <div>Priority: {request.priority}</div>
          <div>Source: {request.source}</div>
          <div>Queued: {request.queueWaitMs}ms</div>
          <div>
            Ended:{" "}
            {request.endedAtMs === null
              ? "pending"
              : REQUEST_TIME_FORMATTER.format(request.endedAtMs)}
          </div>
        </div>
        <PayloadPreview payload={request.paramsPreview} title="Params" />
        {request.resultPreview === null ? null : (
          <PayloadPreview payload={request.resultPreview} title="Result" />
        )}
        {request.errorPreview === null ? null : (
          <PayloadPreview payload={request.errorPreview} title="Error" />
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
  const filterId = useId();
  const failed = requests.filter(isFailedRequest);
  const visible = failedOnly ? failed : requests;

  return (
    <section aria-label={`Requests for ${hostId}`} className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-default">{hostId}</div>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs semantic-text-secondary">
          <span className="tabular-nums">{requests.length} requests</span>
          {failed.length > 0 || failedOnly ? (
            <div className="flex items-center gap-1.5">
              <NodexCheckbox
                id={filterId}
                ariaLabel="Failed requests"
                checked={failedOnly}
                onCheckedChange={setFailedOnly}
              />
              <label htmlFor={filterId} className="cursor-interaction tabular-nums">
                Failed ({failed.length})
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
            Clear
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
            {failedOnly ? "No failed requests" : "No requests recorded yet"}
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
        aria-label="App server requests"
        className="flex w-full cursor-interaction items-center justify-between gap-3 px-4 py-3 text-left outline-none hover:bg-(--color-background-primary-soft) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-token-focus-border"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-default">App server requests</span>
          <span className="text-xs leading-4 semantic-text-secondary">
            Record requests while expanded.
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs semantic-text-secondary">
          {expanded ? <span className="tabular-nums">{requests.length} requests</span> : null}
          <ChevronDownIcon className={cn("icon-2xs shrink-0", !expanded && "-rotate-90")} />
        </span>
      </NodexCollapsibleTrigger>
      <NodexCollapsiblePanel className="mx-4 min-w-0 border-t-[0.5px] border-default py-2 data-[closed]:hidden">
        {grouped.size === 0 ? (
          <div className="py-2 text-xs semantic-text-secondary">No requests recorded yet</div>
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
