import { motion } from "motion/react";
import { useEffect, useId, useMemo, useState } from "react";
import { PanelRightVisibleIcon } from "@/components/shared/icons";
import { LoadingPlaceholder } from "@/components/ui/loading-placeholder";
import { NodexTooltip } from "../../../../../components/ui/tooltip";
import type {
  CodexMcpToolCallContentBlock,
  CodexMcpToolCallView,
  CodexTranscriptEntry,
  ProtocolListMcpServerStatusResponse,
} from "../../../../../lib/types";
import type { ThreadStageActions } from "../../../thread-stage-types";
import { useMcpResource, useMcpServerStatuses } from "../../../../../lib/use-mcp-queries";
import { cn } from "../../../../../lib/utils";
import {
  buildTextPreview,
  INLINE_TEXT_PREVIEW_MAX_CHARS,
  type TextPreview,
} from "../../../../../lib/text-preview";
import { CODEX_THREAD_ACCORDION_TRANSITION } from "../thread-motion";
import { useMeasuredElementHeight } from "../use-measured-element-height";
import { CodexShimmerText } from "../codex-shimmer-text";
import {
  AutomaticApprovalReviewRows,
  AutomaticApprovalReviewShield,
} from "../automatic-approval-review-surface";
import { ThreadActivityHeader, ThreadActivityShell, ToolErrorDetail } from "./tool-primitives";
import { asRecord } from "./tool-call-utils";
import { ToolActivityIcon, resolveMcpSourceIcon } from "./tool-call-icons";
import { resolveMcpToolActivityLabel } from "./mcp-tool-call-labels";
import { McpCapabilityViewFrame } from "./mcp-capability-view-frame";
import { useThreadMcpApps } from "./mcp-apps-context";
import { ToolCallCodePanel, ToolCallRawDialog } from "./tool-call-inspection";
import {
  buildMcpAppSidePanelInput,
  isMcpAppHtmlTooLarge,
  resolveMcpAppFrameHeight,
  buildMcpAppCapabilityId,
  resolveMcpAppResourceUri,
  resolveMcpAppResourceScopeUri,
  resolveMcpExpandedSuccessDisplay,
  resolveMcpRenderableResource,
  shouldHideDuplicateMcpTextContent,
  shouldShowMcpStructuredContent,
  stringifyMcpValue,
  type McpRenderableResource,
} from "./mcp-tool-call-resource-utils";

const electronToolIconSizeClassName = "electron:[&>svg]:icon-sm";
const EMPTY_MCP_SERVER_STATUSES: ProtocolListMcpServerStatusResponse = {
  data: [],
  nextCursor: null,
};
const MCP_MINIMUM_USEFUL_TEXT_PREVIEW_CHARS = 64;

interface BudgetedMcpContentBlock {
  readonly block: CodexMcpToolCallContentBlock;
  readonly textValue?: string;
  readonly textPreview?: TextPreview;
}

function mcpContentBlockText(block: CodexMcpToolCallContentBlock): string | null {
  if (block.type === "text") {
    return appendAnnotations(block.text, block.annotations);
  }

  if (block.type === "resource_link") {
    const name = block.title ?? block.name ?? block.uri;
    const annotations = formatAnnotations(block.annotations);
    return annotations ? `Read ${name}\nAnnotations: ${annotations}` : `Read ${name}`;
  }

  if (block.type === "embedded_resource") {
    const resource = block.resource;
    const fields = [
      `URI ${resource.uri}`,
      resource.mimeType ? `MIME type ${resource.mimeType}` : null,
      formatAnnotations(resource.annotations)
        ? `Annotations ${formatAnnotations(resource.annotations)}`
        : null,
      (resource.text ?? resource.blob) ? `Content\n${resource.text ?? resource.blob ?? ""}` : null,
    ].filter((value): value is string => value !== null);
    return fields.join("\n");
  }

  if (block.type === "image" || block.type === "audio") {
    const annotations = formatAnnotations(block.annotations);
    return annotations ? `Annotations: ${annotations}` : null;
  }

  return stringifyMcpValue(block.raw, 2);
}

