import { useFileSearch } from "@/lib/use-file-search";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { DEFAULT_CODEX_HOST_ID } from "../../../shared/codex-host";
import { FileTreeFilter } from "@/components/ui/file-tree-filter";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CopyLightIcon } from "@/components/shared/icons/file-viewer-icons";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import { toast } from "@/components/ui/toast";
import { LazySourceViewer } from "@/components/ui/lazy-source-viewer";
import { subscribeWorkspaceFileChanges } from "@/lib/api";
import {
  workspaceDirectoryQueryOptions,
  workspaceFileBinaryQueryOptions,
  workspaceFileMetadataQueryOptions,
  workspaceFileTextQueryOptions,
} from "@/lib/query-options";
import type { Project, ProjectSession, WorkspaceFileDirectoryEntry } from "@/lib/types";
import { classifyContentBudget } from "@/lib/content-budget";
import { writeTextToClipboard } from "@/lib/clipboard";
import { FILE_LINK_OPENER_ICON_URLS } from "@/lib/file-link-opener-icons";
import {
  FileReferenceHostProvider,
  FileReferenceRouterProvider,
  useFileReferenceRouter,
  type FileReferenceRouterPort,
} from "@/lib/file-reference-router";
import {
  listAvailableFileLinkOpeners,
  openExternalUrl as openUrlExternally,
  openPathWithDefaultApplication,
} from "@/lib/file-system-operations";
import { useFileLinkOpener } from "@/lib/use-file-link-opener";
import { useScopedAtom } from "@/lib/maitai";
import { createGitWorkerQuery } from "@/features/review/data/git-query";
import {
  readWorkspaceFileMetadata,
  readWorkspaceFileText,
  saveWorkspaceFileCopy,
  startWorkspaceFileWatch,
  stopWorkspaceFileWatch,
  writeWorkspaceFile,
} from "@/lib/workspace-file-operations";
import { FILE_LINK_OPENER_OPTIONS, type FileLinkOpenerId } from "../../../shared/file-link-openers";
import {
  getWorkspaceFileDomTabId,
  getWorkspaceFileName,
  getWorkspaceRelativePath,
  isWorkspaceFileTooLargeToPreview,
  resolveWorkspaceFilePreviewKind,
  resolveWorkspaceFileRichViewMode,
  resolveWorkspaceFileUnsupportedType,
  resolveWorkspaceSourceLanguage,
  resolveWorkspaceTreeFilePath,
  WORKSPACE_FILE_CONTENT_SAMPLE_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  WORKSPACE_TEXT_EDITABLE_MAX_BYTES,
  WORKSPACE_TEXT_LOAD_MAX_BYTES,
  type WorkspaceFilePreviewKind,
} from "./workspace-file-model";
import {
  resolveWorkspaceFileBreadcrumb,
  resolveWorkspaceFilePathVariants,
} from "./workspace-file-header-model";
import {
  WorkspaceFileTree,
  type WorkspaceFileTreePath,
  type WorkspaceFileTreeState,
} from "./workspace-file-tree";
import {
  normalizeWorkspaceFileNavigationState,
  selectWorkspaceFileNavigationPath,
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
import { WorkspaceFileMediaPreview } from "./workspace-file-media-preview";
import {
  WorkspaceFileErrorState,
  WorkspaceFileLoadingState,
  WorkspaceFileOpenFileState,
  WorkspaceFileTooLargeState,
  WorkspaceFileUnsupportedState,
} from "./workspace-file-preview-states";
import {
  WorkspaceFileViewerHeader,
  type WorkspaceFileOpenControl,
  type WorkspaceFileOpenTarget,
  type WorkspaceFileViewerOption,
} from "./workspace-file-viewer-header";
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

const MAX_IMAGE_PREVIEW_BYTES = 25_000_000;
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
  onOpenFileTab: (
    input: Parameters<FileReferenceRouterPort["openWorkspaceFileTab"]>[0] & {
      mode: "preview" | "durable";
    },
  ) => Promise<unknown>;
  onUpdateTabState?: (state: WorkspaceFilesTabState) => void;
  /** Opens workspace text search; the header omits the control without it. */
  onSearchInFiles?: () => void;
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

/** What the viewer body shows for the loaded file. */
type WorkspaceFileView =
  | { readonly kind: "rich"; readonly previewKind: WorkspaceFilePreviewKind }
  | { readonly kind: "source" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "too-large"; readonly sizeBytes: number; readonly limitBytes: number };

function resolveWorkspaceRoot(tab: WorkspaceFilesTab, project: Project | null): string | null {
  const configuredRoot = tab.config.workspaceRoot?.trim();
  if (configuredRoot) return configuredRoot;
  if (tab.config.hostId && tab.config.hostId !== "local") return null;
  return project?.primaryWorkspaceRoot?.trim() || project?.sources[0]?.root.trim() || null;
}

function parentDirectory(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function buildBinaryObjectUrl(dataBase64: string, mimeType: string | undefined): string {
  const decoded = window.atob(dataBase64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType || "application/octet-stream" }));
}

