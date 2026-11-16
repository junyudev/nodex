import {
  defineMessage,
  getIntl,
  useIntl,
  type MessageDescriptor,
  type IntlShape,
} from "@/lib/i18n";
import { NodexButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  serializeDictationDiagnostics,
  type DictationDiagnostics,
  type DictationHttpDiagnostics,
  type DictationPhase,
} from "../../../shared/dictation-diagnostics";

const phaseLabels: Record<DictationPhase["stage"], MessageDescriptor> = {
  permission: defineMessage({
    id: "dictation.dictationPerformanceDetails.phasePermission",
    defaultMessage: "Microphone permission",
  }),
  microphone: defineMessage({
    id: "dictation.dictationPerformanceDetails.phaseMicrophone",
    defaultMessage: "Microphone preparation",
  }),
  recording: defineMessage({
    id: "dictation.dictationPerformanceDetails.phaseRecording",
    defaultMessage: "Recording",
  }),
  "recorder-stop": defineMessage({
    id: "dictation.dictationPerformanceDetails.phaseFinishRecording",
    defaultMessage: "Finish recording",
  }),
  "stream-finalize": defineMessage({
    id: "dictation.dictationPerformanceDetails.phaseStreamFinalize",
    defaultMessage: "Wait for streaming result",
  }),
  buffered: defineMessage({
    id: "dictation.dictationPerformanceDetails.phaseBuffered",
    defaultMessage: "Upload and transcribe",
  }),
  cleanup: defineMessage({
    id: "dictation.dictationPerformanceDetails.phaseCleanup",
    defaultMessage: "Text cleanup",
  }),
  history: defineMessage({
    id: "dictation.dictationPerformanceDetails.phaseHistory",
    defaultMessage: "Save recording and text",
  }),
  delivery: defineMessage({
    id: "dictation.dictationPerformanceDetails.phaseDelivery",
    defaultMessage: "Deliver text",
  }),
};

export const formatDictationTime = (
  ms: number | undefined,
  intl: IntlShape = getIntl(),
): string => {
  if (ms === undefined)
    return intl.formatMessage({
      id: "dictation.dictationPerformanceDetails.notMeasured",
      defaultMessage: "Not measured",
    });
  return ms < 1_000
    ? intl.formatMessage(
        { id: "dictation.dictationPerformanceDetails.milliseconds", defaultMessage: "{time} ms" },
        { time: intl.formatNumber(Math.round(ms), { useGrouping: false }) },
      )
    : intl.formatMessage(
        { id: "dictation.dictationPerformanceDetails.seconds", defaultMessage: "{time} s" },
        {
          time: intl.formatNumber(ms / 1_000, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
            useGrouping: false,
          }),
        },
      );
};

export function dictationPerformanceSummary(
  value: DictationDiagnostics,
  intl: IntlShape = getIntl(),
): string {
  const transport = {
    websocket: "WebSocket",
    buffered: intl.formatMessage({
      id: "dictation.dictationPerformanceDetails.bufferedUpload",
      defaultMessage: "Buffered upload",
    }),
    retained: intl.formatMessage({
      id: "dictation.dictationPerformanceDetails.savedTranscript",
      defaultMessage: "Saved transcript",
    }),
    none: intl.formatMessage({
      id: "dictation.dictationPerformanceDetails.noTranscript",
      defaultMessage: "No transcript delivered",
    }),
  }[value.transport];
  if (value.outcome !== "completed")
    return intl.formatMessage(
      {
        id: "dictation.dictationPerformanceDetails.incompleteSummary",
        defaultMessage: "{transport} · {outcome, select, failed {Failed} other {Cancelled}}",
      },
      { transport, outcome: value.outcome },
    );
  return intl.formatMessage(
    {
      id: "dictation.dictationPerformanceDetails.completedSummary",
      defaultMessage:
        "{transport} · {time} {source, select, capture {after stop} file {total} other {after retry}}",
    },
    { transport, time: formatDictationTime(value.stopToTextMs, intl), source: value.source },
  );
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 justify-between gap-3 py-0.5">
      <dt className="shrink-0 text-token-text-secondary">{label}</dt>
      <dd className="min-w-0 break-all text-right tabular-nums">{value}</dd>
    </div>
  );
}

