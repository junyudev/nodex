import { getIntl } from "@/lib/i18n";
import type { PageTargetReadModel } from "../../../shared/page-targets";

export const shortPageId = (pageId: string): string =>
  pageId.length <= 12 ? pageId : `${pageId.slice(0, 8)}…`;
const PAGE_MENTION_TOOLTIP_PREVIEW_LIMIT = 280;

export interface PageReferencePresentation {
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

export function resolvePageReferencePresentation(
  input: {
    readonly targetPageId: string;
    readonly target: PageTargetReadModel | null;
    readonly loading: boolean;
    readonly error: Error | null;
  },
  intl = getIntl(),
): PageReferencePresentation {
  const fallbackLabel = input.targetPageId
    ? intl.formatMessage(
        { id: "editor.pageMentionInlineContent.fallbackTitle", defaultMessage: "Page {id}" },
        { id: shortPageId(input.targetPageId) },
      )
    : intl.formatMessage({
        id: "editor.pageMentionInlineContent.unavailable",
        defaultMessage: "Unavailable Page",
      });

  if (input.target?.status === "available") {
    const title =
      input.target.page.title.trim() ||
      intl.formatMessage({
        id: "editor.pageMentionInlineContent.untitled",
        defaultMessage: "Untitled",
      });
    return {
      label: title,
      tooltipTitle: title,
      tooltipDetail:
        input.target.page.lifecycle === "archived"
          ? intl.formatMessage({
              id: "editor.pageMentionInlineContent.archived",
              defaultMessage: "Archived",
            })
          : null,
      tooltipPreview: boundedPagePreview(input.target.page.preview),
    };
  }

  if (input.loading) {
    return {
      label: intl.formatMessage({
        id: "editor.pageMentionInlineContent.loading",
        defaultMessage: "Loading Page…",
      }),
      tooltipTitle: intl.formatMessage({
        id: "editor.pageMentionInlineContent.loading",
        defaultMessage: "Loading Page…",
      }),
      tooltipDetail: intl.formatMessage({
        id: "editor.pageMentionInlineContent.resolving",
        defaultMessage: "Resolving Page details…",
      }),
      tooltipPreview: null,
    };
  }

  if (input.target?.status === "deleted") {
    return {
      label: fallbackLabel,
      tooltipTitle: intl.formatMessage({
        id: "editor.pageMentionInlineContent.deleted",
        defaultMessage: "Deleted Page",
      }),
      tooltipDetail: intl.formatMessage({
        id: "editor.pageMentionInlineContent.deletedDetail",
        defaultMessage: "This Page has been deleted.",
      }),
      tooltipPreview: null,
    };
  }

  if (input.target?.status === "invalid_target") {
    return {
      label: fallbackLabel,
      tooltipTitle: intl.formatMessage({
        id: "editor.pageMentionInlineContent.unavailable",
        defaultMessage: "Unavailable Page",
      }),
      tooltipDetail: intl.formatMessage({
        id: "editor.pageMentionInlineContent.invalidTarget",
        defaultMessage: "This reference does not point to a Page.",
      }),
      tooltipPreview: null,
    };
  }

  return {
    label: fallbackLabel,
    tooltipTitle: intl.formatMessage({
      id: "editor.pageMentionInlineContent.unavailable",
      defaultMessage: "Unavailable Page",
    }),
    tooltipDetail:
      input.error || input.target?.status === "missing"
        ? intl.formatMessage({
            id: "editor.pageMentionInlineContent.unavailableHere",
            defaultMessage: "This Page is unavailable here.",
          })
        : intl.formatMessage({
            id: "editor.pageMentionInlineContent.unavailableDetail",
            defaultMessage: "Page details are unavailable in this surface.",
          }),
    tooltipPreview: null,
  };
}

export function PageReferenceTooltipBody({
  presentation,
}: {
  readonly presentation: PageReferencePresentation;
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
