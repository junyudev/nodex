import { createReactInlineContentSpec } from "@blocknote/react";
import type { ReactNode } from "react";

import { MentionInlineFocusAffordance } from "../mention-inline-focus-affordance";
import { PageMentionInlineVisual } from "../page-mention-inline-visual";
import { NodexTooltip } from "@/components/ui/tooltip";
import { usePageTargetReadModel } from "@/lib/block-reference-queries";
import { useContentPageDetail } from "@/lib/content-page-detail";
import { readPageDetailWorkflowStatus } from "@/lib/page-stage-properties";
import { StatusIcon } from "@/lib/status-presentation";
import type { PageTargetReadModel } from "../../../../shared/page-targets";
import { buildPageDeepLink } from "../../../../shared/nodex-deeplink";
import { libraryContentRoute } from "../../../../shared/content-routing-context";
import { pageMentionInlineContentConfig } from "../../../../shared/block-documents/blocknote-schema-config";
import { useBlockReferenceHostRuntime } from "../../block-documents/block-reference-runtime-context";

export interface PageMentionProps {
  readonly targetPageId: string;
}

export const normalizePageMentionProps = (
  input: Partial<PageMentionProps> | undefined,
): PageMentionProps => ({
  targetPageId: typeof input?.targetPageId === "string" ? input.targetPageId.trim() : "",
});

const shortPageId = (pageId: string): string =>
  pageId.length <= 12 ? pageId : `${pageId.slice(0, 8)}…`;
const PAGE_MENTION_TOOLTIP_PREVIEW_LIMIT = 280;

export interface PageMentionPresentation {
  readonly label: string;
  readonly tooltipTitle: string;
  readonly tooltipDetail: string | null;
  readonly tooltipPreview: string | null;
}

const boundedPagePreview = (value: string): string | null => {
  const preview = value.replace(/\s+/gu, " ").trim();
  if (!preview) return null;
  if (preview.length <= PAGE_MENTION_TOOLTIP_PREVIEW_LIMIT) return preview;
  return `${preview.slice(0, PAGE_MENTION_TOOLTIP_PREVIEW_LIMIT).trimEnd()}…`;
};

export function resolvePageMentionPresentation(input: {
  readonly targetPageId: string;
  readonly target: PageTargetReadModel | null;
  readonly loading: boolean;
  readonly error: Error | null;
}): PageMentionPresentation {
  const fallbackLabel = input.targetPageId
    ? `Page ${shortPageId(input.targetPageId)}`
    : "Unavailable Page";

  if (input.target?.status === "available") {
    const title = input.target.page.title.trim() || "Untitled";
    return {
      label: title,
      tooltipTitle: title,
      tooltipDetail: input.target.page.lifecycle === "archived" ? "Archived" : null,
      tooltipPreview: boundedPagePreview(input.target.page.preview),
    };
  }

  if (input.loading) {
    return {
      label: "Loading Page…",
      tooltipTitle: "Loading Page…",
      tooltipDetail: "Resolving Page details…",
      tooltipPreview: null,
    };
  }

  if (input.target?.status === "deleted") {
    return {
      label: fallbackLabel,
      tooltipTitle: "Deleted Page",
      tooltipDetail: "This Page has been deleted.",
      tooltipPreview: null,
    };
  }

  if (input.target?.status === "invalid_target") {
    return {
      label: fallbackLabel,
      tooltipTitle: "Unavailable Page",
      tooltipDetail: "This reference does not point to a Page.",
      tooltipPreview: null,
    };
  }

  return {
    label: fallbackLabel,
    tooltipTitle: "Unavailable Page",
    tooltipDetail:
      input.error || input.target?.status === "missing"
        ? "This Page is unavailable here."
        : "Page details are unavailable in this surface.",
    tooltipPreview: null,
  };
}