function WorkspaceFilePreview({
  hostId,
  state,
  view,
  document,
  workspaceRoot,
  onOpenExternalLink,
  onEdit,
  onUseDisk,
  onKeepLocal,
  onRetrySave,
  wrap,
  revealLocation,
  onRevealComplete,
  resourceRevision,
}: {
  hostId: string;
  state: WorkspaceFilePreviewState;
  view: WorkspaceFileView | null;
  document: WorkspaceTextDocumentSnapshot | null;
  workspaceRoot: string | null;
  onOpenExternalLink: (url: string) => void;
  onEdit: (value: string) => void;
  onUseDisk: () => void;
  onKeepLocal: () => void;
  onRetrySave: () => void;
  wrap: boolean;
  revealLocation?: WorkspaceFilesTabState["pendingReveal"];
  onRevealComplete: (location: NonNullable<WorkspaceFilesTabState["pendingReveal"]>) => void;
  resourceRevision: number;
}) {
  if (state.status === "idle") return <WorkspaceFileOpenFileState />;
  if (state.status === "loading") return <WorkspaceFileLoadingState />;
  if (state.status === "error") return <WorkspaceFileErrorState message={state.message} />;
  if (state.status === "unsupported" && state.metadata?.isFile === false) {
    return <WorkspaceFileErrorState message={state.message} />;
  }
  if (view?.kind === "too-large") {
    return <WorkspaceFileTooLargeState sizeBytes={view.sizeBytes} limitBytes={view.limitBytes} />;
  }
  const unsupportedType = state.path
    ? resolveWorkspaceFileUnsupportedType({
        path: state.path,
        contentKind: state.metadata?.contentKind,
      })
    : null;
  if (view?.kind === "unsupported" || state.status === "unsupported") {
    return <WorkspaceFileUnsupportedState type={unsupportedType ?? "binary"} />;
  }

  if (view?.kind === "rich" && state.path) {
    switch (view.previewKind) {
      case "audio":
      case "video":
        return (
          <WorkspaceFileMediaPreview
            key={resourceRevision}
            hostId={hostId}
            path={state.path}
            kind={view.previewKind}
            revision={resourceRevision}
          />
        );
      case "image":
        return state.binaryUrl ? (
          <div className="flex h-full items-center justify-center overflow-auto bg-surface p-4">
            <img src={state.binaryUrl} alt="" className="max-h-full max-w-full object-contain" />
          </div>
        ) : (
          <WorkspaceFileErrorState />
        );
      case "pdf":
        return state.binaryUrl ? (
          <Suspense fallback={<WorkspaceFileLoadingState />}>
            <LazyWorkspacePdfPreview
              fileDataUrl={state.binaryUrl}
              title={getWorkspaceFileName(state.path)}
              onOpenExternalLink={onOpenExternalLink}
            />
          </Suspense>
        ) : (
          <WorkspaceFileErrorState />
        );
      case "markdown": {
        const markdownContent = document?.content ?? state.content;
        if (classifyWorkspaceMarkdownPreview(markdownContent).kind !== "tooLarge") {
          return (
            <div className="h-full overflow-auto bg-surface px-6 py-4">
              <MarkdownRenderer
                content={markdownContent}
                className="max-w-3xl"
                projectWorkspacePath={workspaceRoot}
                fileMediaScope={{
                  hostId,
                  sourceFilePath: state.path,
                  revision: resourceRevision,
                }}
              />
            </div>
          );
        }
        break;
      }
    }
  }

  if (document && state.path) {
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
          <div className="flex min-h-9 shrink-0 items-center gap-2 border-b-[0.5px] border-token-border px-3 text-xs semantic-text-secondary">
            <span className="min-w-0 flex-1 truncate">
              {document.message ?? "Unable to save file."}
            </span>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-(--color-text) hover:bg-(--color-background-primary-ghost-hover)"
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
          onRevealComplete={onRevealComplete}
        />
        <div className="flex h-6 shrink-0 items-center justify-end border-t-[0.5px] border-token-border px-2 text-[11px] text-(--color-codex-description)">
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
    (state.metadata?.sizeBytes ?? 0) >= WORKSPACE_TEXT_EDITABLE_MAX_BYTES;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {isLargeReadOnlySource ? (
        <div className="flex h-7 shrink-0 items-center border-b-[0.5px] border-token-border px-3 text-xs text-(--color-codex-description)">
          Large file opened read-only
        </div>
      ) : null}
      <LazySourceViewer
        value={state.content}
        ariaLabel={`Source preview for ${getWorkspaceFileName(state.path ?? "file")}`}
        filename={getWorkspaceFileName(state.path ?? "file")}
        language={resolveWorkspaceSourceLanguage(state.path ?? "")}
        sourceIdentity={getWorkspaceFileDomTabId(hostId, state.path ?? undefined)}
        lineNumbers
        wrap={wrap}
        revealLocation={revealLocation}
        onRevealComplete={onRevealComplete}
        className="min-h-0 flex-1 bg-surface"
      />
    </div>
  );
}

