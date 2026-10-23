import {
  createCodexThreadHandoffOperationId,
  resolveCodexThreadHandoffStepLabel,
  type CodexAppHandoffOperation,
  type CodexAppHandoffStep,
} from "../../../../../../shared/codex-thread-handoff";
import { useThreadHandoffOperation } from "../../../../../lib/thread-handoff-runtime";
import { useEffect, useState, type ReactNode } from "react";
import { Circle } from "@/components/shared/icons/generic-icons";
import type { CodexDynamicToolCallView } from "../../../../../lib/types";
import { cn } from "../../../../../lib/utils";
import { readAgentSessionToolTarget } from "../../../projection/tool-metadata/agent-session-tool";
import {
  resolveNodexDynamicToolCallPresentation,
  type NodexDynamicToolPresentationIcon,
} from "../../../projection/tool-metadata/nodex-dynamic-tool-call-presentation";
import { CodexShimmerText } from "../codex-shimmer-text";
import { useToolCallOutputDetail } from "./use-tool-call-output-detail";
import { buildTextPreview, INLINE_TEXT_PREVIEW_MAX_CHARS } from "../../../../../lib/text-preview";
import type { ToolComponentProps } from "./get-tool-component";
import { AutomationUpdatePage } from "./automation-update-page";
import {
  ThreadActivityDisclosure,
  ThreadRichActivityHeader,
  ToolJsonDetail,
} from "./tool-primitives";
import { ToolCallCodePanel, ToolCallRawDialog } from "./tool-call-inspection";
import { ToolOutputImage } from "./tool-output-image";
import { NodexDynamicToolChangePreview } from "./nodex-dynamic-tool-change-preview";
import {
  ToolActivityIcon,
  resolveDynamicToolFallbackIcon,
  semanticToolIcon,
} from "./tool-call-icons";
import {
  ActivitySpinnerIcon,
  AppActivityIcon,
  DeniedCircleIcon,
  SuccessCircleIcon,
} from "@/components/shared/icons";
import {
  type CodexAppHandoffStatus,
  getDynamicToolRegistryEntry,
  parseCodexAppHandoffArguments,
  parseCodexAppHandoffResult,
  parseChromeTabContextTabId,
  parseCodexAppCreateThreadResult,
  resolveCodexAppHandoffRenderState,
  resolveAutomationUpdateRenderState,
  resolveDynamicToolFallbackLabel,
  resolveDynamicToolRegistryLabel,
  type DynamicToolRegistryEntry,
} from "./dynamic-tool-call-utils";

function AutomationUpdateToolCall({
  call,
  onOpenSummaryScheduledAutomation,
  variant = "row",
}: {
  call: CodexDynamicToolCallView;
  onOpenSummaryScheduledAutomation?: ToolComponentProps["onOpenSummaryScheduledAutomation"];
  variant?: DynamicToolCallRenderVariant;
}) {
  const state = resolveAutomationUpdateRenderState(call);
  const label = resolveDynamicToolRegistryLabel(call);
  const icon = (
    <ToolActivityIcon
      descriptor={semanticToolIcon("plugin")}
      className="icon-xs shrink-0 text-token-text-secondary"
    />
  );

  if (!label) return null;

  if (!state || variant !== "row" || !call.completed || call.success === false) {
    return (
      <DynamicToolRegistryLabelRow
        active={!call.completed}
        icon={variant === "summary-text" ? null : icon}
        label={label}
        variant={variant}
      />
    );
  }

  return (
    <AutomationUpdatePage
      initialState={state}
      onOpenSummaryScheduledAutomation={onOpenSummaryScheduledAutomation}
    />
  );
}

type DynamicToolCallRenderVariant = "row" | "summary" | "summary-text";

type HandoffProgressStepStatus = "done" | "failed" | "pending" | "running";

function getThreadNavigationTarget(call: CodexDynamicToolCallView): string | null {
  if (call.tool !== "read_thread" && call.tool !== "send_message_to_thread") return null;
  if (
    typeof call.arguments !== "object" ||
    call.arguments === null ||
    Array.isArray(call.arguments)
  )
    return null;
  const threadId = (call.arguments as Record<string, unknown>).threadId;
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId.trim() : null;
}

