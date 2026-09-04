import { DatabaseIcon, PageIcon } from "@/components/shared/icons";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
import { parseNfm, nfmToBlockNote } from "@/lib/nfm";
import { resolveAssetSourceToDisplayUrl } from "@/lib/assets";
import { resolveAgentConfigChip, type AgentConfigProps } from "./agent-config-chip";
import type { FileReadAuthority, FilePreviewAuthority } from "@/lib/library-file-resources";
import { parseFileSource } from "../../../../shared/file-resources";
import { FileReadBoundary, useFilePlacementRuntime } from "./file-runtime";
import { AttachmentInlineContent } from "./attachment-chip";
import { formatAttachmentBytes } from "./attachment-chip-format";
import { AttachmentResourceIcon } from "../attachment-resource-icon";
import { createReadonlyDateMentionInlineContentSpec } from "./date-mention-inline-content-spec";
import { createReadonlyPageMentionInlineContentSpec } from "./page-mention-inline-content";
import { resolveThreadMentionDisplay } from "@/lib/nfm/thread-mention-display";
import { createCalloutBlock } from "./callout-block";
import { editorCodeBlockOptions } from "./code-block-options";
import { createNfmCodeBlockSpec } from "./nfm-code-block-spec";
import { imageBlockSpec } from "./image-block";
import { openNfmResolvedLinkAction, resolveNfmLinkAction } from "@/lib/nfm-link-actions";
import { useFileReferenceRouter } from "@/lib/file-reference-router";
import { openFileReferenceContextMenu } from "@/components/shared/file-link-anchor";
import { useTheme } from "@/lib/use-theme";
import { readNfmLinkHrefAtElement } from "./nfm-link-element";
import { ThreadMentionInlineVisual } from "../thread-mention-inline-visual";
import { InlineReferenceVisual } from "../inline-reference-visual";
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
  threadSectionBlockConfig,
} from "../../../../shared/block-documents/blocknote-schema-config";
import { BLOCK_CHILDREN_RULES } from "../../../../shared/block-documents/block-children-policy";

interface ReadonlyNfmBlockNotePreviewProps {
  fileAuthority?: FileReadAuthority | FilePreviewAuthority | null;
  content: string;
  projectId: string;
  pageId: string;
  historyId?: number | string | null;
  projectWorkspacePath?: string | null;
  className?: string;
}

interface ReadonlyPreviewDocument {
  initialContent: PartialBlock[] | undefined;
  toggleStates: Array<{ id: string; open: boolean }>;
}

interface PreviewAttachmentProps {
  kind: "text" | "file" | "folder";
  mode: "materialized" | "link";
  source: string;
  name: string;
  mimeType?: string;
  bytes?: number;
  origin?: string;
}

interface PreviewThreadMentionProps {
  uuid: string;
}

interface InertEmbedPlaceholderProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  detail?: string;
}

function InertEmbedPlaceholder({ icon: Icon, label, detail }: InertEmbedPlaceholderProps) {
  return (
    <div
      contentEditable={false}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-token-foreground/5 px-2 py-1 text-xs text-token-text-secondary"
    >
      <Icon className="icon-2xs shrink-0 text-token-description-foreground" />
      <span className="shrink-0 font-medium text-token-text-secondary">{label}</span>
      {detail ? (
        <span className="min-w-0 truncate text-token-description-foreground">{detail}</span>
      ) : null}
    </div>
  );
}

const createReadonlyPageRefBlockSpec = createReactBlockSpec(pageRefBlockConfig, {
  render: ({ block }) => {
    const targetBlockId = String(block.props.targetBlockId || "").trim();
    return <InertEmbedPlaceholder icon={Link2} label="Page reference" detail={targetBlockId} />;
  },
});

const createReadonlyPageBlockSpec = createReactBlockSpec(pageBlockConfig, {
  render: () => <InertEmbedPlaceholder icon={PageIcon} label="Page" detail="Untitled" />,
});

const createReadonlyDatabaseViewRefBlockSpec = createReactBlockSpec(databaseViewRefBlockConfig, {
  render: ({ block }) => (
    <InertEmbedPlaceholder
      icon={Rows3}
      label="Database view"
      detail={String(block.props.displayHint || block.props.databaseViewId || "").trim()}
    />
  ),
});

const createReadonlyDatabaseBlockSpec = createReactBlockSpec(databaseBlockConfig, {
  render: ({ block }) => (
    <InertEmbedPlaceholder icon={DatabaseIcon} label="Database" detail={block.id} />
  ),
});