/** Decides what the body shows once metadata is known, before any content is read. */
function resolveWorkspaceFileView({
  path,
  metadata,
  richView,
}: {
  path: string;
  metadata: NonNullable<WorkspaceFilePreviewState["metadata"]>;
  richView: boolean;
}): WorkspaceFileView {
  const input = { path, contentKind: metadata.contentKind };
  if (isWorkspaceFileTooLargeToPreview(metadata.sizeBytes)) {
    return {
      kind: "too-large",
      sizeBytes: metadata.sizeBytes ?? 0,
      limitBytes: WORKSPACE_FILE_PREVIEW_MAX_BYTES,
    };
  }
  if (resolveWorkspaceFileUnsupportedType(input) !== null) return { kind: "unsupported" };
  const previewKind = resolveWorkspaceFilePreviewKind(input);
  const richViewMode = resolveWorkspaceFileRichViewMode(input);
  if (
    previewKind !== null &&
    (richViewMode === "always" || (richViewMode === "toggle" && richView))
  ) {
    if (
      previewKind === "image" &&
      metadata.sizeBytes !== null &&
      metadata.sizeBytes > MAX_IMAGE_PREVIEW_BYTES
    ) {
      return {
        kind: "too-large",
        sizeBytes: metadata.sizeBytes,
        limitBytes: MAX_IMAGE_PREVIEW_BYTES,
      };
    }
    return { kind: "rich", previewKind };
  }
  if (metadata.sizeBytes !== null && metadata.sizeBytes > WORKSPACE_TEXT_LOAD_MAX_BYTES) {
    return {
      kind: "too-large",
      sizeBytes: metadata.sizeBytes,
      limitBytes: WORKSPACE_TEXT_LOAD_MAX_BYTES,
    };
  }
  return { kind: "source" };
}