function DynamicToolRegistryLabelRow({
  active,
  className,
  icon,
  label,
  onClick,
  variant,
}: {
  active: boolean;
  className?: string;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  variant: DynamicToolCallRenderVariant;
}) {
  const isClickableRow = variant === "row" && onClick !== undefined;
  const summary = (
    <CodexShimmerText
      active={active}
      className={cn(
        variant !== "summary-text" && "min-w-0 truncate",
        isClickableRow && "group-hover:!text-token-foreground",
      )}
    >
      {label}
    </CodexShimmerText>
  );

  if (variant === "row") {
    return (
      <ThreadRichActivityHeader
        className={className}
        icon={icon}
        summary={
          isClickableRow ? (
            <button
              type="button"
              className="group max-w-full cursor-interaction rounded-md text-left focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none"
              onClick={onClick}
            >
              {summary}
            </button>
          ) : (
            summary
          )
        }
      />
    );
  }

  const content = (
    <>
      {variant === "summary-text" ? null : icon}
      {summary}
    </>
  );
  const rowClassName = cn(
    "text-size-chat min-w-0 items-center",
    variant === "summary-text" ? "inline" : "inline-flex gap-1.5",
    "text-token-conversation-summary-trailing group-hover/activity-header:text-token-foreground",
    className,
  );

  return <span className={rowClassName}>{content}</span>;
}

function resolveHandoffProgressStepStatus(
  status: CodexAppHandoffStatus,
): HandoffProgressStepStatus {
  if (status === "running") return "running";
  if (status === "success" || status === "warning") return "done";
  if (status === "error") return "failed";
  return "pending";
}

function HandoffProgressStepIcon({ status }: { status: HandoffProgressStepStatus }) {
  const className = "icon-xs";
  const icon = (() => {
    switch (status) {
      case "done":
        return <SuccessCircleIcon className={className} />;
      case "failed":
        return <DeniedCircleIcon className={cn(className, "text-token-editor-error-foreground")} />;
      case "running":
        return <ActivitySpinnerIcon className={className} />;
      case "pending":
        return <Circle className={className} />;
    }
  })();

  return (
    <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center">
      {icon}
    </span>
  );
}

function HandoffProgressStepRow({
  step,
  operation,
}: {
  step: CodexAppHandoffStep;
  operation: CodexAppHandoffOperation;
}) {
  const status = resolveHandoffProgressStepStatus(step.status);
  return (
    <div
      className={cn(
        "flex items-center gap-2",
        status === "failed" ? "text-danger" : status === "pending" ? "text-tertiary" : "text-info",
      )}
    >
      <HandoffProgressStepIcon status={status} />
      <div className="text-size-chat">
        <span className="sr-only">
          {status === "running"
            ? "In progress: "
            : status === "done"
              ? "Completed: "
              : status === "failed"
                ? "Failed: "
                : "Pending: "}
        </span>
        {resolveCodexThreadHandoffStepLabel(step.id, operation) ?? step.label}
      </div>
    </div>
  );
}

function CodexAppHandoffToolCall({
  call,
  currentThreadId,
  variant = "row",
}: {
  call: CodexDynamicToolCallView;
  currentThreadId: string | null;
  variant?: DynamicToolCallRenderVariant;
}) {
  const args = parseCodexAppHandoffArguments(call);
  const result = call.completed && call.success === true ? parseCodexAppHandoffResult(call) : null;
  const operation = useThreadHandoffOperation(
    args && currentThreadId
      ? {
          operationId:
            result?.operationId ??
            createCodexThreadHandoffOperationId(currentThreadId, call.callId),
          requestThreadId: currentThreadId,
          targetThreadId: args.threadId,
          destinationHostId: args.destinationHostId,
        }
      : null,
  );
  if (!args) return null;
  const state = resolveCodexAppHandoffRenderState(call, operation);
  return <HandoffActivity state={state} operation={operation} variant={variant} />;
}

