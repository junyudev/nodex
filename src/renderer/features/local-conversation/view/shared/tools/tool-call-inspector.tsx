import { defineMessage, useIntl, type IntlShape, type MessageDescriptor } from "@/lib/i18n";
import { useId, useRef, useState, type ReactNode } from "react";
import { CodeIcon } from "@/components/shared/icons";
import { BrowseTabs } from "@/components/ui/browse-tabs";
import {
  NodexDialog as Dialog,
  NodexDialogBody as DialogBody,
  NodexDialogContent as DialogContent,
  NodexDialogFrame as DialogFrame,
  NodexDialogHeader as DialogHeader,
  NodexDialogTitle as DialogTitle,
} from "@/components/ui/dialog";
import { preloadSourceViewer } from "@/components/ui/lazy-source-viewer";
import { NodexTooltip } from "@/components/ui/tooltip";
import type {
  CodexDynamicToolCallView,
  CodexMcpToolCallView,
  CodexTranscriptEntry,
} from "@/lib/types";
import { formatToolResultText } from "../../../projection/tool-metadata/tool-output-envelope";
import { CopyMessageActionButton } from "../thread-message-actions";
import { stringifyToolCallValue, ToolCallSourceSurface } from "./tool-call-inspection";
import { useToolCallOutputDetail } from "./use-tool-call-output-detail";

/** The exact evidence behind a tool row, whatever kind of tool produced it. */
export interface ToolCallInspection {
  readonly toolName: string;
  readonly status: "running" | "completed" | "failed";
  readonly durationMs: number | null;
  readonly input: unknown;
  /** The output as text, or null when the call returned none. */
  readonly output: string | null;
  readonly raw: unknown;
}

type InspectorTab = "input" | "output" | "raw";

const INSPECTOR_TABS = [
  {
    key: "input",
    name: defineMessage({ id: "conversation.toolCallInspector.input", defaultMessage: "Input" }),
  },
  {
    key: "output",
    name: defineMessage({ id: "conversation.toolCallInspector.output", defaultMessage: "Output" }),
  },
  {
    key: "raw",
    name: defineMessage({ id: "conversation.toolCallInspector.raw", defaultMessage: "Raw" }),
  },
] as const;

const STATUS_LABELS: Readonly<Record<ToolCallInspection["status"], MessageDescriptor>> = {
  running: defineMessage({
    id: "conversation.toolCallInspector.running",
    defaultMessage: "Running",
  }),
  completed: defineMessage({
    id: "conversation.toolCallInspector.completed",
    defaultMessage: "Completed",
  }),
  failed: defineMessage({ id: "conversation.toolCallInspector.failed", defaultMessage: "Failed" }),
};

function formatToolCallDuration(intl: IntlShape, durationMs: number): string {
  return durationMs < 1_000
    ? intl.formatMessage(
        { id: "conversation.toolCallInspector.milliseconds", defaultMessage: "{duration} ms" },
        { duration: intl.formatNumber(durationMs) },
      )
    : intl.formatMessage(
        { id: "conversation.toolCallInspector.seconds", defaultMessage: "{duration} s" },
        {
          duration: intl.formatNumber(durationMs / 1_000, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }),
        },
      );
}

const isEmptyInput = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === "object" && Object.keys(value).length === 0);

export function inspectDynamicToolCall(
  call: CodexDynamicToolCallView,
  rawItem: unknown,
): ToolCallInspection {
  const texts = (call.contentItems ?? []).flatMap((content) =>
    content.type === "inputText" ? [formatToolResultText(content.text)] : [],
  );
  return {
    toolName: [call.namespace, call.tool].filter(Boolean).join("."),
    status: !call.completed ? "running" : call.success === false ? "failed" : "completed",
    durationMs: call.durationMs ?? null,
    input: call.arguments,
    output: texts.length > 0 ? texts.join("\n\n") : null,
    raw: rawItem ?? {
      type: "dynamicToolCall",
      id: call.callId,
      namespace: call.namespace,
      tool: call.tool,
      arguments: call.arguments,
      status: call.status,
      durationMs: call.durationMs,
      success: call.success,
      contentItems: call.contentItems,
    },
  };
}

export function inspectMcpToolCall(call: CodexMcpToolCallView): ToolCallInspection {
  const { result } = call;
  return {
    toolName: `${call.invocation.server}.${call.invocation.tool}`,
    status: !call.completed ? "running" : result?.type === "error" ? "failed" : "completed",
    durationMs: call.durationMs,
    input: call.invocation.arguments,
    output:
      result?.type === "error"
        ? result.error
        : result?.type === "success"
          ? stringifyToolCallValue(result.structuredContent ?? result.content)
          : null,
    raw: {
      callId: call.callId,
      invocation: call.invocation,
      durationMs: call.durationMs,
      result,
    },
  };
}