export function WorkspaceFilesPanel({
  tab,
  activeSession,
  presentationOwnerId,
  project,
  onOpenFileTab,
  onUpdateTabState,
  onSearchInFiles,
}: WorkspaceFilesPanelProps) {
  const workspaceRoot = resolveWorkspaceRoot(tab, project);
  const fileReferenceRouter = useFileReferenceRouter();
  const { opener: preferredOpener } = useFileLinkOpener();
  const hostId = tab.config.hostId ?? "local";
  const localFile = hostId === "local";
  const selectedPath = tab.config.path ?? null;
  const cwd =
    tab.config.cwd?.trim() ||
    (activeSession?.thread?.executionHostId === hostId ? activeSession.thread.cwd?.trim() : null) ||
    null;
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
  const debouncedSearchQuery = useDebouncedValue(navigationState.searchQuery.trim(), 100);
  const search = useFileSearch({
    enabled: localFile && Boolean(workspaceRoot),
    query: debouncedSearchQuery,
    scope: workspaceRoot
      ? { hostId: hostId === "local" ? DEFAULT_CODEX_HOST_ID : hostId, roots: [workspaceRoot] }
      : null,
  });
  const searchPending =
    search.loading || debouncedSearchQuery !== navigationState.searchQuery.trim();
  const searchError = search.error;
  const searchPaths: WorkspaceFileTreePath[] = [];
  const searchDirectories = new Set<string>();
  for (const match of search.matches) {
    const segments = match.relativePath.split("/");
    for (let index = 1; index < segments.length; index += 1)
      searchDirectories.add(segments.slice(0, index).join("/"));
    if (match.kind === "directory") searchDirectories.add(match.relativePath);
    else searchPaths.push({ path: match.relativePath, kind: "file" });
  }
  searchPaths.unshift(
    ...Array.from(searchDirectories, (path) => ({ path, kind: "directory" as const })),
  );
  const persistedTabStateRef = useRef<WorkspaceFilesTabState>(initialTabStateRef.current);
  const [treeWidth, setTreeWidth] = useState(
    initialTabStateRef.current.treeWidth ?? WORKSPACE_TREE_DEFAULT_WIDTH,
  );
  const [treeVisible, setTreeVisible] = useState(initialTabStateRef.current.treeVisible ?? true);
  const revealLocation = initialTabStateRef.current.pendingReveal;
  // A file opened at a location starts in its source view, where the location is visible.
  const [richView, setRichView] = useState(
    initialTabStateRef.current.richView ?? revealLocation === undefined,
  );
  const [wordWrap, setWordWrap] = useState(initialTabStateRef.current.wordWrap ?? true);
  const [previewState, setPreviewState] = useState<WorkspaceFilePreviewState>(EMPTY_PREVIEW_STATE);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [documentSnapshot, setDocumentSnapshot] = useState<WorkspaceTextDocumentSnapshot | null>(
    null,
  );
  const documentControllerRef = useRef<WorkspaceTextDocumentController | null>(null);
  const onUpdateTabStateRef = useRef(onUpdateTabState);
  onUpdateTabStateRef.current = onUpdateTabState;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const readRichView = useEffectEvent(() => richView);
  const view =
    previewState.metadata?.isFile && previewState.path
      ? resolveWorkspaceFileView({
          path: previewState.path,
          metadata: previewState.metadata,
          richView,
        })
      : null;
  const fileInput = previewState.path
    ? { path: previewState.path, contentKind: previewState.metadata?.contentKind }
    : null;
  const richViewMode = fileInput ? resolveWorkspaceFileRichViewMode(fileInput) : "none";
  const loadedPreviewKind = fileInput ? resolveWorkspaceFilePreviewKind(fileInput) : null;
  const showsSource = view?.kind === "source";
  const showsText =
    previewState.status === "loaded" &&
    (showsSource || (view?.kind === "rich" && view.previewKind === "markdown"));

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
    () => (localFile && workspaceRoot ? [...expandedPaths].sort() : []),
    [expandedPaths, localFile, workspaceRoot],
  );
  const directoryQueries = useQueries({
    queries: directoryPaths.map((directoryPath) =>
      workspaceDirectoryQueryOptions({
        hostId: "local",
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

  const repositoryQuery = useQuery({
    ...createGitWorkerQuery({
      method: "stable-metadata",
      params: { cwd: selectedPath ? parentDirectory(selectedPath) : (workspaceRoot ?? "") },
    }),
    enabled: localFile && Boolean(selectedPath ?? workspaceRoot),
  });
  const repoRoot = repositoryQuery.data?.isGitRepository ? repositoryQuery.data.root : null;
  const pathVariants = selectedPath
    ? resolveWorkspaceFilePathVariants({
        path: selectedPath,
        projectRoot: workspaceRoot,
        repoRoot,
      })
    : null;
  const availableOpenersQuery = useQuery({
    queryKey: ["workspace-files", "available-file-link-openers"],
    queryFn: listAvailableFileLinkOpeners,
    enabled: localFile,
    staleTime: 5 * 60_000,
  });

  const persistTabState = useCallback((state: WorkspaceFilesTabState) => {
    persistedTabStateRef.current = state;
    onUpdateTabStateRef.current?.(state);
  }, []);

  const handleRevealComplete = useCallback(
    (location: NonNullable<WorkspaceFilesTabState["pendingReveal"]>) => {
      if (persistedTabStateRef.current.pendingReveal !== location) return;
      const nextState = { ...persistedTabStateRef.current };
      delete nextState.pendingReveal;
      persistTabState(nextState);
    },
    [persistTabState],
  );

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setTreeWidth((current) => clampWorkspaceTreeWidth(current, entry.contentRect.width));
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!directoryError) return;
    toast.danger(directoryError instanceof Error ? directoryError.message : "Unable to load files");
  }, [directoryError]);

  const refreshDirectories = useCallback(() => {
    if (!localFile || !workspaceRoot) return;
    for (const directoryPath of directoryPaths) {
      void queryClient.invalidateQueries({
        queryKey: workspaceDirectoryQueryOptions({
          hostId: "local",
          workspaceRoot,
          directoryPath,
          includeHidden: true,
        }).queryKey,
      });
    }
  }, [directoryPaths, localFile, queryClient, workspaceRoot]);

  const refreshFiles = useCallback(() => {
    refreshDirectories();
    if (!localFile && selectedPath) setPreviewRevision((current) => current + 1);
  }, [localFile, refreshDirectories, selectedPath]);

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
        const metadata = await queryClient.fetchQuery({
          ...workspaceFileMetadataQueryOptions({
            hostId,
            path: selectedPath,
            contentSampleByteLimit: WORKSPACE_FILE_CONTENT_SAMPLE_BYTES,
            contentSampleMaxFileBytes: WORKSPACE_FILE_PREVIEW_MAX_BYTES,
          }),
          ...(!localFile ? { staleTime: 0 } : {}),
        });
        if (cancelled) return;
        const settle = (patch: Partial<WorkspaceFilePreviewState>) =>
          setPreviewState({ ...EMPTY_PREVIEW_STATE, path: selectedPath, metadata, ...patch });
        if (!metadata.isFile) {
          settle({ status: "unsupported", message: "Directories open from the file tree." });
          return;
        }

        const nextView = resolveWorkspaceFileView({
          path: selectedPath,
          metadata,
          richView: readRichView(),
        });
        if (nextView.kind === "too-large" || nextView.kind === "unsupported") {
          settle({ status: "loaded" });
          return;
        }
        const previewKind = resolveWorkspaceFilePreviewKind({
          path: selectedPath,
          contentKind: metadata.contentKind,
        });
        // Media streams from its own element; it never loads through this reader.
        if (previewKind === "audio" || previewKind === "video") {
          settle({ status: "loaded" });
          return;
        }
        if (nextView.kind === "rich" && (previewKind === "image" || previewKind === "pdf")) {
          const binary = await queryClient.fetchQuery({
            ...workspaceFileBinaryQueryOptions({ hostId, path: selectedPath }),
            ...(!localFile ? { staleTime: 0 } : {}),
          });
          if (!binary.contentsBase64) throw new Error("Unable to read binary file.");
          const nextBinaryUrl =
            previewKind === "pdf"
              ? `data:application/pdf;base64,${binary.contentsBase64}`
              : buildBinaryObjectUrl(binary.contentsBase64, binary.mimeType);
          if (cancelled) {
            if (previewKind === "image") URL.revokeObjectURL(nextBinaryUrl);
            return;
          }
          if (previewKind === "image") binaryObjectUrl = nextBinaryUrl;
          settle({ status: "loaded", binaryUrl: nextBinaryUrl });
          return;
        }

        const text = await queryClient.fetchQuery({
          ...workspaceFileTextQueryOptions({
            hostId,
            path: selectedPath,
            maxBytes: WORKSPACE_TEXT_LOAD_MAX_BYTES,
          }),
          ...(!localFile ? { staleTime: 0 } : {}),
        });
        if (cancelled) return;
        const editable =
          metadata.sizeBytes !== null &&
          metadata.sizeBytes < WORKSPACE_TEXT_EDITABLE_MAX_BYTES &&
          (previewKind === "markdown" || resolveWorkspaceSourceLanguage(selectedPath) !== null);
        if (localFile && editable) {
          loadedController = new WorkspaceTextDocumentController(
            {
              path: selectedPath,
              content: text.contents,
              mtimeMs: metadata.mtimeMs,
              draft: persistedTabStateRef.current.draft,
            },
            {
              write: async (path, content, expectedMtimeMs) =>
                await writeWorkspaceFile({
                  hostId: "local",
                  path,
                  content,
                  expectedMtimeMs,
                }),
              readDisk: async (path) => {
                const nextMetadata = await readWorkspaceFileMetadata({
                  hostId,
                  path,
                  contentSampleByteLimit: WORKSPACE_FILE_CONTENT_SAMPLE_BYTES,
                  contentSampleMaxFileBytes: WORKSPACE_TEXT_LOAD_MAX_BYTES,
                });
                const nextText = await readWorkspaceFileText({
                  hostId,
                  path,
                  maxBytes: WORKSPACE_TEXT_LOAD_MAX_BYTES,
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
          void startWorkspaceFileWatch({
            hostId: "local",
            path: selectedPath,
          })
            .then((result) => {
              if (cancelled) {
                void stopWorkspaceFileWatch({
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
        settle({ status: "loaded", content: text.contents });
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
        void stopWorkspaceFileWatch({
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
  }, [hostId, localFile, persistTabState, previewRevision, queryClient, selectedPath, tab.id]);

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
  const treePaths = navigationState.searchQuery.trim() ? (searchPaths ?? []) : browsePaths;

  const openTreeEntry = useCallback(
    async (path: string, mode: "preview" | "durable") => {
      if (!workspaceRoot) return;
      await onOpenFileTab({
        hostId,
        path: resolveWorkspaceTreeFilePath(workspaceRoot, path),
        title: getWorkspaceFileName(path),
        panelId: tab.panelId,
        mode,
      });
    },
    [hostId, onOpenFileTab, tab.panelId, workspaceRoot],
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
    (opener: FileLinkOpenerId) => {
      if (!localFile || !selectedPath) return;
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
            hostId,
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
    [cwd, fileReferenceRouter, hostId, localFile, revealLocation, selectedPath, workspaceRoot],
  );

  const openWithDefaultApplication = useCallback(() => {
    if (!localFile || !selectedPath) return;
    void openPathWithDefaultApplication(selectedPath)
      .then((opened) => {
        if (!opened) toast.danger("Unable to open file externally");
      })
      .catch(() => toast.danger("Unable to open file externally"));
  }, [localFile, selectedPath]);

  const openExternalUrl = useCallback((url: string) => {
    void openUrlExternally(url).catch(() => {
      toast.danger("Unable to open external link");
    });
  }, []);

  const saveCopy = useCallback(() => {
    if (!localFile || !selectedPath) return;
    void saveWorkspaceFileCopy({ hostId: "local", path: selectedPath }).catch(() =>
      toast.danger("Unable to save a copy of this file"),
    );
  }, [localFile, selectedPath]);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = treeWidth;
      let latestWidth = startWidth;
      const bodyWidth = bodyRef.current?.getBoundingClientRect().width ?? 0;

      const onMove = (moveEvent: PointerEvent) => {
        const nextWidth = clampWorkspaceTreeWidth(
          startWidth - (moveEvent.clientX - startX),
          bodyWidth,
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
      const bodyWidth = bodyRef.current?.getBoundingClientRect().width ?? 0;
      setTreeWidth((current) => {
        const next = clampWorkspaceTreeWidth(current + delta, bodyWidth);
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

  const toggleRichView = useCallback(() => {
    setRichView((current) => {
      const next = !current;
      persistTabState({
        ...persistedTabStateRef.current,
        richView: next,
      });
      return next;
    });
    // An image's source and its bytes load separately, so switching an SVG's view reloads it.
    if (loadedPreviewKind === "image") setPreviewRevision((current) => current + 1);
  }, [loadedPreviewKind, persistTabState]);

  const copyText = useCallback((value: string, failure: string) => {
    void writeTextToClipboard(value).then((copied) => {
      if (!copied) toast.danger(failure);
    });
  }, []);

  const openPreviewFileReference = useCallback<FileReferenceRouterPort["openWorkspaceFileTab"]>(
    async (input) => (await onOpenFileTab({ ...input, mode: input.mode ?? "preview" })) !== false,
    [onOpenFileTab],
  );

  if (!workspaceRoot && !selectedPath) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-surface text-center text-sm semantic-text-secondary">
        <WorkspaceFileOpenFileState />
      </div>
    );
  }

  const fileContent = documentSnapshot?.content ?? previewState.content;
  const options: WorkspaceFileViewerOption[] = [];
  if (selectedPath) {
    options.push({
      id: "copy-path",
      label: "Copy path",
      icon: <CopyLightIcon />,
      onSelect: () => copyText(pathVariants?.absolute ?? selectedPath, "Unable to copy path"),
    });
    const relativePath = pathVariants?.repoRelative ?? pathVariants?.projectRelative ?? null;
    if (relativePath) {
      options.push({
        id: "copy-relative-path",
        label: "Copy relative path",
        icon: <CopyLightIcon />,
        onSelect: () => copyText(relativePath, "Unable to copy path"),
      });
    }
  }
  if (showsText && fileContent) {
    options.push({
      id: "copy-contents",
      label: "Copy file contents",
      icon: <CopyLightIcon />,
      onSelect: () => copyText(fileContent, "Unable to copy contents"),
    });
  }
  if (richViewMode === "toggle" && previewState.status === "loaded") {
    options.push({
      id: "rich-view",
      label: richView ? "Disable rich view" : "Enable rich view",
      onSelect: toggleRichView,
    });
  }
  if (showsSource && previewState.status === "loaded") {
    options.push({
      id: "word-wrap",
      label: wordWrap ? "Disable word wrap" : "Enable word wrap",
      onSelect: toggleWordWrap,
    });
  }
  if (workspaceRoot || !localFile) {
    options.push({ id: "refresh", label: "Refresh files", onSelect: refreshFiles });
  }

  // Documents and media open with the system's app for their type; text opens in the chosen editor.
  const nativeMode =
    view?.kind === "unsupported" || (view?.kind === "rich" && view.previewKind !== "markdown");
  const editorTargets: WorkspaceFileOpenTarget[] = FILE_LINK_OPENER_OPTIONS.filter(
    (option) =>
      option.id !== "fileManager" && (availableOpenersQuery.data ?? []).includes(option.id),
  ).map((option) => ({
    id: option.id,
    label: option.label,
    iconUrl: FILE_LINK_OPENER_ICON_URLS[option.id],
    open: () => openExternal(option.id),
  }));
  const preferredTarget =
    editorTargets.find((target) => target.id === preferredOpener) ?? editorTargets[0] ?? null;
  const openControl: WorkspaceFileOpenControl | null =
    localFile && selectedPath
      ? {
          primary: nativeMode ? null : preferredTarget,
          onOpenDefault: openWithDefaultApplication,
          targets: editorTargets,
          onRevealInFolder: () => openExternal("fileManager"),
          onOpenGitHub: null,
          onSaveAs: saveCopy,
        }
      : null;

  return (
    <FileReferenceRouterProvider
      openWorkspaceFileTab={openPreviewFileReference}
      workspaceRoot={workspaceRoot ?? cwd}
    >
      <FileReferenceHostProvider hostId={hostId} workspaceRoot={workspaceRoot ?? cwd}>
        <div
          className="flex h-full min-h-0 flex-col bg-surface"
          data-workspace-files-tab-id={getWorkspaceFileDomTabId(
            hostId,
            selectedPath ?? workspaceRoot ?? undefined,
          )}
          data-workspace-files-session-id={presentationOwnerId ?? activeSession?.id ?? "unassigned"}
        >
          <div className="relative z-10 flex min-w-0 shrink-0" data-tab-preview-pin-exempt="true">
            <WorkspaceFileViewerHeader
              breadcrumb={resolveWorkspaceFileBreadcrumb({
                cwd,
                path: selectedPath,
                workspaceRoot,
              })}
              path={selectedPath}
              pathVariants={pathVariants}
              gitHubUrl={null}
              onOpenUrl={openExternalUrl}
              onSearchInFiles={localFile && workspaceRoot ? (onSearchInFiles ?? null) : null}
              options={options}
              open={openControl}
              fileTree={
                localFile && workspaceRoot ? { visible: treeVisible, onToggle: toggleTree } : null
              }
            />
          </div>
          <div ref={bodyRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            <div className="flex h-full min-h-0 flex-1">
              <div className="min-w-0 flex-1">
                <WorkspaceFilePreview
                  hostId={hostId}
                  state={previewState}
                  view={view}
                  document={documentSnapshot}
                  workspaceRoot={workspaceRoot}
                  onOpenExternalLink={openExternalUrl}
                  onEdit={editDocument}
                  onUseDisk={useDiskVersion}
                  onKeepLocal={keepLocalChanges}
                  onRetrySave={retrySave}
                  wrap={wordWrap}
                  revealLocation={revealLocation}
                  onRevealComplete={handleRevealComplete}
                  resourceRevision={previewRevision}
                />
              </div>

              {localFile && workspaceRoot && treeVisible ? (
                <aside
                  className="relative flex h-full shrink-0 border-l border-default"
                  style={
                    {
                      width: treeWidth,
                      maxWidth: `${WORKSPACE_TREE_MAX_RATIO * 100}%`,
                    } satisfies CSSProperties
                  }
                  data-tab-preview-pin-exempt="true"
                >
                  <div className="group/panel-resizer absolute top-0 bottom-0 left-0 z-40 flex w-4 -translate-x-2 touch-none select-none">
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize file tree"
                      aria-valuemin={WORKSPACE_TREE_MIN_WIDTH}
                      aria-valuemax={Math.max(
                        WORKSPACE_TREE_MIN_WIDTH,
                        Math.round(
                          (bodyRef.current?.getBoundingClientRect().width ?? 0) *
                            WORKSPACE_TREE_MAX_RATIO,
                        ),
                      )}
                      aria-valuenow={Math.round(treeWidth)}
                      tabIndex={0}
                      className="no-drag absolute inset-0 flex cursor-col-resize focus:outline-none active:cursor-col-resize"
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
                      <div className="pointer-events-none m-auto h-full w-px bg-gradient-to-b from-transparent via-text/25 to-transparent opacity-0 group-hover/panel-resizer:opacity-100 group-active/panel-resizer:opacity-100 group-has-focus-visible/panel-resizer:opacity-100" />
                    </div>
                  </div>
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-px">
                      <div className="min-w-0 flex-1">
                        <FileTreeFilter
                          value={navigationState.searchQuery}
                          onChange={updateFilterQuery}
                        />
                      </div>
                    </div>
                    <div className="min-h-0 flex-1 px-1">
                      {treePaths.length > 0 ? (
                        <WorkspaceFileTree
                          workspaceRoot={workspaceRoot}
                          threadId={activeSession?.thread?.threadId}
                          paths={treePaths}
                          expandedPaths={expandedPaths}
                          selectedPath={selectedTreePath}
                          searchQuery={debouncedSearchQuery}
                          revealSelectedPath
                          initialScrollTop={navigationState.scrollTop}
                          onOpen={openTreeEntry}
                          onStateChange={updateTreeState}
                        />
                      ) : (
                        <div className="px-2 py-2 text-sm text-tertiary">
                          {searchError ??
                            (searchPending
                              ? "Searching files…"
                              : rootDirectoryPending
                                ? "Loading directory entries…"
                                : directoryError
                                  ? "Unable to load files"
                                  : navigationState.searchQuery.trim()
                                    ? "No matching files"
                                    : "No files in this folder")}
                        </div>
                      )}
                    </div>
                  </div>
                </aside>
              ) : null}
            </div>
          </div>
        </div>
      </FileReferenceHostProvider>
    </FileReferenceRouterProvider>
  );
}
