import { useCallback, useState, useSyncExternalStore } from "react";
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
  if (request.status === "pending") return "pending";
  const durationMs = request.durationMs ?? 0;
  const duration = durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(2)} s`;
  return request.status === "completed" ? `✅ ${duration}` : `❌ ${duration}`;
}

function isFailedRequest(request: CodexRecordedRequest): boolean {
  return request.status === "failed" || request.status === "timed-out";
}

function PayloadPreview({ payload, title }: { payload: string; title: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-medium tracking-wide text-(--foreground-secondary) uppercase">
        <span>{title}</span>
        <button
          type="button"
          className="cursor-pointer rounded px-1.5 py-0.5 text-(--foreground-primary) hover:bg-(--background-tertiary)"
          onClick={() => {
            void navigator.clipboard?.writeText(payload).catch(() => undefined);
          }}
        >
          Copy
        </button>
      </div>
      <pre className="max-h-52 overflow-auto rounded-md border border-(--border-primary) bg-(--background-secondary) p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-(--foreground-primary)">
        {payload}
      </pre>
    </div>
  );
}

function RequestDetails({ request }: { request: CodexRecordedRequest }) {
  return (
    <details className="group/request rounded-lg border border-(--border-primary)">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 marker:content-none">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-xs text-(--foreground-primary)">
              {request.method}
            </span>
            <span className="rounded-full bg-(--background-tertiary) px-1.5 py-0.5 text-[10px] font-medium text-(--foreground-secondary) tabular-nums">
              #{request.matchingRequestSequenceNumber}
            </span>
          </div>
        </div>
        <div className="shrink-0 text-right text-[11px] text-(--foreground-secondary) tabular-nums">
          <div>{REQUEST_TIME_FORMATTER.format(request.startedAtMs)}</div>
          <div>{requestDuration(request)}</div>
        </div>
      </summary>
      <div className="space-y-3 border-t border-(--border-primary) p-3">
        <div className="grid gap-2 text-[11px] text-(--foreground-secondary) md:grid-cols-2">
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
  const failed = requests.filter(isFailedRequest);
  const visible = failedOnly ? failed : requests;

  return (
    <section className="overflow-hidden rounded-lg border border-(--border-primary) bg-(--background-secondary)">
      <div className="flex items-center justify-between gap-3 border-b border-(--border-primary) px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-(--foreground-primary)">{hostId}</div>
          <div className="text-[11px] text-(--foreground-secondary) tabular-nums">
            {requests.length} requests
          </div>
        </div>
        <button
          type="button"
          className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-(--foreground-secondary) hover:bg-(--background-tertiary) hover:text-(--foreground-primary) disabled:cursor-default disabled:opacity-50"
          disabled={requests.length === 0}
          onClick={() => {
            clearCodexRequestRecords(hostId);
          }}
        >
          Clear
        </button>
      </div>
      <div className="py-3">
        {failed.length > 0 || failedOnly ? (
          <div className="mb-2 flex justify-end px-3">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-(--foreground-secondary)">
              <input
                checked={failedOnly}
                className="cursor-pointer"
                type="checkbox"
                onChange={(event) => {
                  setFailedOnly(event.currentTarget.checked);
                }}
              />
              Failed <span className="tabular-nums">({failed.length})</span>
            </label>
          </div>
        ) : null}
        {visible.length > 0 ? (
          <div className="flex max-h-[360px] flex-col gap-2 overflow-y-auto px-3">
            {visible.map((request) => (
              <RequestDetails key={String(request.id)} request={request} />
            ))}
          </div>
        ) : (
          <div className="mx-3 rounded border border-dashed border-(--border-primary) px-3 py-6 text-center text-xs text-(--foreground-secondary)">
            {failedOnly
              ? "No failed requests recorded for this manager yet"
              : "No requests recorded for this manager yet"}
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
    <details
      className="overflow-hidden rounded-lg border border-(--border-primary) bg-(--background-secondary)"
      open={expanded}
      onToggle={(event) => {
        setExpanded(event.currentTarget.open);
      }}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 marker:content-none">
        <div>
          <div className="text-sm font-medium text-(--foreground-primary)">App server requests</div>
          <div className="mt-0.5 text-xs text-(--foreground-secondary)">
            Capture the most recent request lifecycle while this panel is open.
          </div>
        </div>
        <span className="shrink-0 text-xs text-(--foreground-secondary) tabular-nums">
          {requests.length} recent
        </span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-(--border-primary) p-3">
        {grouped.size === 0 ? (
          <div className="rounded border border-dashed border-(--border-primary) px-3 py-6 text-center text-xs text-(--foreground-secondary)">
            No requests recorded while this panel is open
          </div>
        ) : (
          [...grouped].map(([hostId, hostRequests]) => (
            <HostRequests key={hostId} hostId={hostId} requests={hostRequests} />
          ))
        )}
      </div>
    </details>
  );
}