function budgetMcpContentBlocks(blocks: readonly CodexMcpToolCallContentBlock[]): {
  readonly blocks: readonly BudgetedMcpContentBlock[];
  readonly omittedCharacters: number;
} {
  const result: BudgetedMcpContentBlock[] = [];
  let remainingCharacters = INLINE_TEXT_PREVIEW_MAX_CHARS;
  let omittedCharacters = 0;

  for (const block of blocks) {
    const textValue = mcpContentBlockText(block);
    if (textValue === null) {
      result.push({ block });
      continue;
    }

    if (remainingCharacters < MCP_MINIMUM_USEFUL_TEXT_PREVIEW_CHARS) {
      omittedCharacters += textValue.length;
      if (block.type === "image" || block.type === "audio") {
        result.push({ block });
      }
      continue;
    }
    const textPreview = buildTextPreview(textValue, remainingCharacters);
    remainingCharacters -= textPreview.text.length;
    result.push({ block, textValue, textPreview });
  }

  return { blocks: result, omittedCharacters };
}

interface McpToolCallProps {
  automaticApprovalReviews?: readonly CodexTranscriptEntry[];
  item: CodexTranscriptEntry;
  rawDialogOpen?: boolean;
  onRawDialogOpenChange?: (open: boolean) => void;
  onOpenMcpAppSidePanel?: ThreadStageActions["onOpenMcpAppSidePanel"];
}

const EMPTY_AUTOMATIC_APPROVAL_REVIEWS: readonly CodexTranscriptEntry[] = [];

function formatAnnotations(annotations: unknown): string | null {
  const candidate = asRecord(annotations);
  if (!candidate) return null;

  const parts: string[] = [];
  const audience = candidate.audience;
  if (Array.isArray(audience) && audience.length > 0) {
    parts.push(`audience=${audience.join(", ")}`);
  }
  if (candidate.priority != null) {
    parts.push(`priority=${String(candidate.priority)}`);
  }
  if (candidate.lastModified != null) {
    parts.push(`lastModified=${String(candidate.lastModified)}`);
  }

  return parts.length > 0 ? parts.join("; ") : null;
}

function appendAnnotations(text: string, annotations: unknown): string {
  const formatted = formatAnnotations(annotations);
  if (!formatted) return text;
  return `${text}\nAnnotations: ${formatted}`;
}

function McpEmbeddedResourceBlock({
  block,
  textValue,
  textPreview,
}: BudgetedMcpContentBlock & {
  block: Extract<CodexMcpToolCallContentBlock, { type: "embedded_resource" }>;
}) {
  const resource = block.resource;
  const content = resource.text ?? resource.blob ?? "";
  const hasContent = content.length > 0;
  const annotations = formatAnnotations(resource.annotations);

  if (textValue && textPreview?.kind === "omitted") {
    return (
      <ToolCallCodePanel
        title="resource"
        preview={textPreview}
        getCopyText={() => textValue}
        getFullText={() => textValue}
        preClassName="text-token-description-foreground/80"
      />
    );
  }

  return (
    <div className="text-size-chat flex flex-col gap-0.5 text-token-description-foreground/80">
      <div className="flex gap-1">
        <span className="font-medium text-token-foreground">URI</span>
        <span className="break-all">{resource.uri}</span>
      </div>
      {resource.mimeType ? (
        <div className="flex gap-1">
          <span className="font-medium text-token-foreground">MIME type</span>
          <span className="break-all">{resource.mimeType}</span>
        </div>
      ) : null}
      {annotations ? (
        <div className="flex gap-1">
          <span className="font-medium text-token-foreground">Annotations</span>
          <span className="break-all">{annotations}</span>
        </div>
      ) : null}
      {hasContent ? (
        <ToolCallCodePanel
          title="Content"
          preview={buildTextPreview(content, INLINE_TEXT_PREVIEW_MAX_CHARS)}
          getCopyText={() => content}
          getFullText={() => content}
          preClassName="text-token-description-foreground/80"
        />
      ) : null}
    </div>
  );
}