const createReadonlyCanvasBlockSpec = createReactBlockSpec(canvasBlockConfig, {
  render: ({ block }) => (
    <InertEmbedPlaceholder icon={BoxSelect} label="Canvas" detail={block.id} />
  ),
  meta: {
    isolating: true,
  },
});

const createReadonlySyncedBlockRefBlockSpec = createReactBlockSpec(syncedBlockRefBlockConfig, {
  render: ({ block }) => (
    <InertEmbedPlaceholder
      icon={RefreshIcon}
      label="Synced block"
      detail={String(block.props.sourceBlockId || "").trim()}
    />
  ),
});

const createReadonlyTemplateRefBlockSpec = createReactBlockSpec(reusableTemplateRefBlockConfig, {
  render: ({ block }) => (
    <InertEmbedPlaceholder
      icon={PageIcon}
      label="Template"
      detail={String(block.props.displayHint || "Reusable content").trim()}
    />
  ),
});

const createReadonlyThreadSectionBlockSpec = createReactBlockSpec(threadSectionBlockConfig, {
  render: ({ block }) => {
    const label = String(block.props.label || "").trim();
    const threadId = String(block.props.threadId || "").trim();
    return (
      <InertEmbedPlaceholder
        icon={PageIcon}
        label="Thread section"
        detail={label || threadId || "Snapshot only"}
      />
    );
  },
});

function formatPreviewAttachmentLabel(props: PreviewAttachmentProps): string {
  const name = props.name.trim() || (props.kind === "text" ? "Pasted text" : "Attachment");
  const size =
    typeof props.bytes === "number" && props.kind !== "folder"
      ? formatAttachmentBytes(props.bytes)
      : "";
  const mode = props.mode === "link" ? "linked" : "saved";
  return [name, size, mode].filter(Boolean).join(" - ");
}

const createReadonlyAttachmentInlineContentSpec = () =>
  createReactInlineContentSpec(attachmentInlineContentConfig, {
    render: ({ inlineContent }) => {
      const props = inlineContent.props as PreviewAttachmentProps;
      if (parseFileSource(props.source))
        return <AttachmentInlineContent inlineContent={{ props }} />;
      return (
        <NodexTooltip tooltipContent={props.source}>
          <InlineReferenceVisual
            contentEditable={false}
            label={formatPreviewAttachmentLabel(props)}
            icon={
              <AttachmentResourceIcon
                kind={props.kind}
                name={props.name}
                mimeType={props.mimeType}
                className="size-full"
              />
            }
            trailing={props.mode === "link" ? <Link2 className="size-full" /> : undefined}
            data-attachment-inline-chip="true"
          />
        </NodexTooltip>
      );
    },
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
    render: ({ inlineContent }) => {
      const props = inlineContent.props as PreviewThreadMentionProps;
      const mention = resolveThreadMentionDisplay({ uuid: props.uuid });
      return (
        <ThreadMentionInlineVisual
          contentEditable={false}
          title={props.uuid}
          label={mention.label || "Thread"}
        />
      );
    },
  });

export const readonlyNfmBlockNotePreviewSchema = BlockNoteSchema.create({
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
    page: createReadonlyPageBlockSpec(),
    database: createReadonlyDatabaseBlockSpec(),
    canvas: createReadonlyCanvasBlockSpec(),
    pageRef: createReadonlyPageRefBlockSpec(),
    databaseViewRef: createReadonlyDatabaseViewRefBlockSpec(),
    syncedBlockRef: createReadonlySyncedBlockRefBlockSpec(),
    templateRef: createReadonlyTemplateRefBlockSpec(),
    threadSection: createReadonlyThreadSectionBlockSpec(),
    mathBlock: createReactMathBlockSpec(mathBlockConfig),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    attachment: createReadonlyAttachmentInlineContentSpec(),
    agentConfig: createReadonlyAgentConfigInlineContentSpec(),
    dateMention: createReadonlyDateMentionInlineContentSpec(),
    pageMention: createReadonlyPageMentionInlineContentSpec(),
    threadMention: createReadonlyThreadMentionInlineContentSpec(),
    math: createReactInlineMathSpec(mathInlineContentConfig),
  },
  styleSpecs: defaultStyleSpecs,
});

