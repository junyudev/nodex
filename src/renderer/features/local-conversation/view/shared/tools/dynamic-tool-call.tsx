import { useEffect, useState, type ReactNode } from "react";
import { CalendarClock, Circle } from "@/components/shared/icons/generic-icons";
import type { CodexDynamicToolCallView } from "../../../../../lib/types";
import { cn } from "../../../../../lib/utils";
import {
  resolveNodexDynamicToolCallPresentation,
  type NodexDynamicToolPresentationIcon,
} from "../../../projection/tool-metadata/nodex-dynamic-tool-call-presentation";
import { CodexShimmerText } from "../codex-shimmer-text";
import type { ToolComponentProps } from "./get-tool-component";
import { ThreadActivityDisclosure } from "./tool-primitives";
import { DynamicToolCallInspector } from "./dynamic-tool-call-inspector";
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
  type CodexAppHandoffStep,
  getDynamicToolRegistryEntry,
  parseChromeTabContextTabId,
  parseCodexAppCreateThreadResult,
  resolveCodexAppHandoffRenderState,
  resolveAutomationUpdateRenderState,
  resolveDynamicToolFallbackLabel,
  resolveDynamicToolRegistryLabel,
  type AutomationUpdateRenderState,
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
  const ariaLabel = isPendingWorktree ? "Open worktree setup" : "Open task";
  const title = isPendingWorktree ? "Worktree task queued" : "Task created";
  const action = isPendingWorktree ? "Open setup" : "Open task";

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

function openAutomationUpdatePageTarget(
  state: AutomationUpdateRenderState,
  onOpenSummaryScheduledAutomation?: ToolComponentProps["onOpenSummaryScheduledAutomation"],
) {
  if (!onOpenSummaryScheduledAutomation) return;
  if (!state.automationId && !state.createInput && !state.updateInput) return;
  void onOpenSummaryScheduledAutomation?.({
    automationId: state.automationId,
    createInput: state.createInput,
    mode:
      state.displayMode === "suggested-create" || state.displayMode === "suggested-update"
        ? state.displayMode
        : "open",
    title: state.title,
    updateInput: state.updateInput,
  });
}

function AutomationUpdatePage({
  initialState,
  onOpenSummaryScheduledAutomation,
}: {
  initialState: AutomationUpdateRenderState;
  onOpenSummaryScheduledAutomation?: ToolComponentProps["onOpenSummaryScheduledAutomation"];
}) {
  const state = initialState;
  const canOpen = Boolean(
    onOpenSummaryScheduledAutomation &&
    (state.automationId || state.createInput || state.updateInput) &&
    !state.disabledReason,
  );
  const statusLabel = state.statusLabel;
  const subtitle = [statusLabel, state.subtitle].filter(Boolean).join(" · ");

  return (
    <div className="my-1">
      <div className="rounded-md border border-token-border-light bg-token-bg-primary/70">
        <button
          type="button"
          aria-label={[state.title, subtitle].filter(Boolean).join(" · ")}
          className="w-full cursor-interaction text-left hover:bg-token-list-hover-background/30 focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none focus-visible:ring-inset disabled:cursor-default"
          disabled={!canOpen}
          onClick={() => openAutomationUpdatePageTarget(state, onOpenSummaryScheduledAutomation)}
        >
          <div className="flex min-w-0 items-center gap-2 px-2 py-2">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-token-bg-secondary text-token-text-secondary">
              <CalendarClock className="size-5" aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate text-size-chat text-token-conversation-summary-leading">
                  {state.title}
                </span>
                <span className="shrink-0 text-size-chat text-token-conversation-summary-trailing">
                  {canOpen ? "Open" : state.openLabel}
                </span>
              </span>
              {subtitle ? (
                <span className="truncate text-xs text-token-text-secondary">{subtitle}</span>
              ) : null}
            </span>
          </div>
        </button>
        {state.disabledReason ? (
          <div className="border-t border-token-border-light px-2 py-2">
            <span className="min-w-0 text-xs text-token-editor-error-foreground">
              {state.disabledReason}
            </span>
          </div>
        ) : null}
      </div>
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
  const content = (
    <>
      {variant === "summary-text" ? null : icon}
      <CodexShimmerText
        active={active}
        className={cn(
          variant !== "summary-text" && "min-w-0 truncate",
          isClickableRow && "group-hover:!text-token-foreground",
        )}
      >
        {label}
      </CodexShimmerText>
    </>
  );
  const rowClassName = cn(
    "text-size-chat min-w-0 items-center",
    variant === "summary-text" ? "inline" : "inline-flex gap-1.5",
    variant === "row"
      ? "text-token-conversation-summary-leading"
      : "text-token-conversation-summary-trailing group-hover/activity-header:text-token-foreground",
    isClickableRow &&
      "group cursor-interaction rounded-md text-left focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none",
    className,
  );

  if (isClickableRow) {
    return (
      <button type="button" className={rowClassName} onClick={onClick}>
        {content}
      </button>
    );
  }

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
    <span
      aria-hidden="true"
      className="flex h-4 w-4 shrink-0 items-center justify-center text-token-text-secondary"
    >
      {icon}
    </span>
  );
}

