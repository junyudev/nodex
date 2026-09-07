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
import {
  resolveNodexDynamicToolCallPresentation,
  type NodexDynamicToolPresentationIcon,
} from "../../../projection/tool-metadata/nodex-dynamic-tool-call-presentation";
import { CodexShimmerText } from "../codex-shimmer-text";
import type { ToolComponentProps } from "./get-tool-component";
import { AutomationUpdatePage } from "./automation-update-page";
import { ThreadActivityDisclosure, ThreadRichActivityHeader } from "./tool-primitives";
import { NodexDynamicToolChangePreview } from "./nodex-dynamic-tool-change-preview";
import { ToolActivityIcon, semanticToolIcon } from "./tool-call-icons";
import {
  ActivitySpinnerIcon,
  AppActivityIcon,
  CreatedTaskIcon,
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

function openCodexAppCreatedThreadResult(
  result: ReturnType<typeof parseCodexAppCreateThreadResult>,
  onOpenThread?: ToolComponentProps["onOpenThread"],
) {
  if (!result) return;
  void onOpenThread?.(
    typeof result.threadId === "string" ? result.threadId : result.clientThreadId,
  );
}

function CodexAppCreatedThreadCard({
  onOpenThread,
  result,
}: {
  onOpenThread?: ToolComponentProps["onOpenThread"];
  result: NonNullable<ReturnType<typeof parseCodexAppCreateThreadResult>>;
}) {
  const isPendingWorktree = "clientThreadId" in result;
  const ariaLabel = "Open chat";
  const title = isPendingWorktree ? "Worktree chat" : "Chat created";
  const action = "Open chat";

  return (
    <div className="flex max-w-full flex-col overflow-hidden rounded-lg bg-token-dropdown-background/50 text-token-foreground [--thread-resource-card-row-padding-x:0.75rem] electron:elevation-stroke extension:border extension:border-token-border extension:bg-token-input-background/50 extension:shadow-sm">
      <button
        type="button"
        aria-label={ariaLabel}
        className="w-full cursor-interaction text-left hover:bg-token-list-hover-background/30 focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none focus-visible:ring-inset"
        onClick={() => openCodexAppCreatedThreadResult(result, onOpenThread)}
      >
        <span className="flex min-w-0 items-center gap-2.5 px-[var(--thread-resource-card-row-padding-x)] py-3 text-left">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-token-bg-secondary text-token-text-secondary">
            <CreatedTaskIcon className="icon-sm" aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-size-chat truncate font-medium text-token-foreground">
              {title}
            </span>
          </span>
          <span className="text-token-button-tertiary-foreground flex h-token-button-composer shrink-0 items-center gap-1 overflow-hidden rounded-lg border border-token-border bg-transparent px-2 py-0 text-base leading-[18px] whitespace-nowrap">
            {action}
          </span>
        </span>
      </button>
    </div>
  );
}

function AutomationUpdateToolCall({
  call,
  currentThreadId,
  onOpenSummaryScheduledAutomation,
  variant = "row",
}: {
  call: CodexDynamicToolCallView;
  currentThreadId: string | null;
  onOpenSummaryScheduledAutomation?: ToolComponentProps["onOpenSummaryScheduledAutomation"];
  variant?: DynamicToolCallRenderVariant;
}) {
  const state = resolveAutomationUpdateRenderState(call, currentThreadId);
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

  if (
    variant === "row" &&
    call.tool === "create_thread" &&
    call.completed &&
    call.success === true
  ) {
    const result = parseCodexAppCreateThreadResult(call);
    if (result) {
      return <CodexAppCreatedThreadCard onOpenThread={onOpenThread} result={result} />;
    }
  }

  const label = resolveDynamicToolRegistryLabel(call, isLeadingSummaryPart);
  if (!label) return null;
  const navigationThreadId = variant === "row" ? getThreadNavigationTarget(call) : null;
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
              void onOpenThread(navigationThreadId);
            }
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
    case "automationUpdate":
      if (!resolveDynamicToolRegistryLabel(call)) return null;
      return (
        <AutomationUpdateToolCall
          call={call}
          currentThreadId={currentThreadId ?? null}
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
          currentThreadId={currentThreadId ?? null}
          isLeadingSummaryPart={isLeadingSummaryPart}
          call={call}
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
  const isCodexApp = call.namespace === "codex_app";
  const showIcon = isCodexApp && variant !== "summary-text";
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
      {showIcon ? (
        <AppActivityIcon className="icon-xs shrink-0 text-token-text-secondary" aria-hidden />
      ) : null}
      <CodexShimmerText active={!call.completed} className={cn(showIcon && "min-w-0 truncate")}>
        {label}
      </CodexShimmerText>
    </span>
  );

  if (variant !== "row") return content;

  return (
    <ThreadRichActivityHeader
      icon={isCodexApp ? <ToolActivityIcon descriptor={semanticToolIcon("app")} /> : null}
      summary={<DynamicToolFallbackLabel call={call} variant="summary-text" />}
    />
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

  return content ?? <DynamicToolFallbackLabel call={call} />;
}
