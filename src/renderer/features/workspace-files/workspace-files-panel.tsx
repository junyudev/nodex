import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CheckmarkIcon, CopyIcon, OpenInIcon, RefreshIcon } from "@/components/shared/icons";
import { PanelRightHiddenIcon, PanelRightVisibleIcon } from "@/components/shared/icons";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import {
  FileIcon,
  SidePanelFilesIcon,
  SearchIcon,
  ProjectActionsIcon,
} from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { LazySourceViewer } from "@/components/ui/lazy-source-viewer";
import { invoke, subscribeWorkspaceFileChanges } from "@/lib/api";
import {
  workspaceDirectoryQueryOptions,
  workspaceFileBinaryQueryOptions,
  workspaceFileMetadataQueryOptions,
  workspaceFileSearchQueryOptions,
  workspaceFileTextQueryOptions,
} from "@/lib/query-options";
import type { Project, ProjectSession, WorkspaceFileDirectoryEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { classifyContentBudget } from "@/lib/content-budget";
import { writeTextToClipboard } from "@/lib/clipboard";
import { FILE_LINK_OPENER_ICON_URLS } from "@/lib/file-link-opener-icons";
import { useFileReferenceRouter } from "@/lib/file-reference-router";
import { useScopedAtom } from "@/lib/maitai";
import { FILE_LINK_OPENER_OPTIONS, type FileLinkOpenerId } from "../../../shared/file-link-openers";
import {
  getWorkspaceFileDomTabId,
  getWorkspaceFileName,
  getWorkspaceRelativePath,
  resolveWorkspaceFilePresentation,
  resolveWorkspaceSourceLanguage,
  resolveWorkspaceTreeFilePath,
  WORKSPACE_TEXT_EDITABLE_MAX_BYTES,
  WORKSPACE_TEXT_LOAD_MAX_BYTES,
  type WorkspaceFilePresentation,
} from "./workspace-file-model";
import {
  WorkspaceFileTree,
  type WorkspaceFileTreePath,
  type WorkspaceFileTreeState,
} from "./workspace-file-tree";
import {
  normalizeWorkspaceFileNavigationState,
  selectWorkspaceFileNavigationPath,
  updateWorkspaceFileNavigationExpansion,
  workspaceFileNavigationStateFamily,
  type WorkspaceFileNavigationState,
} from "./workspace-file-navigation-state";
import {
  clampWorkspaceTreeWidth,
  WORKSPACE_TREE_DEFAULT_WIDTH,
  WORKSPACE_TREE_MAX_RATIO,
  WORKSPACE_TREE_MIN_WIDTH,
} from "./workspace-file-layout";
import { WorkspaceFileConflict } from "./workspace-file-conflict";
import { WorkspacePierreEditor } from "./workspace-pierre-editor";
import {
  WorkspaceTextDocumentController,
  workspaceTextDocumentRegistry,
  type WorkspaceTextDocumentSnapshot,
} from "./workspace-text-document-controller";
import {
  normalizeWorkspaceFilesTabState,
  type WorkspaceFilesTab,
  type WorkspaceFilesTabState,
  type WorkspaceFilePreviewState,
} from "./workspace-file-types";

export const WORKSPACE_TEXT_MAX_BYTES = WORKSPACE_TEXT_LOAD_MAX_BYTES;
const MAX_BINARY_PREVIEW_BYTES = 25_000_000;
const CONTENT_SAMPLE_BYTES = 8_192;
export const WORKSPACE_RICH_MARKDOWN_MAX_BYTES = 256 * 1024;
export const WORKSPACE_RICH_MARKDOWN_MAX_LINES = 5_000;

const LazyWorkspacePdfPreview = lazy(async () => {
  const { WorkspacePdfPreview } = await import("./workspace-pdf-preview");
  return { default: WorkspacePdfPreview };
});

export function classifyWorkspaceMarkdownPreview(value: string) {
  return classifyContentBudget({
    value,
    maxBytes: WORKSPACE_RICH_MARKDOWN_MAX_BYTES,
    maxLines: WORKSPACE_RICH_MARKDOWN_MAX_LINES,
  });
}

interface WorkspaceFilesPanelProps {
  tab: WorkspaceFilesTab;
  activeSession?: ProjectSession;
  presentationOwnerId?: string;
  project: Project | null;
  onOpenFileTab: (input: {
    path: string;
    title: string;
    panelId: WorkspaceFilesTab["panelId"];
    mode: "preview" | "durable";
  }) => Promise<unknown>;
  onUpdateTabState?: (state: WorkspaceFilesTabState) => void;
}

type EntriesByPath = Record<string, WorkspaceFileDirectoryEntry[]>;
const WORKSPACE_NAVIGATION_STATE_WRITE_DELAY_MS = 100;

const EMPTY_PREVIEW_STATE: WorkspaceFilePreviewState = {
  status: "idle",
  path: null,
  metadata: null,
  content: "",
  binaryUrl: null,
  message: null,
};

function resolveWorkspaceRoot(tab: WorkspaceFilesTab, project: Project | null): string | null {
  const configuredRoot = tab.config.workspaceRoot?.trim();
  if (configuredRoot) return configuredRoot;
  return project?.primaryWorkspaceRoot?.trim() || project?.sources[0]?.root.trim() || null;
}

function buildBinaryObjectUrl(dataBase64: string, mimeType: string | undefined): string {
  const decoded = window.atob(dataBase64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType || "application/octet-stream" }));
}