function McpUnknownBlock({
  text,
  preview,
}: {
  readonly text: string;
  readonly preview: TextPreview;
}) {
  return (
    <ToolCallCodePanel
      title="json"
      preview={preview}
      getCopyText={() => text}
      getFullText={() => text}
      preClassName="[&_*]:text-token-non-assistant-body-descendant text-token-description-foreground/80 text-size-chat"
    />
  );
}

function McpContentBlock({ block, textValue, textPreview }: BudgetedMcpContentBlock) {
  if (block.type === "text") {
    const value = textValue ?? appendAnnotations(block.text, block.annotations);
    return (
      <ToolCallCodePanel
        title="plaintext"
        preview={textPreview ?? buildTextPreview(value, INLINE_TEXT_PREVIEW_MAX_CHARS)}
        getCopyText={() => value}
        getFullText={() => value}
        preClassName="[&_*]:text-token-non-assistant-body-descendant text-token-description-foreground/80 m-0 whitespace-pre-wrap break-words font-sans text-size-chat leading-relaxed extension:leading-normal"
      />
    );
  }

  if (block.type === "resource_link") {
    const name = block.title ?? block.name ?? block.uri;
    const annotations = formatAnnotations(block.annotations);

    if (textValue && textPreview?.kind === "omitted") {
      return (
        <ToolCallCodePanel
          title="resource"
          preview={textPreview}
          getCopyText={() => textValue}
          getFullText={() => textValue}
          preClassName="text-token-description-foreground/80"
        />
      );
    }

    return (
      <div className="text-size-chat flex flex-col gap-0.5">
        <div className="break-words text-token-description-foreground/80">Read {name}</div>
        {annotations ? (
          <div className="break-words whitespace-pre-wrap text-token-description-foreground/80">
            Annotations: {annotations}
          </div>
        ) : null}
      </div>
    );
  }

  if (block.type === "embedded_resource") {
    return (
      <McpEmbeddedResourceBlock block={block} textValue={textValue} textPreview={textPreview} />
    );
  }

  if (block.type === "image") {
    const annotations = formatAnnotations(block.annotations);

    return (
      <div className="flex flex-col gap-0.5">
        <img
          className="max-h-48 w-max max-w-full gap-0.5 rounded-md object-contain"
          src={`data:${block.mimeType};base64,${block.data}`}
          alt=""
        />
        {textValue && textPreview?.kind === "omitted" ? (
          <ToolCallCodePanel
            title="annotations"
            preview={textPreview}
            getCopyText={() => textValue}
            getFullText={() => textValue}
          />
        ) : annotations ? (
          <p className="text-size-chat whitespace-pre-wrap text-token-description-foreground/80">
            Annotations: {annotations}
          </p>
        ) : null}
      </div>
    );
  }

  if (block.type === "audio") {
    const annotations = formatAnnotations(block.annotations);

    return (
      <div className="flex flex-col gap-0.5">
        <audio
          className="w-full gap-0.5"
          controls
          src={`data:${block.mimeType};base64,${block.data}`}
          preload="metadata"
        />
        {textValue && textPreview?.kind === "omitted" ? (
          <ToolCallCodePanel
            title="annotations"
            preview={textPreview}
            getCopyText={() => textValue}
            getFullText={() => textValue}
          />
        ) : annotations ? (
          <p className="text-size-chat whitespace-pre-wrap text-token-description-foreground/80">
            Annotations: {annotations}
          </p>
        ) : null}
      </div>
    );
  }

  if (!textValue || !textPreview) return null;
  return <McpUnknownBlock text={textValue} preview={textPreview} />;
}

function McpAppLoadingPlaceholder({ resource }: { resource: McpRenderableResource | null }) {
  return (
    <LoadingPlaceholder
      role="status"
      aria-label="Loading MCP app"
      data-mcp-app-loading="true"
      className="w-full rounded-lg border border-token-border-light bg-token-input-background"
      style={{ height: resolveMcpAppFrameHeight(resource?.metadata) }}
    />
  );
}