export function HandoffActivity({
  state,
  operation,
  variant = "row",
}: {
  state: { active: boolean; label: string; activityStatus: "running" | "completed" | "failed" };
  operation: CodexAppHandoffOperation | null;
  variant?: DynamicToolCallRenderVariant;
}) {
  const icon = (
    <AppActivityIcon className="icon-xs shrink-0 text-token-conversation-body" aria-hidden />
  );

  if (variant !== "row") {
    return (
      <DynamicToolRegistryLabelRow
        active={state.active}
        icon={variant === "summary-text" ? null : icon}
        label={state.label}
        variant={variant}
      />
    );
  }

  const summary = (
    <CodexShimmerText active={state.active} className="min-w-0 truncate">
      {state.label}
    </CodexShimmerText>
  );

  return (
    <ThreadActivityDisclosure
      autoExpandWhileRunning
      indentContent={false}
      icon={icon}
      status={state.activityStatus}
      summary={summary}
    >
      {operation?.steps.map((step) => (
        <HandoffProgressStepRow key={step.id} step={step} operation={operation} />
      ))}
    </ThreadActivityDisclosure>
  );
}

function CodexAppThreadToolCall({
  call,
  currentThreadId,
  isLeadingSummaryPart = true,
  onOpenThread,
  variant = "row",
}: {
  call: CodexDynamicToolCallView;
  currentThreadId: string | null;
  isLeadingSummaryPart?: boolean;
  onOpenThread?: ToolComponentProps["onOpenThread"];
  variant?: DynamicToolCallRenderVariant;
}) {
  if (call.tool === "handoff_thread") {
    return (
      <CodexAppHandoffToolCall currentThreadId={currentThreadId} call={call} variant={variant} />
    );
  }

  const label = resolveDynamicToolRegistryLabel(call, isLeadingSummaryPart);
  if (!label) return null;
  const createdTarget = variant === "row" ? parseCodexAppCreateThreadResult(call) : null;
  const codexTarget = createdTarget?.kind === "chatgpt" ? null : createdTarget;
  const existingTarget =
    variant === "row" && call.tool !== "create_thread" ? getThreadNavigationTarget(call) : null;
  const navigationThreadId =
    codexTarget !== null
      ? "threadId" in codexTarget
        ? codexTarget.threadId
        : codexTarget.clientThreadId
      : existingTarget;
  const isNavigableRow = navigationThreadId !== null;
  const iconClassName = cn(
    "icon-xs shrink-0 text-token-conversation-body",
    isNavigableRow && "group-hover:!text-token-foreground",
  );

  return (
    <DynamicToolRegistryLabelRow
      active={!call.completed}
      icon={
        variant === "summary-text" ? null : (
          <AppActivityIcon className={iconClassName} aria-hidden />
        )
      }
      label={label}
      onClick={
        navigationThreadId && onOpenThread
          ? () => {
              void onOpenThread(
                navigationThreadId,
                codexTarget ? { createdTarget: codexTarget } : undefined,
              );
            }
          : undefined
      }
      variant={variant}
    />
  );
}

/** A chat an Agent created, forked or messaged opens from its row. */
function AgentSessionToolCall({
  call,
  onOpenThread,
  variant = "row",
}: {
  call: CodexDynamicToolCallView;
  onOpenThread?: ToolComponentProps["onOpenThread"];
  variant?: DynamicToolCallRenderVariant;
}) {
  const label = resolveDynamicToolRegistryLabel(call);
  if (!label) return null;
  const target = variant === "row" ? readAgentSessionToolTarget(call) : null;
  return (
    <DynamicToolRegistryLabelRow
      active={!call.completed}
      icon={
        variant === "summary-text" ? null : (
          <AppActivityIcon
            className={cn(
              "icon-xs shrink-0 text-token-conversation-body",
              target && "group-hover:!text-token-foreground",
            )}
            aria-hidden
          />
        )
      }
      label={label}
      onClick={
        target && onOpenThread
          ? () => void onOpenThread(target.threadId, { runtimeSessionId: target.sessionId })
          : undefined
      }
      variant={variant}
    />
  );
}

function SettingsToolCall({
  call,
  isLeadingSummaryPart = true,
  variant = "row",
}: {
  call: CodexDynamicToolCallView;
  isLeadingSummaryPart?: boolean;
  variant?: DynamicToolCallRenderVariant;
}) {
  const label = resolveDynamicToolRegistryLabel(call, isLeadingSummaryPart);
  if (!label) return null;

  return (
    <DynamicToolRegistryLabelRow
      active={!call.completed}
      icon={
        variant === "summary-text" ? null : (
          <ToolActivityIcon
            descriptor={semanticToolIcon("settings")}
            className="icon-xs shrink-0 text-token-conversation-body"
          />
        )
      }
      label={label}
      variant={variant}
    />
  );
}