function Breadcrumb({
  cwd,
  workspaceRoot,
  selectedPath,
}: {
  cwd: string | null;
  workspaceRoot: string | null;
  selectedPath: string | null;
}) {
  const relativeToRoot =
    selectedPath && workspaceRoot ? getWorkspaceRelativePath(workspaceRoot, selectedPath) : null;
  const relativeToCwd = selectedPath && cwd ? getWorkspaceRelativePath(cwd, selectedPath) : null;
  const contextRoot = relativeToRoot !== null ? workspaceRoot : relativeToCwd !== null ? cwd : null;
  const label = relativeToRoot ?? relativeToCwd ?? selectedPath ?? "";
  const parts = label.replace(/\\/g, "/").split("/").filter(Boolean);
  const rootLabel = contextRoot
    ? getWorkspaceFileName(contextRoot) || contextRoot
    : (parts.shift() ?? "Files");
  return (
    <div className="flex min-w-0 items-center gap-1 text-sm text-token-text-secondary">
      <span className="shrink-0 truncate">{rootLabel}</span>
      {parts.map((part, index) => (
        <span key={`${part}:${index}`} className="flex min-w-0 items-center gap-1">
          <span className="text-token-description-foreground">/</span>
          <span className={cn("truncate", index === parts.length - 1 && "text-token-text-primary")}>
            {part}
          </span>
        </span>
      ))}
    </div>
  );
}

function WorkspaceFilePreview({
  state,
  presentation,
  document,
  workspaceRoot,
  onOpenExternal,
  onOpenExternalLink,
  onEdit,
  onUseDisk,
  onKeepLocal,
  onRetrySave,
  markdownMode,
  wrap,
  revealLocation,
}: {
  state: WorkspaceFilePreviewState;
  presentation: WorkspaceFilePresentation | null;
  document: WorkspaceTextDocumentSnapshot | null;
  workspaceRoot: string | null;
  onOpenExternal: () => void;
  onOpenExternalLink: (url: string) => void;
  onEdit: (value: string) => void;
  onUseDisk: () => void;
  onKeepLocal: () => void;
  onRetrySave: () => void;
  markdownMode: "source" | "rendered";
  wrap: boolean;
  revealLocation?: WorkspaceFilesTabState["pendingReveal"];
}) {
  if (state.status === "idle") {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="flex max-w-72 flex-col items-center gap-3">
          <SidePanelFilesIcon className="size-8 text-token-description-foreground" />
          <div className="space-y-1">
            <div className="text-lg/6 font-medium text-token-text-primary">Open file</div>
            <div className="text-sm text-token-text-secondary">
              Select a file from the workspace tree
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-token-text-secondary">
        Loading file...
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-token-text-secondary">
        <FileIcon className="icon-md" />
        <div>{state.message ?? "Unable to read file."}</div>
      </div>
    );
  }

  if (
    state.status === "unsupported" ||
    presentation === "unsupported" ||
    presentation === "too-large"
  ) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-token-text-secondary">
        <SidePanelFilesIcon className="icon-md" />
        <div>{state.message ?? "Preview is not available for this file."}</div>
        <button
          type="button"
          className="border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 flex h-token-button-composer items-center gap-1.5 rounded-lg border px-2 text-base leading-[18px] text-token-text-primary"
          onClick={onOpenExternal}
        >
          <OpenInIcon className="icon-2xs" />
          Open externally
        </button>
      </div>
    );
  }

  if (presentation === "markdown" && markdownMode === "rendered") {
    const markdownContent = document?.content ?? state.content;
    const richPreviewDecision = classifyWorkspaceMarkdownPreview(markdownContent);
    if (richPreviewDecision.kind === "tooLarge") {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-3 text-xs text-token-description-foreground">
            <span className="truncate">Rich preview is unavailable for large Markdown files.</span>
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-1 text-token-foreground hover:bg-token-foreground/5"
              onClick={onOpenExternal}
            >
              Open
            </button>
          </div>
          <LazySourceViewer
            value={markdownContent}
            ariaLabel={`Markdown source for ${getWorkspaceFileName(state.path ?? "file")}`}
            sourceIdentity={state.path ?? undefined}
            lineNumbers
            wrap={wrap}
            revealLocation={revealLocation}
            className="min-h-0 flex-1"
          />
        </div>
      );
    }

    return (
      <div className="h-full overflow-auto px-6 py-4">
        <MarkdownRenderer
          content={markdownContent}
          className="max-w-3xl text-sm leading-6"
          projectWorkspacePath={workspaceRoot}
        />
      </div>
    );
  }

  if (presentation === "image" && state.binaryUrl) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-token-main-surface-primary p-4">
        <img src={state.binaryUrl} alt="" className="max-h-full max-w-full object-contain" />
      </div>
    );
  }

  if (presentation === "pdf" && state.binaryUrl) {
    return (
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-sm text-token-text-secondary">
            Loading PDF…
          </div>
        }
      >
        <LazyWorkspacePdfPreview
          fileDataUrl={state.binaryUrl}
          title={getWorkspaceFileName(state.path ?? "file.pdf")}
          onOpenExternalLink={onOpenExternalLink}
        />
      </Suspense>
    );
  }

  if (
    (presentation === "editable-text" ||
      (presentation === "markdown" && markdownMode === "source")) &&
    document
  ) {
    if (document.status === "conflict" && document.diskContent !== null) {
      return (
        <WorkspaceFileConflict
          filename={getWorkspaceFileName(document.path)}
          diskValue={document.diskContent}
          localValue={document.content}
          onUseDisk={onUseDisk}
          onKeepLocal={onKeepLocal}
        />
      );
    }

    return (
      <div className="flex h-full min-h-0 flex-col">
        {document.status === "error" ? (
          <div className="flex min-h-9 shrink-0 items-center gap-2 border-b-[0.5px] border-token-border px-3 text-xs text-token-text-secondary">
            <span className="min-w-0 flex-1 truncate">
              {document.message ?? "Unable to save file."}
            </span>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-token-text-primary hover:bg-token-list-hover-background"
              onClick={onRetrySave}
            >
              Retry
            </button>
          </div>
        ) : null}
        <WorkspacePierreEditor
          value={document.content}
          filename={getWorkspaceFileName(document.path)}
          language={resolveWorkspaceSourceLanguage(document.path)}
          sourceIdentity={document.path}
          documentVersion={document.documentVersion}
          ariaLabel={`Source editor for ${getWorkspaceFileName(document.path)}`}
          wrap={wrap}
          className="min-h-0 flex-1"
          onChange={onEdit}
          revealLocation={revealLocation}
        />
        <div className="flex h-6 shrink-0 items-center justify-end border-t-[0.5px] border-token-border px-2 text-[11px] text-token-description-foreground">
          {document.status === "saving"
            ? "Saving…"
            : document.status === "dirty"
              ? "Unsaved"
              : "Saved"}
        </div>
      </div>
    );
  }

  const isLargeReadOnlySource =
    (presentation === "readonly-text" ||
      (presentation === "markdown" && markdownMode === "source")) &&
    (state.metadata?.sizeBytes ?? 0) >= WORKSPACE_TEXT_EDITABLE_MAX_BYTES;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {isLargeReadOnlySource ? (
        <div className="flex h-7 shrink-0 items-center border-b-[0.5px] border-token-border px-3 text-xs text-token-description-foreground">
          Large file — read only
        </div>
      ) : null}
      <LazySourceViewer
        value={state.content}
        ariaLabel={`Source preview for ${getWorkspaceFileName(state.path ?? "file")}`}
        filename={getWorkspaceFileName(state.path ?? "file")}
        language={resolveWorkspaceSourceLanguage(state.path ?? "")}
        sourceIdentity={state.path ?? undefined}
        lineNumbers
        wrap={wrap}
        revealLocation={revealLocation}
        className="min-h-0 flex-1 bg-token-main-surface-primary"
      />
    </div>
  );
}