function McpAppTooLargeError() {
  return (
    <ToolErrorDetail
      error="Failed to load MCP app: HTML exceeds the maximum supported size."
      showLabel={false}
      className="w-full"
    />
  );
}

function McpResultBody({
  payload,
  threadId,
  resourceUri,
  hasResourceScope,
  resource,
  resourceLoading,
  resourceError,
  mcpServerStatuses,
  rawDialogOpen,
  onRawDialogOpenChange,
  onOpenMcpAppSidePanel,
}: {
  payload: CodexMcpToolCallView;
  threadId: string;
  resourceUri: string | null;
  hasResourceScope: boolean;
  resource: McpRenderableResource | null;
  resourceLoading: boolean;
  resourceError: string | null;
  mcpServerStatuses: ProtocolListMcpServerStatusResponse;
  rawDialogOpen: boolean;
  onRawDialogOpenChange: (open: boolean) => void;
  onOpenMcpAppSidePanel?: ThreadStageActions["onOpenMcpAppSidePanel"];
}) {
  const result = payload.result;
  const successResult = result?.type === "success" ? result : null;
  const errorText = result?.type === "error" ? result.error : null;
  const structuredContentJson = useMemo(
    () =>
      successResult?.structuredContent != null
        ? stringifyMcpValue(successResult.structuredContent, 2)
        : null,
    [successResult],
  );
  const shouldRenderMcpApp = Boolean(resourceUri) && (!payload.completed || successResult !== null);
  const hasMcpAppBranch =
    shouldRenderMcpApp && (resourceLoading || Boolean(resourceError) || resource !== null);
  const isMcpAppLoading =
    shouldRenderMcpApp && resourceLoading && resource === null && !resourceError;
  const mcpAppError =
    shouldRenderMcpApp && resourceError && resource === null
      ? `Failed to load MCP app: ${resourceError}`
      : null;
  const { displayContent, displayStructuredContentJson } = useMemo(
    () =>
      successResult
        ? resolveMcpExpandedSuccessDisplay({
            content: successResult.content.filter(
              (block) => !shouldHideDuplicateMcpTextContent(block, resource),
            ),
            structuredContentJson,
            isExpanded: true,
          })
        : {
            displayContent: [],
            displayStructuredContentJson: null,
          },
    [resource, structuredContentJson, successResult],
  );
  const shouldShowStructuredContent = shouldShowMcpStructuredContent({
    structuredContentJson: displayStructuredContentJson,
    hasMcpAppBranch,
    hasResourceScope,
  });
  const shouldShowRawDialog = !isMcpAppLoading;
  const budgetedDisplayContent = useMemo(
    () => budgetMcpContentBlocks(displayContent),
    [displayContent],
  );
  const capabilityId = useMemo(
    () =>
      resource
        ? buildMcpAppCapabilityId({
            callId: payload.callId,
            resourceUri: resource.uri,
            server: payload.invocation.server,
            threadId,
            tool: payload.invocation.tool,
          })
        : null,
    [payload.callId, payload.invocation.server, payload.invocation.tool, resource, threadId],
  );
  const runtimeConfig = useMemo(
    () => ({
      currentToolName: payload.invocation.tool,
      server: payload.invocation.server,
      statuses: mcpServerStatuses,
      threadId,
      toolInput: payload.invocation.arguments,
      toolResult: successResult?.raw ?? null,
    }),
    [mcpServerStatuses, payload.invocation, successResult, threadId],
  );

  const appBody = isMcpAppLoading ? (
    <McpAppLoadingPlaceholder resource={resource} />
  ) : mcpAppError ? (
    <ToolErrorDetail error={mcpAppError} showLabel={false} />
  ) : resource && isMcpAppHtmlTooLarge(resource) ? (
    <McpAppTooLargeError />
  ) : resource && capabilityId ? (
    <McpCapabilityViewFrame
      capabilityId={capabilityId}
      resource={resource}
      runtimeConfig={runtimeConfig}
    />
  ) : null;

  return (
    <>
      {hasMcpAppBranch ? appBody : null}
      {!hasMcpAppBranch && displayContent.length > 0 ? (
        <div className="[&_*]:text-token-foreground/50 flex flex-col gap-0.5">
          {budgetedDisplayContent.blocks.map((entry, index) => (
            <McpContentBlock key={index} {...entry} />
          ))}
          {budgetedDisplayContent.omittedCharacters > 0 ? (
            <div className="px-2 py-1 text-xs text-token-description-foreground">
              {budgetedDisplayContent.omittedCharacters.toLocaleString()} additional text characters
              omitted
            </div>
          ) : null}
        </div>
      ) : !hasMcpAppBranch && errorText ? (
        <ToolErrorDetail error={errorText} showLabel={false} />
      ) : !hasMcpAppBranch && !displayStructuredContentJson ? (
        <p className="text-token-description-foreground/80">Tool returned no content</p>
      ) : null}
      {shouldShowStructuredContent && displayStructuredContentJson ? (
        <ToolCallCodePanel
          title="json"
          preview={buildTextPreview(displayStructuredContentJson, INLINE_TEXT_PREVIEW_MAX_CHARS)}
          getCopyText={() => displayStructuredContentJson}
          getFullText={() => displayStructuredContentJson}
          preClassName="font-vscode-editor text-size-chat text-token-description-foreground/80"
        />
      ) : null}
      {shouldShowRawDialog ? (
        <div className="inline-flex w-fit items-center gap-1">
          {resource && onOpenMcpAppSidePanel ? (
            <NodexTooltip tooltipContent="Open app in side panel" side="top" delay={0}>
              <button
                type="button"
                className={cn(
                  "border-token-border user-select-none no-drag cursor-interaction flex items-center gap-1 border focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-full electron:rounded-md text-token-description-foreground enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border-transparent electron:p-1 justify-center p-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100",
                  electronToolIconSizeClassName,
                )}
                aria-label="Open MCP app in side panel"
                onClick={() => {
                  void onOpenMcpAppSidePanel(
                    buildMcpAppSidePanelInput({ threadId, payload, resource }),
                  );
                }}
              >
                <PanelRightVisibleIcon />
              </button>
            </NodexTooltip>
          ) : null}
          <ToolCallRawDialog
            open={rawDialogOpen}
            onOpenChange={onRawDialogOpenChange}
            title={`Raw ${payload.invocation.server}.${payload.invocation.tool} tool call output`}
            getRawValue={() => ({
              callId: payload.callId,
              invocation: payload.invocation,
              durationMs: payload.durationMs,
              result: payload.result,
            })}
            triggerLabel="Show raw tool call output"
          />
        </div>
      ) : null}
    </>
  );
}