function PageMentionTooltipBody({
  presentation,
}: {
  readonly presentation: PageMentionPresentation;
}) {
  return (
    <div data-page-mention-tooltip="true" className="max-w-[20rem] space-y-0.5 text-left">
      <div className="truncate text-sm font-medium text-token-foreground">
        {presentation.tooltipTitle}
      </div>
      {presentation.tooltipDetail ? (
        <div className="truncate text-xs text-token-description-foreground">
          {presentation.tooltipDetail}
        </div>
      ) : null}
      {presentation.tooltipPreview ? (
        <div className="mt-1 line-clamp-3 text-xs/relaxed wrap-break-word text-token-description-foreground/90">
          {presentation.tooltipPreview}
        </div>
      ) : null}
    </div>
  );
}

export function PageMentionInlineContentView({
  inlineContent,
}: {
  readonly inlineContent: { readonly props: Partial<PageMentionProps> };
}) {
  const host = useBlockReferenceHostRuntime();
  const props = normalizePageMentionProps(inlineContent.props);
  const routingContext = host?.contentRoutingContext ?? libraryContentRoute;
  const target = usePageTargetReadModel(routingContext, host ? props.targetPageId : "");
  const model = target.data;
  const availablePage = model?.status === "available" ? model.page : null;
  const available = availablePage !== null;
  const detail = useContentPageDetail(
    availablePage?.libraryId ?? null,
    routingContext,
    availablePage?.pageId ?? null,
  );
  const workflowStatus = readPageDetailWorkflowStatus(detail.detail);
  const icon = workflowStatus ? (
    <StatusIcon statusId={workflowStatus} className="size-full" />
  ) : undefined;
  const presentation = resolvePageMentionPresentation({
    targetPageId: props.targetPageId,
    target: model,
    loading: target.loading,
    error: target.error,
  });
  const canOpen = Boolean(available && host?.openPage);
  const mention = canOpen ? (
    <PageMentionInlineVisual
      as="a"
      href={availablePage ? buildPageDeepLink({ pageId: availablePage.pageId }) : undefined}
      tabIndex={0}
      label={presentation.label}
      icon={icon}
      withGuards
      contentEditable={false}
      data-page-mention-inline-anchor="true"
      aria-label={`Open Page ${presentation.label}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!availablePage) return;
        void host?.openPage?.({
          routingContext,
          pageId: availablePage.pageId,
          titleSnapshot: availablePage.title,
        });
      }}
    />
  ) : (
    <PageMentionInlineVisual
      label={presentation.label}
      icon={icon}
      withGuards
      contentEditable={false}
      tabIndex={0}
      aria-label={presentation.tooltipTitle}
      className="text-token-description-foreground"
    />
  );
  const renderTooltip = (children: ReactNode) => (
    <NodexTooltip
      tooltipContent={<PageMentionTooltipBody presentation={presentation} />}
      side="top"
      align="start"
      sideOffset={4}
      delay={0}
      tooltipClassName="px-2 py-1.5"
    >
      {children}
    </NodexTooltip>
  );

  const mentionSurface = <span className="inline align-baseline">{renderTooltip(mention)}</span>;

  if (!canOpen) return mentionSurface;

  return (
    <MentionInlineFocusAffordance label="Open page">{mentionSurface}</MentionInlineFocusAffordance>
  );
}

export function createReadonlyPageMentionInlineContentSpec() {
  return createReactInlineContentSpec(pageMentionInlineContentConfig, {
    render: ({ inlineContent }) => (
      <PageMentionInlineContentView
        inlineContent={inlineContent as { props: Partial<PageMentionProps> }}
      />
    ),
  });
}

export function createPageMentionInlineContentSpec() {
  return createReactInlineContentSpec(pageMentionInlineContentConfig, {
    render: ({ inlineContent }) => (
      <PageMentionInlineContentView
        inlineContent={inlineContent as { props: Partial<PageMentionProps> }}
      />
    ),
    toExternalHTML: ({ inlineContent }) => {
      const props = normalizePageMentionProps(
        (inlineContent as { props: Partial<PageMentionProps> }).props,
      );
      return (
        <PageMentionInlineVisual
          label={
            props.targetPageId ? `Page ${shortPageId(props.targetPageId)}` : "Unavailable Page"
          }
          title={props.targetPageId ? buildPageDeepLink({ pageId: props.targetPageId }) : undefined}
        />
      );
    },
  });
}