function HandoffProgressStepRow({ step }: { step: CodexAppHandoffStep }) {
  const status = resolveHandoffProgressStepStatus(step.status);
  return (
    <div className="flex items-center gap-2">
      <HandoffProgressStepIcon status={status} />
      <div className="text-size-chat text-token-conversation-summary-leading">
        <span className="sr-only">
          {status === "running"
            ? "In progress: "
            : status === "done"
              ? "Completed: "
              : status === "failed"
                ? "Failed: "
                : "Pending: "}
        </span>
        {step.label}
      </div>
    </div>
  );
}

function CodexAppHandoffToolCall({
  call,
  variant = "row",
}: {
  call: CodexDynamicToolCallView;
  variant?: DynamicToolCallRenderVariant;
}) {
  if (!resolveDynamicToolRegistryLabel(call)) return null;
  const state = resolveCodexAppHandoffRenderState(call);
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

  const steps = state.result?.steps ?? [];
  const canExpand = steps.length > 0;
  const summary = (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 truncate text-token-conversation-summary-leading">
      {icon}
      <CodexShimmerText active={state.active} className="min-w-0 truncate">
        {state.label}
      </CodexShimmerText>
    </span>
  );

  return (
    <ThreadActivityDisclosure
      bodyClassName="pt-1 pl-5"
      canExpand={canExpand}
      defaultExpanded={state.activityStatus === "running" && canExpand}
      status={state.activityStatus}
      summary={summary}
    >
      <div className="flex flex-col gap-1">
        {steps.map((step) => (
          <HandoffProgressStepRow key={step.id} step={step} />
        ))}
      </div>
    </ThreadActivityDisclosure>
  );
}

function CodexAppThreadToolCall({
  call,
  onOpenThread,
  variant = "row",
}: {
  call: CodexDynamicToolCallView;
  onOpenThread?: ToolComponentProps["onOpenThread"];
  variant?: DynamicToolCallRenderVariant;
}) {
  if (call.tool === "handoff_thread") {
    return <CodexAppHandoffToolCall call={call} variant={variant} />;
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

  const label = resolveDynamicToolRegistryLabel(call);
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
  variant = "row",
}: {
  call: CodexDynamicToolCallView;
  variant?: DynamicToolCallRenderVariant;
}) {
  const label = resolveDynamicToolRegistryLabel(call);
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
  variant = "row",
}: {
  call: CodexDynamicToolCallView;
  variant?: DynamicToolCallRenderVariant;
}) {
  const tabId = parseChromeTabContextTabId(call);
  const metadata = useChromeTabMetadata(tabId, tabId !== null && !call.completed);
  if (tabId === null) return null;

  const baseLabel = resolveDynamicToolRegistryLabel(call);
  if (!baseLabel) return null;
  const label = metadata?.title
    ? call.completed
      ? `Read "${metadata.title}"`
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
  entry,
  currentThreadId,
  onOpenSummaryScheduledAutomation,
  onOpenThread,
  variant,
}: {
  call: CodexDynamicToolCallView;
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
      return <ChromeTabContextToolCall call={call} variant={variant} />;
    case "codexAppThread":
      if (!resolveDynamicToolRegistryLabel(call)) return null;
      return <CodexAppThreadToolCall call={call} onOpenThread={onOpenThread} variant={variant} />;
    case "nodexApp":
      return <NodexAppToolCall call={call} variant={variant} />;
    case "settings":
      if (!resolveDynamicToolRegistryLabel(call)) return null;
      return <SettingsToolCall call={call} variant={variant} />;
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

  return <div className="group">{content}</div>;
}

export function DynamicToolCallSummary({
  call,
  variant = "summary",
}: {
  call: CodexDynamicToolCallView;
  variant?: Exclude<DynamicToolCallRenderVariant, "row">;
}) {
  const entry = getDynamicToolRegistryEntry(call);
  if (entry) {
    const rendered = renderRegisteredDynamicToolCall({
      call,
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

  const nodexPresentation = resolveNodexDynamicToolCallPresentation(call);
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

  return (
    <DynamicToolCallInspector item={item} call={call} nodexPresentation={nodexPresentation}>
      {content ?? <DynamicToolFallbackLabel call={call} />}
    </DynamicToolCallInspector>
  );
}