export function createReadonlyNfmPreviewDocument(content: string): ReadonlyPreviewDocument {
  if (!content.trim()) {
    return {
      initialContent: undefined,
      toggleStates: [],
    };
  }

  const toggleStates = new Map<string, boolean>();
  const blocks = parseNfm(content);
  const initialContent = nfmToBlockNote(blocks, toggleStates) as PartialBlock[];

  return {
    initialContent: initialContent.length > 0 ? initialContent : undefined,
    toggleStates: Array.from(toggleStates, ([id, open]) => ({ id, open })),
  };
}

function cleanupToggleStates(ids: string[]) {
  for (const id of ids) {
    localStorage.removeItem(`toggle-${id}`);
  }
}

function setToggleStates(toggleStates: ReadonlyPreviewDocument["toggleStates"]): string[] {
  const ids: string[] = [];
  for (const { id, open } of toggleStates) {
    localStorage.setItem(`toggle-${id}`, open ? "true" : "false");
    ids.push(id);
  }
  return ids;
}

export function ReadonlyNfmBlockNotePreview(props: ReadonlyNfmBlockNotePreviewProps) {
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
}: ReadonlyNfmBlockNotePreviewProps) {
  const fileRuntime = useFilePlacementRuntime();
  const fileReferenceRouter = useFileReferenceRouter();
  const hostRuntime = useBlockReferenceHostRuntime();
  const { resolved: themeMode } = useTheme();
  const toggleBlockIdsRef = useRef<string[]>([]);

  const previewDocument = useMemo(() => {
    void pageId;
    void historyId;
    void projectId;
    cleanupToggleStates(toggleBlockIdsRef.current);
    const nextDocument = createReadonlyNfmPreviewDocument(content);
    toggleBlockIdsRef.current = setToggleStates(nextDocument.toggleStates);
    return nextDocument;
  }, [content, projectId, pageId, historyId]);

  useEffect(
    () => () => {
      cleanupToggleStates(toggleBlockIdsRef.current);
      toggleBlockIdsRef.current = [];
    },
    [],
  );

  const editor = useCreateBlockNote(
    {
      schema: readonlyNfmBlockNotePreviewSchema,
      extensions: [nfmSyntaxHighlighter],
      initialContent: previewDocument.initialContent,
      resolveFileUrl: async (source) => {
        if (parseFileSource(source)) {
          if (!fileRuntime) throw new Error("File preview authority is unavailable");
          return fileRuntime.readImageDataUrl(source);
        }
        const displayUrl = resolveAssetSourceToDisplayUrl(source);
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
    [projectId, pageId, historyId, content, fileRuntime],
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
        ...options,
      });
    },
    [fileReferenceRouter, projectWorkspacePath],
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
          external: event.metaKey || event.ctrlKey || event.altKey || event.shiftKey,
          mode: "preview",
        });
        return;
      }
      void openNfmResolvedLinkAction(
        resolved.action,
        undefined,
        undefined,
        undefined,
        hostRuntime?.openPage
          ? {
              openPage: (targetPageId) =>
                hostRuntime.openPage?.({
                  accessContext: hostRuntime.contentAccessContext,
                  pageId: targetPageId,
                }),
            }
          : undefined,
      );
    },
    [findAnchorAction, hostRuntime, openLocalReference],
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
      if (resolved.action.kind !== "local-file" && resolved.action.kind !== "workspace-file")
        return;

      event.preventDefault();
      event.stopPropagation();
      openLocalReference(resolved.action, { external: true });
    },
    [findAnchorAction, openLocalReference],
  );

  const handleContextMenuCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const resolved = findAnchorAction(event);
      if (!resolved?.action) return;
      if (resolved.action.kind !== "local-file" && resolved.action.kind !== "workspace-file")
        return;

      event.preventDefault();
      event.stopPropagation();
      const label = resolved.anchor.textContent?.trim() || resolved.action.target.path;
      void openFileReferenceContextMenu({
        target: resolved.action.target,
        label,
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
    [fileReferenceRouter, findAnchorAction, projectWorkspacePath],
  );

  return (
    <div
      className={cn("nfm-editor readonly-nfm-blocknote-preview relative", className)}
      style={{ minHeight: 0 }}
      onClickCapture={handleClickCapture}
      onDoubleClickCapture={handleDoubleClickCapture}
      onAuxClickCapture={handleAuxClickCapture}
      onContextMenuCapture={handleContextMenuCapture}
      spellCheck={false}
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
}