function RequestHeaders({
  headers,
}: {
  headers: NonNullable<DictationHttpDiagnostics["headers"]>;
}) {
  const intl = useIntl();
  return (
    <>
      <DiagnosticRow
        label={intl.formatMessage({
          id: "dictation.dictationPerformanceDetails.originator",
          defaultMessage: "Originator",
        })}
        value={
          headers.originator ||
          intl.formatMessage({
            id: "dictation.dictationPerformanceDetails.headerAbsent",
            defaultMessage: "Absent",
          })
        }
      />
      <DiagnosticRow
        label={intl.formatMessage({
          id: "dictation.dictationPerformanceDetails.userAgent",
          defaultMessage: "User-Agent",
        })}
        value={
          headers.userAgent ||
          intl.formatMessage({
            id: "dictation.dictationPerformanceDetails.headerAbsent",
            defaultMessage: "Absent",
          })
        }
      />
      <DiagnosticRow
        label={intl.formatMessage({
          id: "dictation.dictationPerformanceDetails.authentication",
          defaultMessage: "Authentication",
        })}
        value={intl.formatMessage(
          {
            id: "dictation.dictationPerformanceDetails.authenticationHeaders",
            defaultMessage:
              "Bearer {authorization, select, true {present} other {absent}} · Account header {account, select, true {present} other {absent}}",
          },
          {
            authorization: String(headers.authorizationPresent),
            account: String(headers.accountHeaderPresent),
          },
        )}
      />
    </>
  );
}

