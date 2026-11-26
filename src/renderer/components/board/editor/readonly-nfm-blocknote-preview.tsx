import { en, zh } from "@blocknote/core/locales";
import { useAppLocale, useIntl, type MessageDescriptor } from "@/lib/i18n";
import {
  libraryContentRoute,
  projectContentRoute,
} from "../../../../shared/content-routing-context";
import { containsSkillMention } from "../../../../shared/rich-text/skill-mention";
import {
  createSkillMentionInlineContentSpec,
  PageSkillMentionProvider,
} from "./skill-mention-chip";
import { useNodexReferenceRouter } from "@/lib/nodex-reference-router";
import { useEditorReferenceSource } from "@/components/nodex-reference/editor-reference-source";
import { markdownBlocksForEditor } from "../../../../shared/nodex-markdown/blocknote";
import { inlineImageInlineContentSpec } from "./inline-image-inline-content";
import { nfmTableLayoutExtension } from "./nfm-table-layout-extension";
import { BoardIcon, PageIcon } from "@/components/shared/icons";
import {
  useCallback,
  useMemo,
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from "@blocknote/core";
import type { PartialBlock } from "@blocknote/core";
import { createReactInlineMathSpec, createReactMathBlockSpec } from "@blocknote/math-block";
import {
  createReactBlockSpec,
  createReactInlineContentSpec,
  useCreateBlockNote,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { BoxSelect, Link2, Rows3 } from "@/components/shared/icons/generic-icons";
import { NodexLogoMarkIcon, RefreshIcon } from "@/components/shared/icons";

import { cn } from "@/lib/utils";
import { nfmSyntaxHighlighter } from "@/lib/syntax-highlighting";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  inlineTintedChipIconClassName,
  inlineTintedChipLabelClassName,
  inlineTintedChipVariants,
} from "@/components/ui/inline-tinted-chip";
import { readMarkdown, type MarkdownBlock } from "../../../../shared/nodex-markdown";
import { resolveLocalImageDisplayUrl } from "@/lib/assets";
import { resolveAgentConfigChip, type AgentConfigProps } from "./agent-config-chip";
import type { FileReadAuthority, FilePreviewAuthority } from "@/lib/library-file-resources";
import { parseFileSource } from "../../../../shared/file-resources";
import { FileReadBoundary, useFilePlacementRuntime } from "./file-runtime";
import { AttachmentInlineContent, type AttachmentProps } from "./attachment-chip";
import { createReadonlyDateMentionInlineContentSpec } from "./date-mention-inline-content-spec";
import { createReadonlyPageMentionInlineContentSpec } from "./page-mention-inline-content";
import { resolveThreadMentionDisplay } from "@/lib/editor-model/thread-mention-display";
import { createCalloutBlock } from "./callout-block";
import { createPromptBlockSpec } from "./prompt-block";
import { editorCodeBlockOptions } from "./code-block-options";
import { BLOCK_SELECTION_PRESENTATION_ATTRIBUTE } from "./selected-block-decorations";
import { createNfmCodeBlockSpec } from "./nfm-code-block-spec";
import { imageBlockSpec } from "./image-block";
import { openNfmResolvedLinkAction, resolveNfmLinkAction } from "@/lib/nfm-link-actions";
import { useFileReferenceIntent } from "@/lib/file-reference-intent";
import { isEligibleMarkdownLinkContext, snapshotLinkActivation } from "@/lib/link-activation";
import { useLinkOpening, useWebLinkNavigation } from "@/lib/web-link-navigation";
import { openWebLinkContextMenu } from "@/lib/web-link-context-menu";
import { useFileReferenceRouter } from "@/lib/file-reference-router";
import { openFileReferenceContextMenu } from "@/components/shared/file-link-anchor";
import { useTheme } from "@/lib/use-theme";
import { readNfmLinkHrefAtElement } from "./nfm-link-element";
import { ThreadMentionInlineVisual } from "../thread-mention-inline-visual";
import { useBlockReferenceHostRuntime } from "../../block-documents/block-reference-runtime-context";
import {
  agentConfigInlineContentConfig,
  attachmentInlineContentConfig,
  databaseBlockConfig,
  canvasBlockConfig,
  pageBlockConfig,
  pageRefBlockConfig,
  databaseViewRefBlockConfig,
  syncedBlockRefBlockConfig,
  reusableTemplateRefBlockConfig,
  mathBlockConfig,
  mathInlineContentConfig,
  threadMentionInlineContentConfig,
} from "../../../../shared/block-documents/blocknote-schema-config";
import { BLOCK_CHILDREN_RULES } from "../../../../shared/block-documents/block-children-policy";

/** Nothing can be selected here, so an atom first Block must not wear the selection halo. */
const READONLY_SELECTION_PRESENTATION = { [BLOCK_SELECTION_PRESENTATION_ATTRIBUTE]: "" };

interface ReadonlyMarkdownBlockNotePreviewProps {
  fileAuthority?: FileReadAuthority | FilePreviewAuthority | null;
  /** Markdown, or Blocks already read from it. Keep Blocks stable between renders. */
  content: string | readonly MarkdownBlock[];
  projectId: string | null;
  pageId: string;
  historyId?: number | string | null;
  projectWorkspacePath?: string | null;
  className?: string;
}

interface ReadonlyPreviewDocument {
  initialContent: PartialBlock[] | undefined;
}

interface PreviewThreadMentionProps {
  uuid: string;
}

interface InertEmbedPlaceholderProps {
  icon: ComponentType<{ className?: string }>;
  label: MessageDescriptor;
  detail?: string;
  detailFallback?: MessageDescriptor;
}

function InertEmbedPlaceholder({
  icon: Icon,
  label,
  detail,
  detailFallback,
}: InertEmbedPlaceholderProps) {
  const intl = useIntl();
  const displayDetail = detail ?? (detailFallback && intl.formatMessage(detailFallback));
  return (
    <div
      contentEditable={false}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-token-foreground/5 px-2 py-1 text-xs text-token-text-secondary"
    >
      <Icon className="icon-2xs shrink-0 text-token-description-foreground" />
      <span className="shrink-0 font-medium text-token-text-secondary">
        {intl.formatMessage(label)}
      </span>
      {displayDetail ? (
        <span className="min-w-0 truncate text-token-description-foreground">{displayDetail}</span>
      ) : null}
    </div>
  );
}

const createReadonlyPageRefBlockSpec = createReactBlockSpec(pageRefBlockConfig, {
  render: ({ block }) => {
    const targetBlockId = String(block.props.targetBlockId || "").trim();
    return (
      <InertEmbedPlaceholder
        icon={Link2}
        label={{
          id: "editor.readonlyNfmBlocknotePreview.pageReference",
          defaultMessage: "Page reference",
        }}
        detail={targetBlockId}
      />
    );
  },
});

const createReadonlyPageBlockSpec = createReactBlockSpec(pageBlockConfig, {
  render: () => (
    <InertEmbedPlaceholder
      icon={PageIcon}
      label={{
        id: "editor.readonlyNfmBlocknotePreview.page",
        defaultMessage: "Page",
      }}
      detailFallback={{
        id: "editor.readonlyNfmBlocknotePreview.untitled",
        defaultMessage: "Untitled",
      }}
    />
  ),
});

const createReadonlyDatabaseViewRefBlockSpec = createReactBlockSpec(databaseViewRefBlockConfig, {
  render: ({ block }) => (
    <InertEmbedPlaceholder
      icon={Rows3}
      label={{
        id: "editor.readonlyNfmBlocknotePreview.databaseView",
        defaultMessage: "Database view",
      }}
      detail={String(block.props.displayHint || block.props.databaseViewId || "").trim()}
    />
  ),
});

const createReadonlyDatabaseBlockSpec = createReactBlockSpec(databaseBlockConfig, {
  render: ({ block }) => (
    <InertEmbedPlaceholder
      icon={BoardIcon}
      label={{
        id: "editor.readonlyNfmBlocknotePreview.database",
        defaultMessage: "Database",
      }}
      detail={block.id}
    />
  ),
});

const createReadonlyCanvasBlockSpec = createReactBlockSpec(canvasBlockConfig, {
  render: ({ block }) => (
    <InertEmbedPlaceholder
      icon={BoxSelect}
      label={{
        id: "editor.readonlyNfmBlocknotePreview.canvas",
        defaultMessage: "Canvas",
      }}
      detail={block.id}
    />
  ),
  meta: {
    isolating: true,
  },
});

const createReadonlySyncedBlockRefBlockSpec = createReactBlockSpec(syncedBlockRefBlockConfig, {
  render: ({ block }) => (
    <InertEmbedPlaceholder
      icon={RefreshIcon}
      label={{
        id: "editor.readonlyNfmBlocknotePreview.syncedBlock",
        defaultMessage: "Synced block",
      }}
      detail={String(block.props.sourceBlockId || "").trim()}
    />
  ),
});

const createReadonlyTemplateRefBlockSpec = createReactBlockSpec(reusableTemplateRefBlockConfig, {
  render: ({ block }) => (
    <InertEmbedPlaceholder
      icon={PageIcon}
      label={{
        id: "editor.readonlyNfmBlocknotePreview.template",
        defaultMessage: "Template",
      }}
      detail={block.props.displayHint ? String(block.props.displayHint).trim() : undefined}
      detailFallback={{
        id: "editor.readonlyNfmBlocknotePreview.reusableContent",
        defaultMessage: "Reusable content",
      }}
    />
  ),
});

const createReadonlyAttachmentInlineContentSpec = () =>
  createReactInlineContentSpec(attachmentInlineContentConfig, {
    render: ({ inlineContent }) => (
      <AttachmentInlineContent inlineContent={inlineContent as { props: AttachmentProps }} />
    ),
  });

const createReadonlyAgentConfigInlineContentSpec = () =>
  createReactInlineContentSpec(agentConfigInlineContentConfig, {
    render: ({ inlineContent }) => {
      const chip = resolveAgentConfigChip(inlineContent.props as Partial<AgentConfigProps>);
      return (
        <NodexTooltip tooltipContent={[chip.label, chip.detail].filter(Boolean).join(" - ")}>
          <span
            contentEditable={false}
            className={inlineTintedChipVariants({
              tone: "neutral",
            })}
          >
            <NodexLogoMarkIcon className={inlineTintedChipIconClassName} monochrome />
            <span className={cn(inlineTintedChipLabelClassName, "truncate")}>{chip.label}</span>
            {chip.summary ? (
              <span className={cn(inlineTintedChipLabelClassName, "ml-1 truncate opacity-70")}>
                {chip.summary}
              </span>
            ) : null}
          </span>
        </NodexTooltip>
      );
    },
  });

const createReadonlyThreadMentionInlineContentSpec = () =>
  createReactInlineContentSpec(threadMentionInlineContentConfig, {
    render: function ReadonlyThreadMentionView({ inlineContent }) {
      const props = inlineContent.props as PreviewThreadMentionProps;
      const intl = useIntl();
      const mention = resolveThreadMentionDisplay({ uuid: props.uuid });
      return (
        <ThreadMentionInlineVisual
          contentEditable={false}
          title={props.uuid}
          label={
            mention.label ||
            intl.formatMessage({
              id: "editor.readonlyNfmBlocknotePreview.thread",
              defaultMessage: "Thread",
            })
          }
        />
      );
    },
  });

export const readonlyMarkdownBlockNotePreviewSchema = BlockNoteSchema.create({
  blockChildrenRules: BLOCK_CHILDREN_RULES,
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    heading: defaultBlockSpecs.heading,
    bulletListItem: defaultBlockSpecs.bulletListItem,
    numberedListItem: defaultBlockSpecs.numberedListItem,
    checkListItem: defaultBlockSpecs.checkListItem,
    toggleListItem: defaultBlockSpecs.toggleListItem,
    codeBlock: createNfmCodeBlockSpec({
      ...editorCodeBlockOptions,
      presentation: "readonly",
    }),
    table: defaultBlockSpecs.table,
    quote: defaultBlockSpecs.quote,
    divider: defaultBlockSpecs.divider,
    image: imageBlockSpec(),
    callout: createCalloutBlock(),
    prompt: createPromptBlockSpec(),
    page: createReadonlyPageBlockSpec(),
    database: createReadonlyDatabaseBlockSpec(),
    canvas: createReadonlyCanvasBlockSpec(),
    pageRef: createReadonlyPageRefBlockSpec(),
    databaseViewRef: createReadonlyDatabaseViewRefBlockSpec(),
    syncedBlockRef: createReadonlySyncedBlockRefBlockSpec(),
    templateRef: createReadonlyTemplateRefBlockSpec(),
    mathBlock: createReactMathBlockSpec(mathBlockConfig),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    inlineImage: inlineImageInlineContentSpec,
    attachment: createReadonlyAttachmentInlineContentSpec(),
    agentConfig: createReadonlyAgentConfigInlineContentSpec(),
    skillMention: createSkillMentionInlineContentSpec(),
    dateMention: createReadonlyDateMentionInlineContentSpec(),
    pageMention: createReadonlyPageMentionInlineContentSpec(),
    threadMention: createReadonlyThreadMentionInlineContentSpec(),
    math: createReactInlineMathSpec(mathInlineContentConfig),
  },
  styleSpecs: defaultStyleSpecs,
});