function useControllableBoolean(
  value: boolean | undefined,
  onChange: ((nextValue: boolean) => void) | undefined,
): [boolean, (nextValue: boolean) => void] {
  const [internalValue, setInternalValue] = useState(Boolean(value));

  useEffect(() => {
    if (value === undefined) return;
    setInternalValue(value);
  }, [value]);

  const resolvedValue = value ?? internalValue;

  return [
    resolvedValue,
    (nextValue) => {
      if (value === undefined) {
        setInternalValue(nextValue);
      }
      onChange?.(nextValue);
    },
  ];
}

export function McpToolCall({
  automaticApprovalReviews = EMPTY_AUTOMATIC_APPROVAL_REVIEWS,
  item,
  rawDialogOpen,
  onRawDialogOpenChange,
  onOpenMcpAppSidePanel,
}: McpToolCallProps) {
  const bodyId = useId();
  const payload = item.mcpToolCall ?? null;
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRawDialogOpen, setIsRawDialogOpen] = useControllableBoolean(
    rawDialogOpen,
    onRawDialogOpenChange,
  );
  const { elementHeightPx, elementRef } = useMeasuredElementHeight();
  const hasSuccessfulResult = payload?.result?.type === "success";
  const mcpApps = useThreadMcpApps();
  const { data: statusData } = useMcpServerStatuses({
    enabled: Boolean(payload && hasSuccessfulResult),
  });
  const mcpServerStatuses = statusData ?? EMPTY_MCP_SERVER_STATUSES;

  const resourceUri = useMemo(
    () => (payload ? resolveMcpAppResourceUri({ payload, mcpServerStatuses }) : null),
    [payload, mcpServerStatuses],
  );
  const resourceScopeUri = useMemo(
    () => (payload ? resolveMcpAppResourceScopeUri({ payload, mcpServerStatuses }) : null),
    [payload, mcpServerStatuses],
  );
  const resourceParams = useMemo(
    () =>
      payload && resourceUri
        ? {
            threadId: item.threadId,
            originCallId: payload.callId,
            server: payload.invocation.server,
            uri: resourceUri,
          }
        : null,
    [item.threadId, payload, resourceUri],
  );
  const {
    data: resourceResponse = null,
    error: resourceQueryError,
    isLoading: resourceLoading,
  } = useMcpResource(resourceParams);
  const resourceError = resourceQueryError
    ? resourceQueryError instanceof Error
      ? resourceQueryError.message
      : String(resourceQueryError)
    : null;
  const renderableResource = useMemo(
    () => (resourceUri ? resolveMcpRenderableResource(resourceUri, resourceResponse) : null),
    [resourceResponse, resourceUri],
  );
  const isMcpAppReviewCardMode = Boolean(
    resourceUri &&
    (!payload?.completed || hasSuccessfulResult) &&
    (resourceLoading || resourceError || renderableResource),
  );
  const summary = payload
    ? resolveMcpToolActivityLabel({
        payload,
        resolvedApps: mcpApps,
        completed: payload.completed,
      })
    : "";
  const hasApprovalReviews = automaticApprovalReviews.length > 0;

  if (!payload) return null;

  const canExpand = payload.completed || payload.result !== null;
  const isBodyExpanded = canExpand && isExpanded;
  const header = (
    <ThreadActivityHeader
      accessory={hasApprovalReviews ? <AutomaticApprovalReviewShield /> : null}
      disclosure={
        canExpand
          ? {
              expanded: isBodyExpanded,
              onToggle: () => {
                setIsExpanded((current) => !current);
              },
            }
          : undefined
      }
    >
      <ToolActivityIcon descriptor={resolveMcpSourceIcon(item, mcpApps)} />
      <CodexShimmerText
        active={!payload.completed}
        className="text-token-conversation-summary-leading group-hover/activity-header:text-token-foreground text-size-chat min-w-0 shrink truncate"
      >
        {summary}
      </CodexShimmerText>
    </ThreadActivityHeader>
  );
  const body = canExpand ? (
    <motion.div
      initial={false}
      animate={{
        height: isBodyExpanded ? elementHeightPx : 0,
        opacity: isBodyExpanded ? 1 : 0,
      }}
      transition={CODEX_THREAD_ACCORDION_TRANSITION}
      className={cn(isBodyExpanded ? "overflow-visible" : "overflow-hidden")}
      data-thread-find-skip={isBodyExpanded ? undefined : true}
      style={{
        pointerEvents: isBodyExpanded ? "auto" : "none",
      }}
    >
      <div ref={isBodyExpanded ? elementRef : null} className="flex flex-col gap-0.5 pt-1">
        {isBodyExpanded ? (
          <>
            {hasApprovalReviews ? (
              <AutomaticApprovalReviewRows
                className={isMcpAppReviewCardMode ? "px-4" : undefined}
                isExpandable={!isMcpAppReviewCardMode}
                items={automaticApprovalReviews}
              />
            ) : null}
            <div id={bodyId}>
              <McpResultBody
                payload={payload}
                threadId={item.threadId}
                resourceUri={resourceUri}
                hasResourceScope={resourceScopeUri !== null}
                resource={renderableResource}
                resourceLoading={resourceLoading}
                resourceError={resourceError}
                mcpServerStatuses={mcpServerStatuses}
                rawDialogOpen={isRawDialogOpen}
                onRawDialogOpenChange={setIsRawDialogOpen}
                onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
              />
            </div>
          </>
        ) : null}
      </div>
    </motion.div>
  ) : null;

  return <ThreadActivityShell body={body} className="group" header={header} />;
}