function nodexPresentationIcon(icon: NodexDynamicToolPresentationIcon) {
  switch (icon) {
    case "database":
      return semanticToolIcon("settings");
    case "read":
      return semanticToolIcon("list-files");
    case "search":
      return semanticToolIcon("code-searching");
    case "transfer":
    case "write":
      return semanticToolIcon("edit-files");
  }
}

function NodexAppToolCall({
  call,
  variant = "row",
}: {
  call: CodexDynamicToolCallView;
  variant?: DynamicToolCallRenderVariant;
}) {
  const presentation = resolveNodexDynamicToolCallPresentation(call);
  if (!presentation) return null;

  return (
    <>
      <DynamicToolRegistryLabelRow
        active={!call.completed}
        icon={
          variant === "summary-text" ? null : (
            <ToolActivityIcon
              descriptor={nodexPresentationIcon(presentation.icon)}
              className="icon-xs shrink-0 text-token-conversation-body"
            />
          )
        }
        label={presentation.label}
        variant={variant}
      />
      {variant === "row" && presentation.markdownChange ? (
        <NodexDynamicToolChangePreview change={presentation.markdownChange} />
      ) : null}
    </>
  );
}

interface ChromeTabMetadata {
  faviconUrl: string | null;
  title: string | null;
}

type ChromeRuntimeApi = {
  getURL?: (path: string) => string;
};

type ChromeTabsApi = {
  get?: (tabId: number) => Promise<{
    favIconUrl?: string | null;
    pendingUrl?: string | null;
    title?: string | null;
    url?: string | null;
  }>;
};

type ChromeExtensionApi = {
  runtime?: ChromeRuntimeApi | null;
  tabs?: ChromeTabsApi | null;
};

function getChromeExtensionApi(): ChromeExtensionApi | null {
  const value = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
  if (typeof value !== "object" || value === null) return null;
  return value as ChromeExtensionApi;
}

function resolveChromeFaviconUrl(
  tab: Awaited<ReturnType<NonNullable<ChromeTabsApi["get"]>>>,
  runtime: ChromeRuntimeApi | null | undefined,
): string | null {
  const favicon = tab.favIconUrl?.trim();
  if (!favicon) return null;
  const pageUrl = (tab.url ?? tab.pendingUrl ?? "").trim();
  if (!pageUrl || !runtime?.getURL) return favicon;

  try {
    const url = new URL(runtime.getURL("/_favicon/"));
    url.searchParams.set("pageUrl", pageUrl);
    url.searchParams.set("size", "32");
    return url.toString();
  } catch {
    return favicon;
  }
}