export function WorkspaceFilesPanel({
  tab,
  activeSession,
  presentationOwnerId,
  project,
  onOpenFileTab,
  onUpdateTabState,
}: WorkspaceFilesPanelProps) {
  const workspaceRoot = resolveWorkspaceRoot(tab, project);
  const fileReferenceRouter = useFileReferenceRouter();
  const hostId = tab.config.hostId ?? "local";
  const selectedPath = tab.config.path ?? null;
  const cwd = tab.config.cwd?.trim() || activeSession?.thread?.cwd?.trim() || null;
  const selectedTreePath =
    selectedPath && workspaceRoot ? getWorkspaceRelativePath(workspaceRoot, selectedPath) : null;
  const queryClient = useQueryClient();
  const navigationAtom = workspaceFileNavigationStateFamily({
    hostId,
    includeHidden: true,
    workspaceRoot: workspaceRoot ?? `__file-tab__/${tab.id}`,
  });
  const [storedNavigationState, setStoredNavigationState] = useScopedAtom(navigationAtom);
  const [navigationState, setNavigationState] = useState<WorkspaceFileNavigationState>(() =>
    selectWorkspaceFileNavigationPath(storedNavigationState, selectedTreePath),
  );
  const navigationStateRef = useRef(navigationState);
  const navigationWriteTimeoutRef = useRef<number | null>(null);
  const initialTabStateRef = useRef(normalizeWorkspaceFilesTabState(tab.state));
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [searchPaths, setSearchPaths] = useState<WorkspaceFileTreePath[] | null>(null);
  const [searchPending, setSearchPending] = useState(false);
  const searchGenerationRef = useRef(0);
  const persistedTabStateRef = useRef<WorkspaceFilesTabState>(initialTabStateRef.current);
  const [treeWidth, setTreeWidth] = useState(
    initialTabStateRef.current.treeWidth ?? WORKSPACE_TREE_DEFAULT_WIDTH,
  );
  const [treeVisible, setTreeVisible] = useState(initialTabStateRef.current.treeVisible ?? true);
  const [markdownMode, setMarkdownMode] = useState<"source" | "rendered">(
    initialTabStateRef.current.markdownMode ?? "source",
  );
  const [wordWrap, setWordWrap] = useState(initialTabStateRef.current.wordWrap ?? true);
  const revealLocation = initialTabStateRef.current.pendingReveal;
  const [previewState, setPreviewState] = useState<WorkspaceFilePreviewState>(EMPTY_PREVIEW_STATE);
  const [documentSnapshot, setDocumentSnapshot] = useState<WorkspaceTextDocumentSnapshot | null>(
    null,
  );
  const documentControllerRef = useRef<WorkspaceTextDocumentController | null>(null);
  const onUpdateTabStateRef = useRef(onUpdateTabState);
  onUpdateTabStateRef.current = onUpdateTabState;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const presentation = previewState.metadata
    ? resolveWorkspaceFilePresentation({
        path: previewState.path ?? "",
        contentKind: previewState.metadata.contentKind,
        mimeType: previewState.metadata.mimeType,
        sizeBytes: previewState.metadata.sizeBytes,
      })
    : null;

  const publishNavigationState = useCallback(
    (input: WorkspaceFileNavigationState) => {
      const nextState = normalizeWorkspaceFileNavigationState(input);
      navigationStateRef.current = nextState;
      setNavigationState((current) => (current === nextState ? current : nextState));
      if (navigationWriteTimeoutRef.current !== null) {
        window.clearTimeout(navigationWriteTimeoutRef.current);
      }
      navigationWriteTimeoutRef.current = window.setTimeout(() => {
        navigationWriteTimeoutRef.current = null;
        setStoredNavigationState(navigationStateRef.current);
      }, WORKSPACE_NAVIGATION_STATE_WRITE_DELAY_MS);
    },
    [setStoredNavigationState],
  );

  useEffect(() => {
    if (navigationWriteTimeoutRef.current !== null) return;
    navigationStateRef.current = storedNavigationState;
    setNavigationState((current) =>
      current === storedNavigationState ? current : storedNavigationState,
    );
  }, [storedNavigationState]);

  useEffect(() => {
    const nextState = selectWorkspaceFileNavigationPath(
      navigationStateRef.current,
      selectedTreePath,
    );
    if (nextState === navigationStateRef.current) return;
    publishNavigationState(nextState);
  }, [publishNavigationState, selectedTreePath]);

  useEffect(
    () => () => {
      if (navigationWriteTimeoutRef.current !== null) {
        window.clearTimeout(navigationWriteTimeoutRef.current);
        navigationWriteTimeoutRef.current = null;
      }
      setStoredNavigationState(navigationStateRef.current);
    },
    [setStoredNavigationState],
  );

  const expandedPaths = useMemo(
    () => new Set(navigationState.expandedPaths),
    [navigationState.expandedPaths],
  );
  const directoryPaths = useMemo(
    () => (workspaceRoot ? [...expandedPaths].sort() : []),
    [expandedPaths, workspaceRoot],
  );
  const directoryQueries = useQueries({
    queries: directoryPaths.map((directoryPath) =>
      workspaceDirectoryQueryOptions({
        hostId,
        workspaceRoot: workspaceRoot ?? "",
        directoryPath,
        includeHidden: true,
      }),
    ),
  });
  const entriesByPath = Object.fromEntries(
    directoryQueries.flatMap((query, index) => {
      const directoryPath = directoryPaths[index];
      if (directoryPath === undefined || !query.data) return [];
      return [[directoryPath, query.data.entries] as const];
    }),
  ) satisfies EntriesByPath;
  const directoryError = directoryQueries.find((query) => query.error)?.error;
  const rootDirectoryPending = directoryQueries[directoryPaths.indexOf("")]?.isPending ?? false;

  const persistTabState = useCallback((state: WorkspaceFilesTabState) => {
    persistedTabStateRef.current = state;
    onUpdateTabStateRef.current?.(state);
  }, []);

  const revealViewerMounted = Boolean(
    selectedPath &&
    previewState.status === "loaded" &&
    (presentation === "editable-text" ||
      presentation === "readonly-text" ||
      (presentation === "markdown" && markdownMode === "source")) &&
    revealLocation?.line,
  );

  useEffect(() => {
    if (!revealViewerMounted) return;

    let clearFrame: number | null = null;
    const revealFrame = window.requestAnimationFrame(() => {
      clearFrame = window.requestAnimationFrame(() => {
        const nextState = { ...persistedTabStateRef.current };
        delete nextState.pendingReveal;
        persistTabState(nextState);
      });
    });

    return () => {
      window.cancelAnimationFrame(revealFrame);
      if (clearFrame !== null) window.cancelAnimationFrame(clearFrame);
    };
  }, [
    persistTabState,
    revealLocation?.column,
    revealLocation?.endColumn,
    revealLocation?.endLine,
    revealLocation?.line,
    revealViewerMounted,
  ]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setTreeWidth((current) => clampWorkspaceTreeWidth(current, entry.contentRect.width));
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!directoryError) return;
    toast.danger(directoryError instanceof Error ? directoryError.message : "Unable to load files");
  }, [directoryError]);

  const refreshDirectories = useCallback(() => {
    if (!workspaceRoot) return;
    for (const directoryPath of directoryPaths) {
      void queryClient.invalidateQueries({
        queryKey: workspaceDirectoryQueryOptions({
          hostId,
          workspaceRoot,
          directoryPath,
          includeHidden: true,
        }).queryKey,
      });
    }
  }, [directoryPaths, hostId, queryClient, workspaceRoot]);

  useEffect(() => {
    const normalizedQuery = navigationState.searchQuery.trim();
    const generation = searchGenerationRef.current + 1;
    searchGenerationRef.current = generation;
    if (!workspaceRoot || !normalizedQuery) {
      setDebouncedSearchQuery("");
      setSearchPaths(null);
      setSearchPending(false);
      return;
    }

    setSearchPending(true);
    const timeout = window.setTimeout(() => {
      setDebouncedSearchQuery(normalizedQuery);
      void queryClient
        .fetchQuery(
          workspaceFileSearchQueryOptions({
            hostId,
            workspaceRoot,
            query: normalizedQuery,
          }),
        )
        .then((result) => {
          if (searchGenerationRef.current !== generation) return;
          setSearchPaths([
            ...result.ancestorDirectories.map((path) => ({
              path,
              kind: "directory" as const,
            })),
            ...result.matches.map((match) => ({
              path: match.path,
              kind: "file" as const,
            })),
          ]);
          setSearchPending(false);
        })
        .catch((error: unknown) => {
          if (searchGenerationRef.current !== generation) return;
          setSearchPaths([]);
          setSearchPending(false);
          toast.danger(error instanceof Error ? error.message : "Unable to search files");
        });
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [hostId, navigationState.searchQuery, queryClient, workspaceRoot]);

  useEffect(() => {
    if (!selectedPath) {
      setPreviewState(EMPTY_PREVIEW_STATE);
      setDocumentSnapshot(null);
      return;
    }

    let cancelled = false;
    let unsubscribeDocument: (() => void) | null = null;
    let unregisterDocument: (() => void) | null = null;
    let loadedController: WorkspaceTextDocumentController | null = null;
    let fileWatchSubscriptionId: string | null = null;
    let unsubscribeFileWatch: (() => void) | null = null;
    let binaryObjectUrl: string | null = null;
    documentControllerRef.current = null;
    setDocumentSnapshot(null);
    setPreviewState({
      ...EMPTY_PREVIEW_STATE,
      status: "loading",
      path: selectedPath,
    });

    const loadPreview = async () => {
      try {
        const metadata = await queryClient.fetchQuery(
          workspaceFileMetadataQueryOptions({
            hostId,
            path: selectedPath,
            contentSampleByteLimit: CONTENT_SAMPLE_BYTES,
            contentSampleMaxFileBytes: MAX_BINARY_PREVIEW_BYTES,
          }),
        );
        if (!metadata.isFile) {
          if (!cancelled) {
            setPreviewState({
              status: "unsupported",
              path: selectedPath,
              metadata,
              content: "",
              binaryUrl: null,
              message: "Directories open from the file tree.",
            });
          }
          return;
        }

        const nextPresentation = resolveWorkspaceFilePresentation({
          path: selectedPath,
          contentKind: metadata.contentKind,
          mimeType: metadata.mimeType,
          sizeBytes: metadata.sizeBytes,
        });
        if (nextPresentation === "image" || nextPresentation === "pdf") {
          if (
            nextPresentation === "image" &&
            metadata.sizeBytes !== null &&
            metadata.sizeBytes > MAX_BINARY_PREVIEW_BYTES
          ) {
            if (!cancelled) {
              setPreviewState({
                status: "unsupported",
                path: selectedPath,
                metadata,
                content: "",
                binaryUrl: null,
                message: `${getWorkspaceFileName(selectedPath)} is too large to preview.`,
              });
            }
            return;
          }
          const binary = await queryClient.fetchQuery(
            workspaceFileBinaryQueryOptions({
              hostId,
              path: selectedPath,
            }),
          );
          if (!binary.contentsBase64) throw new Error("Unable to read binary file.");
          const nextBinaryUrl =
            nextPresentation === "pdf"
              ? `data:application/pdf;base64,${binary.contentsBase64}`
              : buildBinaryObjectUrl(binary.contentsBase64, binary.mimeType);
          if (cancelled) {
            if (nextPresentation === "image") URL.revokeObjectURL(nextBinaryUrl);
            return;
          }
          if (nextPresentation === "image") binaryObjectUrl = nextBinaryUrl;
          setPreviewState({
            status: "loaded",
            path: selectedPath,
            metadata,
            content: "",
            binaryUrl: nextBinaryUrl,
            message: null,
          });
          return;
        }

        if (
          nextPresentation === "unsupported" ||
          nextPresentation === "too-large" ||
          metadata.contentKind === "binary"
        ) {
          if (!cancelled) {
            setPreviewState({
              status: "unsupported",
              path: selectedPath,
              metadata,
              content: "",
              binaryUrl: null,
              message:
                nextPresentation === "too-large"
                  ? `${getWorkspaceFileName(selectedPath)} is too large to preview.`
                  : `Preview is not available for ${getWorkspaceFileName(selectedPath)}.`,
            });
          }
          return;
        }

        if (metadata.sizeBytes !== null && metadata.sizeBytes > WORKSPACE_TEXT_MAX_BYTES) {
          if (!cancelled) {
            setPreviewState({
              status: "unsupported",
              path: selectedPath,
              metadata,
              content: "",
              binaryUrl: null,
              message: `${getWorkspaceFileName(selectedPath)} is too large to preview.`,
            });
          }
          return;
        }

        const text = await queryClient.fetchQuery(
          workspaceFileTextQueryOptions({
            hostId,
            path: selectedPath,
            maxBytes: WORKSPACE_TEXT_MAX_BYTES,
          }),
        );
        if (!cancelled) {
          const editableMarkdown =
            nextPresentation === "markdown" &&
            metadata.sizeBytes !== null &&
            metadata.sizeBytes < WORKSPACE_TEXT_EDITABLE_MAX_BYTES;
          if (nextPresentation === "editable-text" || editableMarkdown) {
            loadedController = new WorkspaceTextDocumentController(
              {
                path: selectedPath,
                content: text.contents,
                mtimeMs: metadata.mtimeMs,
                draft: persistedTabStateRef.current.draft,
              },
              {
                write: async (path, content, expectedMtimeMs) =>
                  await invoke("write-file", {
                    hostId,
                    path,
                    content,
                    expectedMtimeMs,
                  }),
                readDisk: async (path) => {
                  const nextMetadata = await invoke("read-file-metadata", {
                    hostId,
                    path,
                    contentSampleByteLimit: CONTENT_SAMPLE_BYTES,
                    contentSampleMaxFileBytes: WORKSPACE_TEXT_MAX_BYTES,
                  });
                  const nextText = await invoke("read-file", {
                    hostId,
                    path,
                    maxBytes: WORKSPACE_TEXT_MAX_BYTES,
                  });
                  return {
                    content: nextText.contents,
                    mtimeMs: nextMetadata.mtimeMs,
                  };
                },
                persistDraft: (draft) => {
                  persistTabState({
                    ...persistedTabStateRef.current,
                    draft,
                  });
                },
                clearDraft: () => {
                  const nextState = { ...persistedTabStateRef.current };
                  delete nextState.draft;
                  persistTabState(nextState);
                },
              },
            );
            documentControllerRef.current = loadedController;
            setDocumentSnapshot(loadedController.getSnapshot());
            unsubscribeDocument = loadedController.subscribe(() => {
              setDocumentSnapshot(loadedController?.getSnapshot() ?? null);
            });
            unregisterDocument = workspaceTextDocumentRegistry.register(tab.id, loadedController);
            unsubscribeFileWatch = subscribeWorkspaceFileChanges((event) => {
              if (event.subscriptionId !== fileWatchSubscriptionId) return;
              void loadedController?.notifyExternalChange();
            });
            void invoke("workspace-file-watch:start", {
              hostId,
              path: selectedPath,
            })
              .then((result) => {
                if (cancelled) {
                  void invoke("workspace-file-watch:stop", {
                    subscriptionId: result.subscriptionId,
                  });
                  return;
                }
                fileWatchSubscriptionId = result.subscriptionId;
                // Reconcile once after subscribing so a write between the
                // initial read and watcher registration cannot leave a stale view.
                void loadedController?.notifyExternalChange();
              })
              .catch(() => {
                unsubscribeFileWatch?.();
                unsubscribeFileWatch = null;
              });
          }
          setPreviewState({
            status: "loaded",
            path: selectedPath,
            metadata,
            content: text.contents,
            binaryUrl: null,
            message: null,
          });
        }
      } catch (error) {
        if (cancelled) return;
        setPreviewState({
          status: "error",
          path: selectedPath,
          metadata: null,
          content: "",
          binaryUrl: null,
          message: error instanceof Error ? error.message : "Unable to load file.",
        });
      }
    };

    void loadPreview();
    return () => {
      cancelled = true;
      unsubscribeDocument?.();
      unregisterDocument?.();
      unsubscribeFileWatch?.();
      if (binaryObjectUrl) URL.revokeObjectURL(binaryObjectUrl);
      if (fileWatchSubscriptionId) {
        void invoke("workspace-file-watch:stop", {
          subscriptionId: fileWatchSubscriptionId,
        });
      }
      if (loadedController) {
        void loadedController.flush().finally(() => loadedController?.dispose());
      }
      if (documentControllerRef.current === loadedController) {
        documentControllerRef.current = null;
      }
    };
  }, [hostId, persistTabState, queryClient, selectedPath, tab.id]);

  const browsePaths = useMemo(() => {
    const byPath = new Map<string, WorkspaceFileTreePath>();
    for (const entries of Object.values(entriesByPath)) {
      for (const entry of entries) {
        byPath.set(entry.path, {
          path: entry.path,
          kind: entry.type,
        });
      }
    }
    return [...byPath.values()];
  }, [entriesByPath]);
  const treePaths = searchPaths ?? browsePaths;

  const openTreeEntry = useCallback(
    async (path: string, mode: "preview" | "durable") => {
      if (!workspaceRoot) return;
      await onOpenFileTab({
        path: resolveWorkspaceTreeFilePath(workspaceRoot, path),
        title: getWorkspaceFileName(path),
        panelId: tab.panelId,
        mode,
      });
    },
    [onOpenFileTab, tab.panelId, workspaceRoot],
  );

  const expandTreeEntry = useCallback(
    (path: string) => {
      publishNavigationState(
        updateWorkspaceFileNavigationExpansion(navigationStateRef.current, path, true),
      );
    },
    [publishNavigationState],
  );

  const collapseTreeEntry = useCallback(
    (path: string) => {
      publishNavigationState(
        updateWorkspaceFileNavigationExpansion(navigationStateRef.current, path, false),
      );
    },
    [publishNavigationState],
  );

  const updateTreeState = useCallback(
    (state: WorkspaceFileTreeState) => {
      publishNavigationState({
        ...navigationStateRef.current,
        expandedPaths: state.expandedPaths,
        selectedPath: state.selectedPath,
        scrollTop: state.scrollTop,
      });
    },
    [publishNavigationState],
  );

  const updateFilterQuery = useCallback(
    (searchQuery: string) => {
      publishNavigationState({
        ...navigationStateRef.current,
        searchQuery,
      });
    },
    [publishNavigationState],
  );

  const openExternal = useCallback(
    (opener?: FileLinkOpenerId) => {
      if (!selectedPath) return;
      void fileReferenceRouter
        .open(
          {
            path: selectedPath,
            ...(revealLocation?.line
              ? {
                  line: revealLocation.line,
                  ...(revealLocation.column ? { column: revealLocation.column } : {}),
                  ...(revealLocation.endLine ? { endLine: revealLocation.endLine } : {}),
                  ...(revealLocation.endColumn ? { endColumn: revealLocation.endColumn } : {}),
                }
              : {}),
          },
          {
            external: true,
            opener,
            cwd,
            workspaceRoot,
            title: getWorkspaceFileName(selectedPath),
          },
        )
        .then((opened) => {
          if (opened) return;
          toast.danger("Unable to open file externally");
        })
        .catch(() => {
          toast.danger("Unable to open file externally");
        });
    },
    [cwd, fileReferenceRouter, revealLocation, selectedPath, workspaceRoot],
  );

  const openExternalUrl = useCallback((url: string) => {
    void invoke("shell:open-external-url", url).catch(() => {
      toast.danger("Unable to open external link");
    });
  }, []);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = treeWidth;
      let latestWidth = startWidth;
      const rootWidth = rootRef.current?.getBoundingClientRect().width ?? 0;

      const onMove = (moveEvent: PointerEvent) => {
        const nextWidth = clampWorkspaceTreeWidth(
          startWidth - (moveEvent.clientX - startX),
          rootWidth,
        );
        latestWidth = nextWidth;
        setTreeWidth(nextWidth);
      };
      const onUp = () => {
        persistTabState({
          ...persistedTabStateRef.current,
          treeWidth: latestWidth,
        });
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
    },
    [persistTabState, treeWidth],
  );

  const resizeTreeByKeyboard = useCallback(
    (delta: number) => {
      const rootWidth = rootRef.current?.getBoundingClientRect().width ?? 0;
      setTreeWidth((current) => {
        const next = clampWorkspaceTreeWidth(current + delta, rootWidth);
        persistTabState({
          ...persistedTabStateRef.current,
          treeWidth: next,
        });
        return next;
      });
    },
    [persistTabState],
  );

  const editDocument = useCallback((value: string) => {
    documentControllerRef.current?.edit(value);
  }, []);

  const useDiskVersion = useCallback(() => {
    documentControllerRef.current?.useDiskVersion();
  }, []);

  const keepLocalChanges = useCallback(() => {
    documentControllerRef.current?.keepLocalChanges();
  }, []);

  const retrySave = useCallback(() => {
    void documentControllerRef.current?.flush();
  }, []);

  const toggleTree = useCallback(() => {
    setTreeVisible((current) => {
      const next = !current;
      persistTabState({
        ...persistedTabStateRef.current,
        treeVisible: next,
      });
      return next;
    });
  }, [persistTabState]);

  const toggleWordWrap = useCallback(() => {
    setWordWrap((current) => {
      const next = !current;
      persistTabState({
        ...persistedTabStateRef.current,
        wordWrap: next,
      });
      return next;
    });
  }, [persistTabState]);

  const selectMarkdownMode = useCallback(
    (mode: "source" | "rendered") => {
      setMarkdownMode(mode);
      persistTabState({
        ...persistedTabStateRef.current,
        markdownMode: mode,
      });
    },
    [persistTabState],
  );

  const copyPath = useCallback(() => {
    if (!selectedPath) return;
    void writeTextToClipboard(selectedPath).then((copied) => {
      if (!copied) toast.danger("Unable to copy path");
    });
  }, [selectedPath]);

  const copyContents = useCallback(() => {
    const content = documentSnapshot?.content ?? previewState.content;
    if (!content) return;
    void writeTextToClipboard(content).then((copied) => {
      if (!copied) toast.danger("Unable to copy contents");
    });
  }, [documentSnapshot?.content, previewState.content]);

  if (!workspaceRoot && !selectedPath) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-token-main-surface-primary text-center text-sm text-token-text-secondary">
        <SidePanelFilesIcon className="icon-md" />
        <div>No file or workspace folder is available.</div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 bg-token-main-surface-primary"
      data-workspace-files-tab-id={getWorkspaceFileDomTabId(
        hostId,
        selectedPath ?? workspaceRoot ?? undefined,
      )}
      data-workspace-files-session-id={presentationOwnerId ?? activeSession?.id ?? "unassigned"}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex h-toolbar-pane shrink-0 items-center gap-2 border-b-[0.5px] border-token-border px-3"
          data-tab-preview-pin-exempt="true"
        >
          <Breadcrumb cwd={cwd} workspaceRoot={workspaceRoot} selectedPath={selectedPath} />
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-text-primary disabled:opacity-40"
              onClick={() => openExternal()}
              disabled={!selectedPath}
            >
              <OpenInIcon className="icon-2xs" />
              Open
            </button>
            <NodexDropdownMenu
              align="end"
              triggerButton={
                <button
                  type="button"
                  aria-label="File options"
                  className="flex aspect-square h-token-button-composer items-center justify-center rounded-lg text-token-text-tertiary hover:bg-token-list-hover-background hover:text-token-text-primary"
                >
                  <ProjectActionsIcon className="icon-2xs" />
                </button>
              }
            >
              <NodexDropdownFlyoutSubmenuItem
                label="Open with"
                leftSlot={<OpenInIcon className="icon-2xs" />}
                disabled={!selectedPath}
              >
                {FILE_LINK_OPENER_OPTIONS.map((option) => (
                  <NodexDropdownItem
                    key={option.id}
                    data-tab-preview-pin-exempt="true"
                    leftSlot={
                      <img
                        src={FILE_LINK_OPENER_ICON_URLS[option.id]}
                        alt=""
                        className="size-4 shrink-0 object-contain"
                        aria-hidden="true"
                      />
                    }
                    onSelect={() => openExternal(option.id)}
                  >
                    {option.label}
                  </NodexDropdownItem>
                ))}
              </NodexDropdownFlyoutSubmenuItem>
              <NodexDropdownSeparator />
              {presentation === "markdown" ? (
                <>
                  <NodexDropdownItem
                    data-tab-preview-pin-exempt="true"
                    onSelect={() => selectMarkdownMode("source")}
                    rightSlot={
                      markdownMode === "source" ? <CheckmarkIcon className="icon-2xs" /> : null
                    }
                  >
                    Source
                  </NodexDropdownItem>
                  <NodexDropdownItem
                    data-tab-preview-pin-exempt="true"
                    onSelect={() => selectMarkdownMode("rendered")}
                    rightSlot={
                      markdownMode === "rendered" ? <CheckmarkIcon className="icon-2xs" /> : null
                    }
                  >
                    Rendered Markdown
                  </NodexDropdownItem>
                  <NodexDropdownSeparator />
                </>
              ) : null}
              <NodexDropdownItem
                data-tab-preview-pin-exempt="true"
                onSelect={toggleWordWrap}
                rightSlot={wordWrap ? <CheckmarkIcon className="icon-2xs" /> : null}
                disabled={previewState.status !== "loaded" || previewState.binaryUrl !== null}
              >
                Word wrap
              </NodexDropdownItem>
              <NodexDropdownItem
                data-tab-preview-pin-exempt="true"
                leftSlot={<CopyIcon className="icon-2xs" />}
                onSelect={copyPath}
                disabled={!selectedPath}
              >
                Copy path
              </NodexDropdownItem>
              <NodexDropdownItem
                data-tab-preview-pin-exempt="true"
                leftSlot={<CopyIcon className="icon-2xs" />}
                onSelect={copyContents}
                disabled={
                  previewState.status !== "loaded" ||
                  previewState.binaryUrl !== null ||
                  !(documentSnapshot?.content ?? previewState.content)
                }
              >
                Copy contents
              </NodexDropdownItem>
              <NodexDropdownSeparator />
              <NodexDropdownItem data-tab-preview-pin-exempt="true" onSelect={toggleTree}>
                {treeVisible ? "Hide file tree" : "Show file tree"}
              </NodexDropdownItem>
            </NodexDropdownMenu>
            <NodexTooltip tooltipContent="Refresh files" delayOpen>
              <button
                type="button"
                className="flex aspect-square h-token-button-composer items-center justify-center rounded-lg text-token-text-tertiary hover:bg-token-list-hover-background hover:text-token-text-primary"
                onClick={refreshDirectories}
                disabled={!workspaceRoot}
              >
                <RefreshIcon className="icon-2xs" />
              </button>
            </NodexTooltip>
            <NodexTooltip
              tooltipContent={treeVisible ? "Hide file tree" : "Show file tree"}
              delayOpen
            >
              <button
                type="button"
                className="flex aspect-square h-token-button-composer items-center justify-center rounded-lg text-token-text-tertiary hover:bg-token-list-hover-background hover:text-token-text-primary"
                onClick={toggleTree}
                disabled={!workspaceRoot}
              >
                {treeVisible ? (
                  <PanelRightHiddenIcon className="icon-2xs" />
                ) : (
                  <PanelRightVisibleIcon className="icon-2xs" />
                )}
              </button>
            </NodexTooltip>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <WorkspaceFilePreview
            state={previewState}
            presentation={presentation}
            document={documentSnapshot}
            workspaceRoot={workspaceRoot}
            onOpenExternal={() => openExternal()}
            onOpenExternalLink={openExternalUrl}
            onEdit={editDocument}
            onUseDisk={useDiskVersion}
            onKeepLocal={keepLocalChanges}
            onRetrySave={retrySave}
            markdownMode={markdownMode}
            wrap={wordWrap}
            revealLocation={revealLocation}
          />
        </div>
      </div>

      {workspaceRoot && treeVisible ? (
        <aside
          className="relative flex h-full min-h-0 shrink-0 flex-col border-l-[0.5px] border-token-border bg-token-main-surface-primary"
          style={
            {
              width: treeWidth,
              maxWidth: `${WORKSPACE_TREE_MAX_RATIO * 100}%`,
            } satisfies CSSProperties
          }
          data-tab-preview-pin-exempt="true"
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file tree"
            aria-valuemin={WORKSPACE_TREE_MIN_WIDTH}
            aria-valuemax={Math.max(
              WORKSPACE_TREE_MIN_WIDTH,
              Math.round(
                (rootRef.current?.getBoundingClientRect().width ?? 0) * WORKSPACE_TREE_MAX_RATIO,
              ),
            )}
            aria-valuenow={Math.round(treeWidth)}
            tabIndex={0}
            className="absolute inset-y-0 left-0 z-10 w-4 -translate-x-2 cursor-col-resize"
            onPointerDown={startResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                resizeTreeByKeyboard(10);
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                resizeTreeByKeyboard(-10);
              } else if (event.key === "Home") {
                event.preventDefault();
                resizeTreeByKeyboard(WORKSPACE_TREE_MIN_WIDTH - treeWidth);
              }
            }}
          >
            <div className="mx-auto h-full w-px bg-gradient-to-b from-transparent via-token-foreground/25 to-transparent" />
          </div>
          <div className="shrink-0 p-2">
            <label
              htmlFor="workspace-directory-tree-search"
              className="relative flex h-token-button-composer w-full items-center gap-1.5 rounded-lg border border-token-border bg-token-bg-fog px-2 text-base leading-[18px]"
            >
              <SearchIcon className="icon-2xs shrink-0 text-token-description-foreground" />
              <input
                id="workspace-directory-tree-search"
                aria-label="Filter files"
                value={navigationState.searchQuery}
                onInput={(event) => updateFilterQuery(event.currentTarget.value)}
                placeholder="Filter files…"
                className="min-w-0 flex-1 bg-transparent text-sm text-token-text-primary outline-none placeholder:text-token-description-foreground"
              />
            </label>
          </div>
          <div className="min-h-0 flex-1 px-1 pb-2">
            {treePaths.length > 0 ? (
              <WorkspaceFileTree
                paths={treePaths}
                expandedPaths={expandedPaths}
                selectedPath={selectedTreePath}
                searchQuery={debouncedSearchQuery}
                initialScrollTop={navigationState.scrollTop}
                onExpand={expandTreeEntry}
                onCollapse={collapseTreeEntry}
                onOpen={openTreeEntry}
                onStateChange={updateTreeState}
              />
            ) : (
              <div className="px-2 py-4 text-sm text-token-text-secondary">
                {rootDirectoryPending || searchPending ? "Loading files..." : "No files found."}
              </div>
            )}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
