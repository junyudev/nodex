import { NodexButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  serializeDictationDiagnostics,
  type DictationDiagnostics,
  type DictationHttpDiagnostics,
  type DictationPhase,
} from "../../../shared/dictation-diagnostics";

const phaseLabels: Record<DictationPhase["stage"], string> = {
  permission: "Microphone permission",
  microphone: "Microphone preparation",
  recording: "Recording",
  "recorder-stop": "Finish recording",
  "stream-finalize": "Wait for streaming result",
  buffered: "Upload and transcribe",
  cleanup: "Text cleanup",
  history: "Save recording and text",
  delivery: "Deliver text",
};

export const formatDictationTime = (ms: number | undefined): string => {
  if (ms === undefined) return "Not measured";
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(2)} s`;
};

export function dictationPerformanceSummary(value: DictationDiagnostics): string {
  const transport = {
    websocket: "WebSocket",
    buffered: "Buffered upload",
    retained: "Saved transcript",
    none: "No transcript delivered",
  }[value.transport];
  if (value.outcome !== "completed")
    return `${transport} · ${value.outcome === "failed" ? "Failed" : "Cancelled"}`;
  return `${transport} · ${formatDictationTime(value.stopToTextMs)} ${value.source === "capture" ? "after stop" : "after retry"}`;
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 justify-between gap-3 py-0.5">
      <dt className="shrink-0 text-token-text-secondary">{label}</dt>
      <dd className="min-w-0 break-all text-right tabular-nums">{value}</dd>
    </div>
  );
}

function RequestDetails({ request }: { request: DictationHttpDiagnostics }) {
  return (
    <div className="pt-2">
      <p className="mb-1 font-medium">
        {request.operation === "cleanup" ? "Text cleanup" : "Buffered transcription"} ·{" "}
        {request.model ?? "Transcription service"}
      </p>
      <dl>
        <DiagnosticRow label="Endpoint" value={`POST ${request.endpoint}`} />
        <DiagnosticRow
          label="Result"
          value={`${request.outcome}${request.status ? ` · HTTP ${request.status}` : ""}`}
        />
        <DiagnosticRow
          label="Prepare request → response headers"
          value={formatDictationTime(request.headersMs)}
        />
        <DiagnosticRow label="Read response body" value={formatDictationTime(request.bodyMs)} />
        <DiagnosticRow label="Total request" value={formatDictationTime(request.totalMs)} />
        <DiagnosticRow label="HTTP attempts" value={String(request.attempts)} />
        {request.headers ? (
          <>
            <DiagnosticRow label="Originator" value={request.headers.originator || "Absent"} />
            <DiagnosticRow label="User-Agent" value={request.headers.userAgent || "Absent"} />
            <DiagnosticRow
              label="Authentication"
              value={`Bearer ${request.headers.authorizationPresent ? "present" : "absent"} · Account header ${request.headers.accountHeaderPresent ? "present" : "absent"}`}
            />
          </>
        ) : null}
        <DiagnosticRow label="Request ID" value={request.requestId} />
        {request.responseId ? (
          <DiagnosticRow label="Server request ID" value={request.responseId} />
        ) : null}
      </dl>
    </div>
  );
}

export function DictationPerformanceDetails({
  diagnostics,
}: {
  diagnostics?: DictationDiagnostics;
}) {
  if (!diagnostics)
    return (
      <p className="px-4 pb-3 text-xs text-token-text-secondary">
        Performance details are available for new dictation attempts.
      </p>
    );
  const stream = diagnostics.streaming;
  const cleanup = diagnostics.requests.find((request) => request.operation === "cleanup");
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(serializeDictationDiagnostics(diagnostics));
      toast.success("Diagnostics copied");
    } catch {
      toast.danger("Could not copy diagnostics");
    }
  };

  return (
    <details className="group px-4 pb-3 text-xs text-token-text-primary">
      <summary className="cursor-pointer select-none text-token-text-secondary transition-colors hover:text-token-text-primary">
        <span className="ml-1">Performance details</span>
        <span className="ml-2 tabular-nums">{dictationPerformanceSummary(diagnostics)}</span>
      </summary>
      <div className="pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="font-medium">
            Attempt {diagnostics.attempt} ·{" "}
            {cleanup
              ? `Cleanup ${formatDictationTime(cleanup.totalMs)}${cleanup.outcome === "completed" ? "" : " · Original text kept"}`
              : "Cleanup skipped"}
          </span>
          <NodexButton size="xs" variant="ghost" onClick={() => void copy()}>
            Copy diagnostics
          </NodexButton>
        </div>
        <table className="w-full text-left">
          <caption className="sr-only">Dictation stage timings</caption>
          <thead className="text-token-text-secondary">
            <tr>
              <th className="pb-1 font-normal">Stage</th>
              <th className="pb-1 text-right font-normal">Start</th>
              <th className="pb-1 text-right font-normal">Duration</th>
            </tr>
          </thead>
          <tbody>
            {[...diagnostics.phases]
              .sort((a, b) => a.offsetMs - b.offsetMs)
              .map((phase) => (
                <tr key={phase.stage}>
                  <td className="py-1">
                    {phaseLabels[phase.stage]}
                    {phase.outcome === "failed" ? " · Failed" : ""}
                  </td>
                  <td className="pl-3 text-right tabular-nums text-token-text-secondary">
                    +{formatDictationTime(phase.offsetMs)}
                  </td>
                  <td className="pl-3 text-right tabular-nums">
                    {phase.outcome === "skipped"
                      ? "Skipped"
                      : formatDictationTime(phase.durationMs)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        <dl className="border-t border-token-border pt-2">
          <DiagnosticRow
            label={
              diagnostics.source === "capture" ? "Stop → text delivery" : "Retry → text delivery"
            }
            value={formatDictationTime(diagnostics.stopToTextMs)}
          />
          <DiagnosticRow
            label="Including completion work"
            value={formatDictationTime(diagnostics.stopToCompletionMs)}
          />
          {diagnostics.clipboardRestoreMs === undefined ? null : (
            <DiagnosticRow
              label="Clipboard restoration"
              value={formatDictationTime(diagnostics.clipboardRestoreMs)}
            />
          )}
        </dl>
        {stream ? (
          <div className="pt-3">
            <p className="mb-1 font-medium">Streaming connection</p>
            <dl>
              <DiagnosticRow label="WebSocket attempted" value={stream.attempted ? "Yes" : "No"} />
              <DiagnosticRow label="Handshake completed" value={stream.opened ? "Yes" : "No"} />
              <DiagnosticRow label="Session started" value={stream.started ? "Yes" : "No"} />
              <DiagnosticRow
                label="Result used"
                value={diagnostics.transport === "websocket" ? "Yes" : "No"}
              />
              <DiagnosticRow
                label="Connection preparation"
                value={formatDictationTime(stream.connectInfoMs)}
              />
              <DiagnosticRow
                label="WebSocket handshake"
                value={formatDictationTime(stream.handshakeMs)}
              />
              <DiagnosticRow
                label="Session start"
                value={formatDictationTime(stream.sessionStartMs)}
              />
              <DiagnosticRow label="Session finish" value={formatDictationTime(stream.finishMs)} />
              <DiagnosticRow
                label="Audio sent"
                value={`${stream.sentAudioFrames} frames · ${(stream.sentAudioBytes / 1024).toFixed(1)} KiB`}
              />
              <DiagnosticRow
                label="Transcript events"
                value={`${stream.transcriptEvents} · Final ${stream.finalReceived ? "received" : "not received"}`}
              />
              <DiagnosticRow label="Endpoint" value="WSS /dictation/stream" />
              <DiagnosticRow
                label="Authentication"
                value="WebSocket subprotocol · Bearer redacted"
              />
              <DiagnosticRow
                label="Negotiated protocol"
                value={stream.selectedProtocol ?? "Not observed"}
              />
              <DiagnosticRow label="Provider mode" value={stream.providerMode ?? "Not observed"} />
              <DiagnosticRow label="WS request headers" value="Runtime-managed · Not captured" />
              <DiagnosticRow
                label="Close code"
                value={stream.closeCode === undefined ? "Not observed" : String(stream.closeCode)}
              />
              {stream.failureCode ? (
                <DiagnosticRow label="Streaming failure" value={stream.failureCode} />
              ) : null}
            </dl>
          </div>
        ) : null}
        {diagnostics.requests.map((request) => (
          <RequestDetails key={request.requestId} request={request} />
        ))}
        <p className="mt-3 leading-4 text-token-text-secondary">
          Stages can overlap; durations are not additive. Request timing includes preparation,
          authentication, upload and server wait. Server processing and network transit are not
          measured separately.
          {diagnostics.delivery === "global"
            ? " Global text delivery estimates paste shortcut dispatch; target app rendering is not measured."
            : ""}
        </p>
      </div>
    </details>
  );
}