function useChromeTabMetadata(tabId: number | null, enabled: boolean): ChromeTabMetadata | null {
  const [metadata, setMetadata] = useState<ChromeTabMetadata | null>(null);

  useEffect(() => {
    if (!enabled || tabId === null) return;
    const chromeApi = getChromeExtensionApi();
    const getTab = chromeApi?.tabs?.get;
    if (!getTab) return;

    let cancelled = false;
    void getTab(tabId)
      .then((tab) => {
        if (cancelled) return;
        const title = tab.title?.trim() || null;
        setMetadata({
          faviconUrl: resolveChromeFaviconUrl(tab, chromeApi.runtime),
          title,
        });
      })
      .catch(() => {
        if (!cancelled) setMetadata(null);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, tabId]);

  return metadata;
}

function ChromeTabContextToolCall({
  call,
  isLeadingSummaryPart = true,
  variant = "row",
}: {
  call: CodexDynamicToolCallView;
  isLeadingSummaryPart?: boolean;
  variant?: DynamicToolCallRenderVariant;
}) {
  const tabId = parseChromeTabContextTabId(call);
  const metadata = useChromeTabMetadata(tabId, tabId !== null && !call.completed);
  if (tabId === null) return null;

  const baseLabel = resolveDynamicToolRegistryLabel(call, isLeadingSummaryPart);
  if (!baseLabel) return null;
  const label = metadata?.title
    ? call.completed
      ? `${isLeadingSummaryPart ? "Read" : "read"} "${metadata.title}"`
      : `Reading "${metadata.title}"`
    : baseLabel;

  return (
    <DynamicToolRegistryLabelRow
      active={!call.completed}
      icon={
        variant !== "summary-text" && metadata?.faviconUrl ? (
          <img
            alt=""
            className="icon-xs shrink-0 text-token-input-placeholder-foreground"
            src={metadata.faviconUrl}
          />
        ) : null
      }
      label={label}
      variant={variant}
    />
  );
}

function renderRegisteredDynamicToolCall({
  call,
  isLeadingSummaryPart = true,
  entry,
  currentThreadId,
  onOpenSummaryScheduledAutomation,
  onOpenThread,
  variant,
}: {
  call: CodexDynamicToolCallView;
  isLeadingSummaryPart?: boolean;
  entry: DynamicToolRegistryEntry;
  currentThreadId?: string | null;
  onOpenSummaryScheduledAutomation?: ToolComponentProps["onOpenSummaryScheduledAutomation"];
  onOpenThread?: ToolComponentProps["onOpenThread"];
  variant: DynamicToolCallRenderVariant;
}) {
  switch (entry.rendererKind) {
    case "agentSession":
      return <AgentSessionToolCall call={call} onOpenThread={onOpenThread} variant={variant} />;
    case "automationUpdate":
      if (!resolveDynamicToolRegistryLabel(call)) return null;
      return (
        <AutomationUpdateToolCall
          call={call}
          onOpenSummaryScheduledAutomation={onOpenSummaryScheduledAutomation}
          variant={variant}
        />
      );
    case "chromeTabContext":
      if (parseChromeTabContextTabId(call) === null) return null;
      return (
        <ChromeTabContextToolCall
          isLeadingSummaryPart={isLeadingSummaryPart}
          call={call}
          variant={variant}
        />
      );
    case "codexAppThread":
      if (!resolveDynamicToolRegistryLabel(call)) return null;
      return (
        <CodexAppThreadToolCall
          isLeadingSummaryPart={isLeadingSummaryPart}
          call={call}
          currentThreadId={currentThreadId ?? null}
          onOpenThread={onOpenThread}
          variant={variant}
        />
      );
    case "nodexApp":
      return <NodexAppToolCall call={call} variant={variant} />;
    case "settings":
      if (!resolveDynamicToolRegistryLabel(call)) return null;
      return (
        <SettingsToolCall
          isLeadingSummaryPart={isLeadingSummaryPart}
          call={call}
          variant={variant}
        />
      );
  }
}

function DynamicToolFallbackLabel({
  call,
  variant = "row",
}: {
  call: CodexDynamicToolCallView;
  variant?: DynamicToolCallRenderVariant;
}) {
  const showIcon = variant !== "summary-text";
  const label = resolveDynamicToolFallbackLabel(call);
  const content = (
    <span
      className={cn(
        "text-size-chat text-token-conversation-summary-trailing",
        variant === "row"
          ? "group-hover:text-token-foreground"
          : "group-hover/activity-header:text-token-foreground",
        showIcon && "flex min-w-0 items-center gap-2",
      )}
    >
      {showIcon ? <ToolActivityIcon descriptor={resolveDynamicToolFallbackIcon(call)} /> : null}
      <CodexShimmerText active={!call.completed} className={cn(showIcon && "min-w-0 truncate")}>
        {label}
      </CodexShimmerText>
    </span>
  );

  if (variant !== "row") return content;

  return (
    <ThreadRichActivityHeader
      icon={<ToolActivityIcon descriptor={resolveDynamicToolFallbackIcon(call)} />}
      summary={<DynamicToolFallbackLabel call={call} variant="summary-text" />}
    />
  );
}

/** Unregistered tools retain one compact activity and an inspectable typed result. */
function DynamicToolFallbackDetails({ item }: ToolComponentProps) {
  const { error: outputError, available: outputAvailable } = useToolCallOutputDetail(
    item,
    true,
    item.dynamicToolCall?.outputOmitted,
  );
  const [rawOpen, setRawOpen] = useState(false);
  const call = item.dynamicToolCall!;
  const args = call.arguments;
  const code =
    call.tool === "js" && args !== null && typeof args === "object" && !Array.isArray(args)
      ? args.code
      : null;
  const codeText = typeof code === "string" ? code : null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="truncate text-xs text-token-description-foreground">
        {[call.namespace, call.tool].filter(Boolean).join(".")}
      </div>
      {codeText !== null ? (
        <ToolCallCodePanel
          title="javascript"
          preview={buildTextPreview(codeText, INLINE_TEXT_PREVIEW_MAX_CHARS)}
          getCopyText={() => codeText}
          getFullText={() => codeText}
        />
      ) : (
        <ToolJsonDetail label="Arguments" value={call.arguments} />
      )}
      {outputError ? (
        <p role="alert">{outputError}</p>
      ) : call.outputOmitted ? (
        <p className="text-token-description-foreground">
          {outputAvailable ? "Loading output…" : "Tool output unavailable"}
        </p>
      ) : (
        (call.contentItems ?? []).map((content, index) =>
          content.type === "inputImage" ? (
            <ToolOutputImage key={index} source={content.imageUrl} />
          ) : content.type === "inputAudio" ? (
            <audio key={index} src={content.audioUrl} controls preload="metadata" />
          ) : (
            <ToolCallCodePanel
              key={index}
              title="Output"
              preview={buildTextPreview(content.text, INLINE_TEXT_PREVIEW_MAX_CHARS)}
              getCopyText={() => content.text}
              getFullText={() => content.text}
            />
          ),
        )
      )}
      {!call.outputOmitted ? (
        <ToolCallRawDialog
          open={rawOpen}
          onOpenChange={setRawOpen}
          title={`Raw ${[call.namespace, call.tool].filter(Boolean).join(".")} tool call`}
          triggerLabel="Show raw tool call output"
          getRawValue={() =>
            item.rawItem ?? {
              type: "dynamicToolCall",
              id: call.callId,
              namespace: call.namespace,
              tool: call.tool,
              arguments: call.arguments,
              status: call.status,
              durationMs: call.durationMs,
              success: call.success,
              contentItems: call.contentItems,
            }
          }
        />
      ) : null}
    </div>
  );
}

function DynamicToolFallbackRow({ item }: ToolComponentProps) {
  const call = item.dynamicToolCall!;
  return (
    <ThreadActivityDisclosure
      icon={<ToolActivityIcon descriptor={resolveDynamicToolFallbackIcon(call)} />}
      summary={<DynamicToolFallbackLabel call={call} variant="summary-text" />}
      status={!call.completed ? "running" : call.success === false ? "failed" : "completed"}
    >
      {(expanded) => (expanded ? <DynamicToolFallbackDetails item={item} /> : null)}
    </ThreadActivityDisclosure>
  );
}

export function DynamicToolCallSummary({
  call,
  isLeadingSummaryPart = true,
  variant = "summary",
}: {
  call: CodexDynamicToolCallView;
  isLeadingSummaryPart?: boolean;
  variant?: Exclude<DynamicToolCallRenderVariant, "row">;
}) {
  const entry = getDynamicToolRegistryEntry(call);
  if (entry) {
    const rendered = renderRegisteredDynamicToolCall({
      call,
      isLeadingSummaryPart,
      entry,
      currentThreadId: null,
      variant,
    });
    if (rendered) return rendered;
  }

  return <DynamicToolFallbackLabel call={call} variant={variant} />;
}

export function DynamicToolCall({
  item,
  onOpenSummaryScheduledAutomation,
  onOpenThread,
}: ToolComponentProps) {
  const call = item.dynamicToolCall ?? null;

  if (!call) return null;

  let content: ReactNode = null;
  const entry = getDynamicToolRegistryEntry(call);
  if (entry) {
    content = renderRegisteredDynamicToolCall({
      call,
      entry,
      currentThreadId: item.threadId,
      onOpenSummaryScheduledAutomation,
      onOpenThread,
      variant: "row",
    });
  }

  return content ?? <DynamicToolFallbackRow item={item} />;
}