export function createReadonlyNfmPreviewDocument(
  content: string | readonly MarkdownBlock[],
): ReadonlyPreviewDocument {
  if (typeof content === "string" && !content.trim()) {
    return {
      initialContent: undefined,
    };
  }

  const blocks = typeof content === "string" ? readMarkdown(content) : content;
  const initialContent = markdownBlocksForEditor(blocks) as PartialBlock[];

  return {
    initialContent: initialContent.length > 0 ? initialContent : undefined,
  };
}

export function ReadonlyMarkdownBlockNotePreview(props: ReadonlyMarkdownBlockNotePreviewProps) {
  return (
    <FileReadBoundary authority={props.fileAuthority}>
      <ReadonlyNfmPreviewContent {...props} />
    </FileReadBoundary>
  );
}

function ReadonlyNfmPreviewContent({
  content,
  projectId,
  pageId,
  historyId,
  projectWorkspacePath,
  className,
}: ReadonlyMarkdownBlockNotePreviewProps) {
  const locale = useAppLocale();
  const fileRuntime = useFilePlacementRuntime();
  const fileReferenceRouter = useFileReferenceRouter();
  const referenceRouter = useNodexReferenceRouter();
  const editorSource = useEditorReferenceSource();
  const linkOpening = useLinkOpening();
  const webNavigation = useWebLinkNavigation();
  const linkIntent = useFileReferenceIntent();
  const hostRuntime = useBlockReferenceHostRuntime();
  const { resolved: themeMode } = useTheme();
  const previewDocument = useMemo(() => createReadonlyNfmPreviewDocument(content), [content]);

  const editor = useCreateBlockNote(
    {
      schema: readonlyMarkdownBlockNotePreviewSchema,
      dictionary: locale === "zh-CN" ? zh : en,
      extensions: [nfmSyntaxHighlighter, nfmTableLayoutExtension],
      initialContent: previewDocument.initialContent,
      resolveFileUrl: async (source) => {
        if (parseFileSource(source)) {
          if (!fileRuntime) throw new Error("File preview authority is unavailable");
          return fileRuntime.readImageDataUrl(source);
        }
        const displayUrl = resolveLocalImageDisplayUrl(source);
        if (!displayUrl) throw new Error("Managed image path is unavailable");
        return displayUrl;
      },
      tables: {
        headers: true,
        cellBackgroundColor: true,
        cellTextColor: false,
        splitCells: false,
      },
    },
    [projectId, pageId, historyId, content, fileRuntime, locale],
  );

  const openLocalReference = useCallback(
    (
      action: Extract<
        ReturnType<typeof resolveNfmLinkAction>,
        {
          kind: "local-file" | "workspace-file";
        }
      >,
      options?: Parameters<typeof fileReferenceRouter.open>[1],
    ) => {
      void fileReferenceRouter.open(action.target, {
        cwd: projectWorkspacePath,
        workspaceRoot: projectWorkspacePath,
        sidePanel: linkIntent.sidePanel,
        ...options,
      });
    },
    [fileReferenceRouter, projectWorkspacePath, linkIntent.sidePanel],
  );

  const findAnchorAction = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return null;

      const anchor = target.closest("a");
      if (!(anchor instanceof HTMLAnchorElement)) return null;
      if (!event.currentTarget.contains(anchor)) return null;

      return {
        action: resolveNfmLinkAction(
          readNfmLinkHrefAtElement(editor, anchor),
          projectWorkspacePath,
        ),
        anchor,
      };
    },
    [editor, projectWorkspacePath],
  );

  const handleClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const resolved = findAnchorAction(event);
      if (!resolved?.action) return;

      event.preventDefault();
      event.stopPropagation();

      if (resolved.action.kind === "local-file" || resolved.action.kind === "workspace-file") {
        openLocalReference(resolved.action, {
          activation: snapshotLinkActivation(event),
          mode: "preview",
        });
        return;
      }
      void openNfmResolvedLinkAction(
        resolved.action,
        undefined,
        undefined,
        undefined,
        {
          router: referenceRouter,
          source: editorSource,
          gesture: { kind: "activate", activation: snapshotLinkActivation(event) },
        },
        {
          openLink: linkOpening?.openLink,
          hostId: fileReferenceRouter.hostId,
          activation: snapshotLinkActivation(event),
          markdownContext:
            linkIntent.markdownContext &&
            isEligibleMarkdownLinkContext(resolved.anchor, snapshotLinkActivation(event)),
        },
      );
    },
    [
      findAnchorAction,
      referenceRouter,
      editorSource,
      openLocalReference,
      linkOpening,
      fileReferenceRouter.hostId,
      linkIntent.markdownContext,
    ],
  );

  const handleDoubleClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const resolved = findAnchorAction(event);
      if (!resolved?.action) return;
      if (resolved.action.kind !== "local-file" && resolved.action.kind !== "workspace-file")
        return;

      event.preventDefault();
      event.stopPropagation();
      openLocalReference(resolved.action, { mode: "durable" });
    },
    [findAnchorAction, openLocalReference],
  );

  const handleAuxClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 1) return;
      const resolved = findAnchorAction(event);
      if (!resolved?.action) return;
      event.preventDefault();
      event.stopPropagation();
      if (resolved.action.kind === "local-file" || resolved.action.kind === "workspace-file") {
        openLocalReference(resolved.action, { activation: snapshotLinkActivation(event) });
        return;
      }
      const activation = snapshotLinkActivation(event);
      void openNfmResolvedLinkAction(
        resolved.action,
        undefined,
        undefined,
        undefined,
        {
          router: referenceRouter,
          source: editorSource,
          gesture: { kind: "activate", activation },
        },
        {
          openLink: linkOpening?.openLink,
          hostId: fileReferenceRouter.hostId,
          activation,
        },
      );
    },
    [
      findAnchorAction,
      openLocalReference,
      referenceRouter,
      editorSource,
      linkOpening,
      fileReferenceRouter.hostId,
    ],
  );

  const handleContextMenuCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const resolved = findAnchorAction(event);
      if (!resolved?.action) return;
      if (resolved.action.kind === "web-url") {
        event.preventDefault();
        event.stopPropagation();
        const anchor = resolved.anchor;
        void openWebLinkContextMenu({
          url: resolved.action.url,
          navigation: webNavigation,
          x: event.clientX,
          y: event.clientY,
          selectedText: anchor.ownerDocument.getSelection()?.toString(),
          isCurrent: () => anchor.isConnected && !anchor.closest("[inert]"),
        }).catch(() => undefined);
        return;
      }
      if (resolved.action.kind !== "local-file" && resolved.action.kind !== "workspace-file")
        return;

      event.preventDefault();
      event.stopPropagation();
      const label = resolved.anchor.textContent?.trim() || resolved.action.target.path;
      void openFileReferenceContextMenu({
        target: resolved.action.target,
        label,
        sidePanel: linkIntent.sidePanel,
        browserAvailable: linkOpening?.browserAvailable,
        openLink: linkOpening?.openLink,
        open: (target, options) =>
          fileReferenceRouter.open(target, {
            cwd: projectWorkspacePath,
            workspaceRoot: projectWorkspacePath,
            title: label,
            ...options,
          }),
        x: event.clientX,
        y: event.clientY,
      }).catch(() => undefined);
    },
    [
      fileReferenceRouter,
      findAnchorAction,
      projectWorkspacePath,
      linkIntent.sidePanel,
      linkOpening,
      webNavigation,
    ],
  );

  const surface = (
    <div
      className={cn("nfm-editor readonly-nfm-blocknote-preview relative", className)}
      style={{ minHeight: 0 }}
      onClickCapture={handleClickCapture}
      onDoubleClickCapture={handleDoubleClickCapture}
      onAuxClickCapture={handleAuxClickCapture}
      onContextMenuCapture={handleContextMenuCapture}
      spellCheck={false}
      {...READONLY_SELECTION_PRESENTATION}
      data-testid="readonly-nfm-blocknote-preview"
      data-project-id={projectId}
      data-uuid-v7={pageId}
      data-history-id={historyId ?? undefined}
      data-project-workspace-path={projectWorkspacePath ?? undefined}
    >
      <BlockNoteView
        editor={editor}
        editable={false}
        theme={themeMode}
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        sideMenu={false}
        filePanel={false}
        tableHandles={false}
        emojiPicker={false}
        comments={false}
        data-theming-css-variables-demo
      />
    </div>
  );
  if (!pageId || !containsSkillMention(previewDocument.initialContent)) return surface;
  return (
    <PageSkillMentionProvider
      context={
        hostRuntime?.contentRoutingContext ??
        (projectId ? projectContentRoute(projectId) : libraryContentRoute)
      }
    >
      {surface}
    </PageSkillMentionProvider>
  );
}