function RequestDetails({ request }: { request: DictationHttpDiagnostics }) {
  const intl = useIntl();
  return (
    <div className="pt-2">
      <p className="mb-1 font-medium">
        {request.operation === "cleanup"
          ? intl.formatMessage({
              id: "dictation.dictationPerformanceDetails.cleanup",
              defaultMessage: "Text cleanup",
            })
          : intl.formatMessage({
              id: "dictation.dictationPerformanceDetails.bufferedTranscription",
              defaultMessage: "Buffered transcription",
            })}{" "}
        ·{" "}
        {request.model ??
          intl.formatMessage({
            id: "dictation.dictationPerformanceDetails.transcriptionService",
            defaultMessage: "Transcription service",
          })}
      </p>
      <dl>
        <DiagnosticRow
          label={intl.formatMessage({
            id: "dictation.dictationPerformanceDetails.endpoint",
            defaultMessage: "Endpoint",
          })}
          value={`POST ${request.endpoint}`}
        />
        <DiagnosticRow
          label={intl.formatMessage({
            id: "dictation.dictationPerformanceDetails.requestResult",
            defaultMessage: "Result",
          })}
          value={`${request.outcome}${request.status ? ` · HTTP ${request.status}` : ""}`}
        />
        <DiagnosticRow
          label={intl.formatMessage({
            id: "dictation.dictationPerformanceDetails.requestToHeaders",
            defaultMessage: "Prepare request → response headers",
          })}
          value={formatDictationTime(request.headersMs, intl)}
        />
        <DiagnosticRow
          label={intl.formatMessage({
            id: "dictation.dictationPerformanceDetails.readBody",
            defaultMessage: "Read response body",
          })}
          value={formatDictationTime(request.bodyMs, intl)}
        />
        <DiagnosticRow
          label={intl.formatMessage({
            id: "dictation.dictationPerformanceDetails.requestTotal",
            defaultMessage: "Total request",
          })}
          value={formatDictationTime(request.totalMs, intl)}
        />
        <DiagnosticRow
          label={intl.formatMessage({
            id: "dictation.dictationPerformanceDetails.httpAttempts",
            defaultMessage: "HTTP attempts",
          })}
          value={intl.formatNumber(request.attempts)}
        />
        {request.headers ? <RequestHeaders headers={request.headers} /> : null}
        <DiagnosticRow
          label={intl.formatMessage({
            id: "dictation.dictationPerformanceDetails.requestId",
            defaultMessage: "Request ID",
          })}
          value={request.requestId}
        />
        {request.responseId ? (
          <DiagnosticRow
            label={intl.formatMessage({
              id: "dictation.dictationPerformanceDetails.serverRequestId",
              defaultMessage: "Server request ID",
            })}
            value={request.responseId}
          />
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
  const intl = useIntl();
  if (!diagnostics)
    return (
      <p className="px-4 pb-3 text-xs text-token-text-secondary">
        {intl.formatMessage({
          id: "dictation.dictationPerformanceDetails.noDetails",
          defaultMessage: "Performance details are available for new dictation attempts.",
        })}
      </p>
    );
  const stream = diagnostics.streaming;
  const cleanup = diagnostics.requests.find((request) => request.operation === "cleanup");
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(serializeDictationDiagnostics(diagnostics));
      toast.success(
        getIntl().formatMessage({
          id: "dictation.dictationPerformanceDetails.copied",
          defaultMessage: "Diagnostics copied",
        }),
      );
    } catch {
      toast.danger(
        getIntl().formatMessage({
          id: "dictation.dictationPerformanceDetails.copyFailed",
          defaultMessage: "Could not copy diagnostics",
        }),
      );
    }
  };

  return (
    <details className="group px-4 pb-3 text-xs text-token-text-primary">
      <summary className="cursor-pointer select-none text-token-text-secondary transition-colors hover:text-token-text-primary">
        <span className="ml-1">
          {intl.formatMessage({
            id: "dictation.dictationPerformanceDetails.title",
            defaultMessage: "Performance details",
          })}
        </span>
        <span className="ml-2 tabular-nums">{dictationPerformanceSummary(diagnostics, intl)}</span>
      </summary>
      <div className="pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="font-medium">
            {intl.formatMessage(
              {
                id: "dictation.dictationPerformanceDetails.attempt",
                defaultMessage: "Attempt {number} · ",
              },
              { number: diagnostics.attempt },
            )}
            {cleanup
              ? intl.formatMessage(
                  {
                    id: "dictation.dictationPerformanceDetails.cleanupTiming",
                    defaultMessage:
                      "Cleanup {time}{outcome, select, completed {} other { · Original text kept}}",
                  },
                  { time: formatDictationTime(cleanup.totalMs, intl), outcome: cleanup.outcome },
                )
              : intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.cleanupSkipped",
                  defaultMessage: "Cleanup skipped",
                })}
          </span>
          <NodexButton size="xs" variant="ghost" onClick={() => void copy()}>
            {intl.formatMessage({
              id: "dictation.dictationPerformanceDetails.copyDiagnostics",
              defaultMessage: "Copy diagnostics",
            })}
          </NodexButton>
        </div>
        <table className="w-full text-left">
          <caption className="sr-only">
            {intl.formatMessage({
              id: "dictation.dictationPerformanceDetails.timings",
              defaultMessage: "Dictation stage timings",
            })}
          </caption>
          <thead className="text-token-text-secondary">
            <tr>
              <th className="pb-1 font-normal">
                {intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.stage",
                  defaultMessage: "Stage",
                })}
              </th>
              <th className="pb-1 text-right font-normal">
                {intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.start",
                  defaultMessage: "Start",
                })}
              </th>
              <th className="pb-1 text-right font-normal">
                {intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.duration",
                  defaultMessage: "Duration",
                })}
              </th>
            </tr>
          </thead>
          <tbody>
            {[...diagnostics.phases]
              .sort((a, b) => a.offsetMs - b.offsetMs)
              .map((phase) => (
                <tr key={phase.stage}>
                  <td className="py-1">
                    {intl.formatMessage(phaseLabels[phase.stage])}
                    {phase.outcome === "failed"
                      ? intl.formatMessage({
                          id: "dictation.dictationPerformanceDetails.failedSuffix",
                          defaultMessage: " · Failed",
                        })
                      : ""}
                  </td>
                  <td className="pl-3 text-right tabular-nums text-token-text-secondary">
                    +{formatDictationTime(phase.offsetMs, intl)}
                  </td>
                  <td className="pl-3 text-right tabular-nums">
                    {phase.outcome === "skipped"
                      ? intl.formatMessage({
                          id: "dictation.dictationPerformanceDetails.skipped",
                          defaultMessage: "Skipped",
                        })
                      : formatDictationTime(phase.durationMs, intl)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        <dl className="border-t border-token-border pt-2">
          <DiagnosticRow
            label={
              diagnostics.source === "file"
                ? intl.formatMessage({
                    id: "dictation.dictationPerformanceDetails.transcriptionToSave",
                    defaultMessage: "Transcription → saved text",
                  })
                : diagnostics.source === "capture"
                  ? intl.formatMessage({
                      id: "dictation.dictationPerformanceDetails.stopToDelivery",
                      defaultMessage: "Stop → text delivery",
                    })
                  : intl.formatMessage({
                      id: "dictation.dictationPerformanceDetails.retryToDelivery",
                      defaultMessage: "Retry → text delivery",
                    })
            }
            value={formatDictationTime(diagnostics.stopToTextMs, intl)}
          />
          <DiagnosticRow
            label={intl.formatMessage({
              id: "dictation.dictationPerformanceDetails.includingCompletion",
              defaultMessage: "Including completion work",
            })}
            value={formatDictationTime(diagnostics.stopToCompletionMs, intl)}
          />
          {diagnostics.clipboardRestoreMs === undefined ? null : (
            <DiagnosticRow
              label={intl.formatMessage({
                id: "dictation.dictationPerformanceDetails.clipboardRestore",
                defaultMessage: "Clipboard restoration",
              })}
              value={formatDictationTime(diagnostics.clipboardRestoreMs, intl)}
            />
          )}
        </dl>
        {stream ? (
          <div className="pt-3">
            <p className="mb-1 font-medium">
              {intl.formatMessage({
                id: "dictation.dictationPerformanceDetails.streamingConnection",
                defaultMessage: "Streaming connection",
              })}
            </p>
            <dl>
              <DiagnosticRow
                label={intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.websocketAttempted",
                  defaultMessage: "WebSocket attempted",
                })}
                value={
                  stream.attempted
                    ? intl.formatMessage({
                        id: "dictation.dictationPerformanceDetails.yes",
                        defaultMessage: "Yes",
                      })
                    : intl.formatMessage({
                        id: "dictation.dictationPerformanceDetails.no",
                        defaultMessage: "No",
                      })
                }
              />
              {stream.skipReason ? (
                <DiagnosticRow
                  label={intl.formatMessage({
                    id: "dictation.dictationPerformanceDetails.streamSkipped",
                    defaultMessage: "Streaming skipped",
                  })}
                  value={stream.skipReason}
                />
              ) : null}
              <DiagnosticRow
                label={intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.handshakeCompleted",
                  defaultMessage: "Handshake completed",
                })}
                value={
                  stream.opened
                    ? intl.formatMessage({
                        id: "dictation.dictationPerformanceDetails.yes",
                        defaultMessage: "Yes",
                      })
                    : intl.formatMessage({
                        id: "dictation.dictationPerformanceDetails.no",
                        defaultMessage: "No",
                      })
                }
              />
              <DiagnosticRow
                label={intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.sessionStarted",
                  defaultMessage: "Session started",
                })}
                value={
                  stream.started
                    ? intl.formatMessage({
                        id: "dictation.dictationPerformanceDetails.yes",
                        defaultMessage: "Yes",
                      })
                    : intl.formatMessage({
                        id: "dictation.dictationPerformanceDetails.no",
                        defaultMessage: "No",
                      })
                }
              />
              <DiagnosticRow
                label={intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.resultUsed",
                  defaultMessage: "Result used",
                })}
                value={
                  diagnostics.transport === "websocket"
                    ? intl.formatMessage({
                        id: "dictation.dictationPerformanceDetails.yes",
                        defaultMessage: "Yes",
                      })
                    : intl.formatMessage({
                        id: "dictation.dictationPerformanceDetails.no",
                        defaultMessage: "No",
                      })
                }
              />
              <DiagnosticRow
                label={intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.connectionPreparation",
                  defaultMessage: "Connection preparation",
                })}
                value={formatDictationTime(stream.connectInfoMs, intl)}
              />
              <DiagnosticRow
                label={intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.websocketHandshake",
                  defaultMessage: "WebSocket handshake",
                })}
                value={formatDictationTime(stream.handshakeMs, intl)}
              />
              <DiagnosticRow
                label={intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.sessionStart",
                  defaultMessage: "Session start",
                })}
                value={formatDictationTime(stream.sessionStartMs, intl)}
              />
              <DiagnosticRow
                label={intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.sessionFinish",
                  defaultMessage: "Session finish",
                })}
                value={formatDictationTime(stream.finishMs, intl)}
              />
              <DiagnosticRow
                label={intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.audioSent",
                  defaultMessage: "Audio sent",
                })}
                value={intl.formatMessage(
                  {
                    id: "dictation.dictationPerformanceDetails.audioAmount",
                    defaultMessage: "{frames} frames · {size} KiB",
                  },
                  {
                    frames: stream.sentAudioFrames,
                    size: intl.formatNumber(stream.sentAudioBytes / 1024, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                      useGrouping: false,
                    }),
                  },
                )}
              />
              <DiagnosticRow
                label={intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.transcriptEvents",
                  defaultMessage: "Transcript events",
                })}
                value={intl.formatMessage(
                  {
                    id: "dictation.dictationPerformanceDetails.transcriptEventCount",
                    defaultMessage:
                      "{count} · Final {final, select, true {received} other {not received}}",
                  },
                  { count: stream.transcriptEvents, final: String(stream.finalReceived) },
                )}
              />
              <DiagnosticRow
                label={intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.endpoint",
                  defaultMessage: "Endpoint",
                })}
                value="WSS /dictation/stream"
              />
              {stream.headers ? (
                <RequestHeaders headers={stream.headers} />
              ) : (
                <DiagnosticRow
                  label={intl.formatMessage({
                    id: "dictation.dictationPerformanceDetails.wsHeaders",
                    defaultMessage: "WS request headers",
                  })}
                  value={intl.formatMessage({
                    id: "dictation.dictationPerformanceDetails.notCaptured",
                    defaultMessage: "Not captured",
                  })}
                />
              )}
              {stream.proxyMode ? (
                <DiagnosticRow
                  label={intl.formatMessage({
                    id: "dictation.dictationPerformanceDetails.proxy",
                    defaultMessage: "Proxy",
                  })}
                  value={stream.proxyMode}
                />
              ) : null}
              {stream.httpStatus ? (
                <DiagnosticRow
                  label={intl.formatMessage({
                    id: "dictation.dictationPerformanceDetails.handshakeResponse",
                    defaultMessage: "Handshake response",
                  })}
                  value={`HTTP ${stream.httpStatus}`}
                />
              ) : null}
              {stream.edgeChallenge ? (
                <DiagnosticRow
                  label={intl.formatMessage({
                    id: "dictation.dictationPerformanceDetails.edgeChallenge",
                    defaultMessage: "Edge challenge",
                  })}
                  value="Cloudflare"
                />
              ) : null}
              {stream.networkError ? (
                <DiagnosticRow
                  label={intl.formatMessage({
                    id: "dictation.dictationPerformanceDetails.networkFailure",
                    defaultMessage: "Network failure",
                  })}
                  value={stream.networkError}
                />
              ) : null}
              <DiagnosticRow
                label={intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.negotiatedProtocol",
                  defaultMessage: "Negotiated protocol",
                })}
                value={
                  stream.selectedProtocol ??
                  intl.formatMessage({
                    id: "dictation.dictationPerformanceDetails.notObserved",
                    defaultMessage: "Not observed",
                  })
                }
              />
              <DiagnosticRow
                label={intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.providerMode",
                  defaultMessage: "Provider mode",
                })}
                value={
                  stream.providerMode ??
                  intl.formatMessage({
                    id: "dictation.dictationPerformanceDetails.notObserved",
                    defaultMessage: "Not observed",
                  })
                }
              />
              <DiagnosticRow
                label={intl.formatMessage({
                  id: "dictation.dictationPerformanceDetails.closeCode",
                  defaultMessage: "Close code",
                })}
                value={
                  stream.closeCode === undefined
                    ? intl.formatMessage({
                        id: "dictation.dictationPerformanceDetails.notObserved",
                        defaultMessage: "Not observed",
                      })
                    : intl.formatNumber(stream.closeCode, { useGrouping: false })
                }
              />
              {stream.failureCode ? (
                <DiagnosticRow
                  label={intl.formatMessage({
                    id: "dictation.dictationPerformanceDetails.streamingFailure",
                    defaultMessage: "Streaming failure",
                  })}
                  value={stream.failureCode}
                />
              ) : null}
            </dl>
          </div>
        ) : null}
        {diagnostics.requests.map((request) => (
          <RequestDetails key={request.requestId} request={request} />
        ))}
        <p className="mt-3 leading-4 text-token-text-secondary">
          {intl.formatMessage({
            id: "dictation.dictationPerformanceDetails.timingExplanation",
            defaultMessage:
              "Stages can overlap; durations are not additive. Request timing includes preparation, authentication, upload and server wait. Server processing and network transit are not measured separately.",
          })}
          {diagnostics.delivery === "global"
            ? intl.formatMessage({
                id: "dictation.dictationPerformanceDetails.globalTimingExplanation",
                defaultMessage:
                  " Global text delivery estimates paste shortcut dispatch; target app rendering is not measured.",
              })
            : ""}
        </p>
      </div>
    </details>
  );
}