function InspectorFrame({
  title,
  inspection,
  pendingOutput,
}: {
  readonly title: ReactNode;
  readonly inspection: ToolCallInspection;
  /** Why the output cannot be shown yet, while the Runtime withholds it from the timeline. */
  readonly pendingOutput: string | null;
}) {
  const intl = useIntl();
  const [tab, setTab] = useState<InspectorTab>(
    inspection.status === "running" ? "input" : "output",
  );
  const value =
    tab === "input"
      ? isEmptyInput(inspection.input)
        ? null
        : typeof inspection.input === "string"
          ? inspection.input
          : stringifyToolCallValue(inspection.input)
      : pendingOutput
        ? null
        : tab === "output"
          ? inspection.output
          : stringifyToolCallValue(inspection.raw);
  const placeholder =
    tab === "input"
      ? intl.formatMessage({
          id: "conversation.toolCallInspector.noInput",
          defaultMessage: "This call took no input.",
        })
      : (pendingOutput ??
        (inspection.status === "running"
          ? intl.formatMessage({
              id: "conversation.toolCallInspector.noOutputYet",
              defaultMessage: "No output yet.",
            })
          : intl.formatMessage({
              id: "conversation.toolCallInspector.emptyOutput",
              defaultMessage: "This call returned nothing.",
            })));
  const details = [
    inspection.toolName,
    intl.formatMessage(STATUS_LABELS[inspection.status]),
    inspection.durationMs === null ? null : formatToolCallDuration(intl, inspection.durationMs),
  ].filter(Boolean);

  return (
    <DialogFrame>
      <DialogHeader className="gap-1">
        <DialogTitle className="truncate">{title}</DialogTitle>
        <p className="truncate text-xs text-token-description-foreground">
          <span className="font-code">{details[0]}</span>
          {details.slice(1).map((detail) => ` · ${detail}`)}
        </p>
      </DialogHeader>
      <DialogBody className="flex max-h-[min(70vh,44rem)] min-h-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <BrowseTabs
            ariaLabel={intl.formatMessage({
              id: "conversation.toolCallInspector.toolCallDetails",
              defaultMessage: "Tool call details",
            })}
            tabs={INSPECTOR_TABS.map(({ key, name }) => ({ key, name: intl.formatMessage(name) }))}
            selectedKey={tab}
            onSelect={setTab}
            className="[&_[role=tab]]:h-7 [&_[role=tab]]:px-3"
          />
          {value === null ? null : (
            <CopyMessageActionButton
              getText={() => value}
              label={intl.formatMessage({
                id: "conversation.toolCallInspector.copy",
                defaultMessage: "Copy",
              })}
              copiedLabel={intl.formatMessage({
                id: "conversation.toolCallInspector.copied",
                defaultMessage: "Copied",
              })}
              tooltipLabel={intl.formatMessage({
                id: "conversation.toolCallInspector.copy",
                defaultMessage: "Copy",
              })}
              copiedTooltipLabel={intl.formatMessage({
                id: "conversation.toolCallInspector.copied",
                defaultMessage: "Copied",
              })}
            />
          )}
        </div>
        <div
          role="tabpanel"
          className="flex min-h-0 flex-col"
          aria-label={intl
            .formatMessage(INSPECTOR_TABS.find(({ key }) => key === tab)!.name)
            .toLocaleLowerCase(intl.locale)}
        >
          {value === null ? (
            <p className="py-3 text-size-chat text-token-description-foreground">{placeholder}</p>
          ) : (
            <ToolCallSourceSurface
              key={tab}
              value={value}
              ariaLabel={intl.formatMessage(
                {
                  id: "conversation.toolCallInspector.tab",
                  defaultMessage:
                    "Tool call {tab, select, input {input} output {output} other {raw}}",
                },
                { tab },
              )}
              language={/^\s*[{[]/u.test(value) ? "json" : null}
            />
          )}
        </div>
      </DialogBody>
    </DialogFrame>
  );
}

/**
 * The way to a tool call's exact input, output and record, for whoever needs to know precisely
 * what happened. It stays out of the way until its row is hovered or focused, and reads a withheld
 * output only when opened.
 */
export function ToolCallInspector({
  item,
  outputOmitted,
  title,
  inspect,
}: {
  readonly item: CodexTranscriptEntry;
  readonly outputOmitted: boolean | undefined;
  readonly title: ReactNode;
  readonly inspect: () => ToolCallInspection;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const dialogId = useId();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const { error, available } = useToolCallOutputDetail(item, open, outputOmitted);
  const pendingOutput = outputOmitted
    ? (error ??
      (available
        ? intl.formatMessage({
            id: "conversation.toolCallInspector.loadingOutput",
            defaultMessage: "Loading output…",
          })
        : intl.formatMessage({
            id: "conversation.toolCallInspector.unavailable",
            defaultMessage: "Tool output unavailable",
          })))
    : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <NodexTooltip
        tooltipContent={intl.formatMessage({
          id: "conversation.toolCallInspector.inspect",
          defaultMessage: "Inspect tool call",
        })}
        side="top"
        delay={0}
      >
        <button
          type="button"
          aria-label={intl.formatMessage({
            id: "conversation.toolCallInspector.inspect",
            defaultMessage: "Inspect tool call",
          })}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={dialogId}
          data-state={open ? "open" : "closed"}
          data-tool-call-inspector=""
          className="relative flex size-5 shrink-0 cursor-interaction items-center justify-center rounded-md text-token-description-foreground opacity-0 hover:bg-token-list-hover-background hover:text-token-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none group-hover/activity-header:opacity-100 group-has-[:focus-visible]/activity-header:opacity-100 data-[state=open]:opacity-100"
          onClick={() => {
            setOpen(true);
          }}
          onPointerEnter={preloadSourceViewer}
          onFocus={preloadSourceViewer}
        >
          <CodeIcon className="icon-2xs" />
        </button>
      </NodexTooltip>
      <DialogContent
        id={dialogId}
        ref={contentRef}
        tabIndex={-1}
        showCloseButton={false}
        aria-describedby={undefined}
        initialFocus={contentRef}
        size="large"
      >
        {open ? (
          <InspectorFrame title={title} inspection={inspect()} pendingOutput={pendingOutput} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
