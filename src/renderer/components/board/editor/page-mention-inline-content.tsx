import { useIntl } from "@/lib/i18n";
import { createReactInlineContentSpec } from "@blocknote/react";
import type { ReactNode } from "react";

import { MentionInlineFocusAffordance } from "../mention-inline-focus-affordance";
import { PageMentionInlineVisual } from "../page-mention-inline-visual";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  PageReferenceTooltipBody,
  resolvePageReferencePresentation,
  shortPageId,
} from "@/components/nodex-reference/page-reference-presentation";
import { usePageTargetReadModel } from "@/lib/block-reference-queries";
import { usePageStatusGlyph } from "../use-page-status-glyph";
import { buildPageDeepLink } from "@/lib/page-deeplink";
import { libraryContentRoute } from "../../../../shared/content-routing-context";
import { pageMentionInlineContentConfig } from "../../../../shared/block-documents/blocknote-schema-config";
import { useBlockReferenceHostRuntime } from "../../block-documents/block-reference-runtime-context";
import { useNodexReferenceInteraction } from "@/components/nodex-reference/nodex-reference";
import { useEditorReferenceSource } from "@/components/nodex-reference/editor-reference-source";

export interface PageMentionProps {
  readonly targetPageId: string;
}

export const normalizePageMentionProps = (
  input: Partial<PageMentionProps> | undefined,
): PageMentionProps => ({
  targetPageId: typeof input?.targetPageId === "string" ? input.targetPageId.trim() : "",
});

export function PageMentionInlineContentView({
  inlineContent,
}: {
  readonly inlineContent: { readonly props: Partial<PageMentionProps> };
}) {
  const intl = useIntl();
  const host = useBlockReferenceHostRuntime();
  const props = normalizePageMentionProps(inlineContent.props);
  const routingContext = host?.contentRoutingContext ?? libraryContentRoute;
  const target = usePageTargetReadModel(routingContext, host ? props.targetPageId : "");
  const model = target.data;
  const availablePage = model?.status === "available" ? model.page : null;
  const available = availablePage !== null;
  const icon = usePageStatusGlyph(routingContext, availablePage);
  const presentation = resolvePageReferencePresentation(
    {
      targetPageId: props.targetPageId,
      target: model,
      loading: target.loading,
      error: target.error,
    },
    intl,
  );
  const editorSource = useEditorReferenceSource();
  const reference = useNodexReferenceInteraction({
    destination: { kind: "page", pageId: props.targetPageId },
    openable: available,
    ...(availablePage ? { title: availablePage.title } : {}),
    source: editorSource,
    contextMenu: false,
  });
  const canOpen = reference.interactive;
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
      aria-label={intl.formatMessage(
        {
          id: "editor.pageMentionInlineContent.openNamedPage",
          defaultMessage: "Open Page {title}",
        },
        { title: presentation.label },
      )}
      onClick={reference.handlers.onClick}
      onDoubleClick={reference.handlers.onDoubleClick}
      onMouseDown={reference.handlers.onMouseDown}
      onAuxClick={reference.handlers.onAuxClick}
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
      tooltipContent={<PageReferenceTooltipBody presentation={presentation} />}
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
    <MentionInlineFocusAffordance
      label={intl.formatMessage({
        id: "editor.pageMentionInlineContent.openPage",
        defaultMessage: "Open page",
      })}
    >
      {mentionSurface}
    </MentionInlineFocusAffordance>
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
