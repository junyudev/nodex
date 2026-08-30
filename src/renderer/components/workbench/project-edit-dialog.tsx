import {
  useId,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { CloseIcon, FolderIcon, FolderPlusIcon } from "@/components/shared/icons";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import {
  DEFAULT_PROJECT_APPEARANCE,
  type ProjectAppearance,
} from "../../../shared/project-appearance";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexTooltip } from "@/components/ui/tooltip";
import { CoreApiError } from "@/lib/core-api-error";
import { pickProjectSourceRoots } from "@/lib/workbench-shell-operations";
import {
  dedupeSourceRoots,
  makeSourceRootPrimary,
  sourceRootDisplayName,
} from "@/lib/project-sources";
import {
  isPlausiblePageKeyPrefixDraft,
  normalizePageKeyPrefixInput,
} from "../../../shared/page-key";
import type { Project, ProjectLifecycleMutationResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  projectPageKeyEditorModel,
  type ProjectPageKeySaveFailure,
} from "@/lib/project-page-key-editor-model";
import { queryKeys } from "@/lib/query-keys";
import {
  usePageKeyPrefixPreview,
  type PageKeyPrefixPreviewReader,
} from "@/lib/use-page-key-prefix-preview";
import {
  DatabasePageKeyRuntimeError,
  previewDatabasePageKeyPrefix,
  readDatabasePageKeyNamespace,
  renameDatabasePageKeyPrefix,
  type DatabasePageKeyNamespaceAuthority,
} from "@/lib/database-page-key-runtime";
import { ProjectMarkerPicker } from "./project-marker-picker";
import { ProjectRemoveDialog } from "./project-remove-dialog";

const PRIMARY_SOURCE_TOOLTIP =
  "Nodex will run in this folder and look inside it for AGENTS.md and skills";

export interface ProjectDialogSubmitInput {
  appearance: ProjectAppearance;
  name: string;
  sources: string[];
}

export interface DatabasePageKeyAuthority {
  readonly previewPrefix: PageKeyPrefixPreviewReader;
  readonly readNamespace: (
    projectId: string,
    databaseId: string,
  ) => Promise<DatabasePageKeyNamespaceAuthority>;
  readonly renamePrefix: typeof renameDatabasePageKeyPrefix;
}

const DEFAULT_PAGE_KEY_AUTHORITY: DatabasePageKeyAuthority = {
  previewPrefix: previewDatabasePageKeyPrefix,
  readNamespace: async (projectId, databaseId) =>
    await readDatabasePageKeyNamespace({ projectId, databaseId }),
  renamePrefix: renameDatabasePageKeyPrefix,
};

function collectDroppedFolderPaths(dataTransfer: DataTransfer): string[] {
  const getPathForFile = window.api?.getPathForFile;
  const items = Array.from(dataTransfer.items);
  const paths: string[] = [];
  Array.from(dataTransfer.files).forEach((file, index) => {
    const entry = items[index]?.webkitGetAsEntry?.();
    if (entry != null && !entry.isDirectory) return;
    const path = getPathForFile?.(file) ?? "";
    if (path) paths.push(path);
  });
  return paths;
}

function ProjectSourceRow({
  root,
  isPrimary,
  animateReorder,
  onMakePrimary,
  onRemove,
}: {
  root: string;
  isPrimary: boolean;
  animateReorder: boolean;
  onMakePrimary?: (root: string) => void;
  onRemove: (root: string) => void;
}) {
  const displayName = sourceRootDisplayName(root);

  return (
    <motion.div
      layout="position"
      transition={animateReorder ? { duration: 0.15, ease: [0.19, 1, 0.22, 1] } : { duration: 0 }}
      className="group flex h-12 min-w-0 items-center gap-2 px-3 text-left"
    >
      <NodexTooltip tooltipContent={root}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FolderIcon className="icon-sm shrink-0 text-token-description-foreground" />
          <span className="min-w-0 truncate text-sm text-token-text-primary">{displayName}</span>
        </div>
      </NodexTooltip>
      {isPrimary ? (
        <NodexTooltip tooltipContent={PRIMARY_SOURCE_TOOLTIP}>
          <span className="flex h-token-button-composer cursor-default items-center rounded-lg border border-token-border-default bg-transparent px-2.5 py-0 text-sm leading-[18px] font-medium text-token-text-secondary">
            Primary
          </span>
        </NodexTooltip>
      ) : null}
      {onMakePrimary ? (
        <NodexButton
          variant="secondary"
          size="composer"
          type="button"
          className="text-sm opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
          aria-label={`Make ${displayName} primary`}
          onClick={() => onMakePrimary(root)}
        >
          Make primary
        </NodexButton>
      ) : null}
      <button
        type="button"
        className="flex size-6 shrink-0 cursor-interaction items-center justify-center rounded text-token-text-tertiary hover:bg-token-list-hover-background hover:text-token-foreground focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none"
        aria-label={`Remove ${displayName}`}
        onClick={() => onRemove(root)}
      >
        <CloseIcon className="icon-xs" />
      </button>
    </motion.div>
  );
}

export function ProjectSourcesEditor({
  sources,
  setSources,
}: {
  sources: string[];
  setSources: Dispatch<SetStateAction<string[]>>;
}) {
  const [draggingOver, setDraggingOver] = useState(false);
  const [animateReorder, setAnimateReorder] = useState(false);
  const reducedMotion = useResolvedReducedMotion();

  const appendSources = (picked: string[]) => {
    setDraggingOver(false);
    if (picked.length === 0) return;
    setAnimateReorder(false);
    setSources((previous) => dedupeSourceRoots([...previous, ...picked]));
  };

  const addFolder = async () => {
    const picked = await pickProjectSourceRoots();
    appendSources(picked);
  };

  const makePrimary = (root: string) => {
    setAnimateReorder(true);
    setSources((previous) => makeSourceRootPrimary(previous, root));
  };

  const removeSource = (root: string) => {
    setAnimateReorder(false);
    setSources((previous) => previous.filter((candidate) => candidate !== root));
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    appendSources(collectDroppedFolderPaths(event.dataTransfer));
  };

  const empty = sources.length === 0;
  const primaryRoot = sources[0] ?? null;

  return (
    <NodexDialogBody className="gap-2">
      <span className="text-sm font-medium text-token-text-primary select-none">
        Source folders
      </span>
      <motion.div
        layoutScroll
        onDragEnter={(event) => {
          event.preventDefault();
          setDraggingOver(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDraggingOver(true);
        }}
        onDragLeave={() => setDraggingOver(false)}
        onDrop={handleDrop}
        className={cn(
          "max-h-[min(22.5rem,calc(100dvh/var(--codex-window-zoom,1)-20rem))] divide-y divide-token-border overflow-y-auto rounded-lg border bg-token-input-background",
          draggingOver ? "border-dashed border-token-focus-border" : "border-token-border",
        )}
      >
        {sources.map((root) => (
          <ProjectSourceRow
            key={root}
            root={root}
            isPrimary={root === primaryRoot && sources.length > 1}
            animateReorder={animateReorder && !reducedMotion}
            onMakePrimary={root === primaryRoot ? undefined : makePrimary}
            onRemove={removeSource}
          />
        ))}
        <button
          type="button"
          className={cn(
            "flex w-full cursor-interaction items-center text-sm text-token-text-primary hover:bg-token-list-hover-background focus-visible:bg-token-list-hover-background focus-visible:outline-none",
            empty
              ? "h-24 flex-col justify-center gap-1 p-3 text-center"
              : "h-12 gap-2 px-3 text-left",
          )}
          aria-label={empty ? "Choose source folders" : undefined}
          onClick={() => void addFolder()}
        >
          <FolderPlusIcon className="icon-sm text-token-description-foreground" />
          {empty ? "Add folders Nodex can read and edit" : "Add folder"}
        </button>
      </motion.div>
    </NodexDialogBody>
  );
}

function ProjectEditorForm({
  mode,
  projectId,
  databaseId,
  title,
  submitLabel,
  saveErrorMessage,
  initialName,
  initialAppearance,
  initialSources,
  onSubmit,
  onClose,
  onRemoveProject,
  pageKeyAuthority = DEFAULT_PAGE_KEY_AUTHORITY,
}: {
  mode: "create" | "edit";
  projectId?: string;
  databaseId?: string;
  title: string;
  submitLabel: string;
  saveErrorMessage: string;
  initialName: string;
  initialAppearance: ProjectAppearance;
  initialSources: readonly string[];
  onSubmit: (input: ProjectDialogSubmitInput) => Promise<void>;
  onClose: () => void;
  onRemoveProject?: () => void;
  pageKeyAuthority?: DatabasePageKeyAuthority;
}) {
  const queryClient = useQueryClient();
  const nameInputId = useId();
  const pageKeyInputId = useId();
  const [name, setName] = useState(initialName);
  const [pageKeyPrefix, setPageKeyPrefix] = useState("");
  const [pageKeyPrefixIsManual, setPageKeyPrefixIsManual] = useState(false);
  const [pageKeyExpanded, setPageKeyExpanded] = useState(false);
  const [appearance, setAppearance] = useState(initialAppearance);
  const [sources, setSources] = useState<string[]>(() => dedupeSourceRoots(initialSources));
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<ProjectPageKeySaveFailure | null>(null);
  const [metadataCommitted, setMetadataCommitted] = useState(false);
  const readNamespaceRef = useRef(pageKeyAuthority.readNamespace);
  readNamespaceRef.current = pageKeyAuthority.readNamespace;

  // The reader is an injectable transport, not part of the server-state identity.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  const settingsQuery = useQuery({
    queryKey: queryKeys.pageKeys.namespace(databaseId ?? "create"),
    queryFn: async () => {
      if (!projectId || !databaseId) {
        throw new Error("Project and Database identities are required for Page-key settings");
      }
      return await readNamespaceRef.current(projectId, databaseId);
    },
    enabled:
      mode === "edit" && pageKeyExpanded && projectId !== undefined && databaseId !== undefined,
    staleTime: 0,
    retry: false,
  });
  const settings = settingsQuery.data?.namespace;
  const authorityCurrentPrefix = settings?.currentPrefix;
  const preview = usePageKeyPrefixPreview({
    enabled: mode === "edit" && pageKeyExpanded && settings !== undefined,
    projectId,
    databaseId,
    nameHint: name,
    readPreview: pageKeyAuthority.previewPrefix,
    requestedPrefix: pageKeyPrefixIsManual ? pageKeyPrefix : authorityCurrentPrefix,
  });
  const effectiveDraftPrefix = pageKeyPrefixIsManual
    ? pageKeyPrefix
    : "prefix" in preview && preview.prefix
      ? preview.prefix
      : (authorityCurrentPrefix ?? "");
  const settingsStatus = !pageKeyExpanded
    ? "idle"
    : settingsQuery.isPending
      ? "loading"
      : settingsQuery.error
        ? "error"
        : "ready";
  const pageKeyModel =
    mode === "edit"
      ? projectPageKeyEditorModel({
          expanded: pageKeyExpanded,
          draftPrefix: effectiveDraftPrefix,
          currentPrefix: authorityCurrentPrefix,
          preview,
          settings,
          settingsStatus,
          saveFailure,
        })
      : null;
  const canSubmit = pageKeyModel?.canSubmit ?? true;
  const formError = pageKeyModel?.formError ?? saveFailure?.message ?? null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !canSubmit) return;
    setSaving(true);
    setSaveFailure(null);
    let detailsWereCommitted = metadataCommitted;
    try {
      if (!metadataCommitted) {
        await onSubmit({
          appearance,
          name,
          sources,
        });
        detailsWereCommitted = true;
        setMetadataCommitted(true);
      }
      const shouldRename =
        pageKeyModel !== null && pageKeyExpanded && pageKeyModel.prefix !== authorityCurrentPrefix;
      if (shouldRename) {
        if (!projectId || !databaseId || !settingsQuery.data) {
          throw new Error("Page-key namespace authority is not ready");
        }
        await pageKeyAuthority.renamePrefix({
          projectId,
          databaseId,
          storeEpoch: settingsQuery.data.storeEpoch,
          expectedRevision: settingsQuery.data.namespace.revision,
          prefix: pageKeyModel.prefix,
        });
      }
      onClose();
    } catch (error) {
      setSaving(false);
      const failure =
        error instanceof CoreApiError || error instanceof DatabasePageKeyRuntimeError
          ? {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              detailsSaved: detailsWereCommitted,
            }
          : {
              code: "core_unavailable",
              message: error instanceof Error ? error.message : saveErrorMessage,
              retryable: true,
              detailsSaved: detailsWereCommitted,
            };
      setSaveFailure(failure);
      if (
        mode === "edit" &&
        (failure.code === "identity_conflict" || failure.code === "revision_conflict")
      ) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.pageKeys.namespace(databaseId ?? "create"),
        });
        if (mode === "edit") await settingsQuery.refetch();
      }
    }
  };

  return (
    <NodexDialogForm onSubmit={(event) => void submit(event)}>
      <NodexDialogHeader>
        <NodexDialogTitle>{title}</NodexDialogTitle>
      </NodexDialogHeader>
      <NodexDialogBody className="gap-2">
        <div className="flex flex-col gap-2">
          <label htmlFor={nameInputId} className="sr-only">
            Name
          </label>
          <div className="flex h-10 shrink-0 items-center gap-2 overflow-hidden rounded-xl border border-token-border bg-token-input-background pr-3 pl-0 focus-within:border-token-focus-border">
            <div className="flex h-full w-10 shrink-0 items-center justify-center border-r border-token-border">
              <ProjectMarkerPicker
                appearance={appearance}
                onAppearanceChange={(nextAppearance) => {
                  setAppearance(nextAppearance);
                  setMetadataCommitted(false);
                }}
                projectName={name.trim() || "Untitled project"}
                pending={saving}
                headerLabel={name.trim() || "Untitled project"}
                showDividers={false}
                buttonClassName="h-full w-full rounded-none"
              />
            </div>
            <input
              id={nameInputId}
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-sm text-token-input-foreground outline-none placeholder:text-token-description-foreground"
              value={name}
              onChange={(event) => {
                const nextName = event.target.value;
                setName(nextName);
                setMetadataCommitted(false);
                setSaveFailure(null);
              }}
              placeholder="Project name"
              aria-label="Project name"
            />
          </div>
          {pageKeyModel === null ? null : !pageKeyExpanded ? (
            <div className="flex min-h-8 items-center justify-between gap-3 px-1">
              <span
                className="min-w-0 truncate text-xs tabular-nums text-token-description-foreground"
                aria-live="polite"
              >
                Page key settings
              </span>
              <button
                type="button"
                className="shrink-0 cursor-interaction text-xs font-medium text-token-text-secondary hover:text-token-text-primary focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none"
                onClick={() => {
                  setPageKeyExpanded(true);
                  setSaveFailure(null);
                }}
              >
                Change
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 px-1">
              <div className="flex h-10 shrink-0 items-center gap-2 rounded-xl border border-token-border bg-token-input-background px-3 focus-within:border-token-focus-border">
                <label
                  htmlFor={pageKeyInputId}
                  className="shrink-0 text-xs text-token-text-secondary"
                >
                  Page key prefix
                </label>
                <input
                  id={pageKeyInputId}
                  className="min-w-0 flex-1 bg-transparent text-right text-sm tabular-nums text-token-input-foreground uppercase outline-none placeholder:text-token-description-foreground"
                  value={effectiveDraftPrefix}
                  maxLength={8}
                  spellCheck={false}
                  aria-invalid={
                    !isPlausiblePageKeyPrefixDraft(effectiveDraftPrefix) ||
                    preview.kind === "reserved" ||
                    pageKeyModel.prefixError !== null
                  }
                  onChange={(event) => {
                    setPageKeyPrefixIsManual(true);
                    setPageKeyPrefix(event.target.value.toUpperCase());
                    setSaveFailure(null);
                  }}
                  onBlur={() => {
                    setPageKeyPrefix((value) => normalizePageKeyPrefixInput(value));
                  }}
                />
              </div>
              <div className="flex min-h-5 items-start justify-between gap-3">
                <p
                  className={cn(
                    "text-xs",
                    preview.kind === "reserved" || pageKeyModel.prefixError
                      ? "text-token-error-foreground"
                      : "text-token-description-foreground",
                  )}
                  aria-live="polite"
                >
                  {pageKeyModel.prefixError ?? pageKeyModel.statusText}
                </p>
                {pageKeyModel.suggestedPrefix ? (
                  <button
                    type="button"
                    className="shrink-0 cursor-interaction text-xs font-medium text-token-text-secondary hover:text-token-text-primary focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none"
                    onClick={() => {
                      setPageKeyPrefixIsManual(true);
                      setPageKeyPrefix(pageKeyModel.suggestedPrefix ?? effectiveDraftPrefix);
                      setSaveFailure(null);
                    }}
                  >
                    Use {pageKeyModel.suggestedPrefix}
                  </button>
                ) : null}
              </div>
              {pageKeyModel.impactText ? (
                <p className="text-xs leading-5 text-token-description-foreground">
                  {pageKeyModel.impactText}
                </p>
              ) : null}
              {pageKeyModel.history.length > 0 ? (
                <div className="divide-y divide-token-border-subtle border-y border-token-border-subtle">
                  {pageKeyModel.history.map((history) => (
                    <div
                      key={history.prefix}
                      className="flex items-baseline justify-between gap-3 py-1.5 text-xs"
                    >
                      <span className="text-token-text-secondary">
                        Previous prefix · {history.prefix}
                      </span>
                      <span className="text-right tabular-nums text-token-description-foreground">
                        {history.detail}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
          {formError ? (
            <p className="px-1 text-xs leading-5 text-token-error-foreground" role="alert">
              {formError}
            </p>
          ) : null}
        </div>
      </NodexDialogBody>
      <ProjectSourcesEditor
        sources={sources}
        setSources={(next) => {
          setMetadataCommitted(false);
          setSources(next);
        }}
      />
      <NodexDialogBody className="mt-auto !pt-5">
        <div className="flex w-full items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {onRemoveProject ? (
              <NodexDialogAction
                tone="danger"
                type="button"
                disabled={saving}
                onClick={onRemoveProject}
              >
                Remove project
              </NodexDialogAction>
            ) : null}
          </div>
          <div className="flex w-auto items-center justify-end gap-3">
            <NodexDialogAction type="button" disabled={saving} onClick={onClose}>
              Cancel
            </NodexDialogAction>
            <NodexDialogAction tone="primary" type="submit" disabled={saving || !canSubmit}>
              {submitLabel}
            </NodexDialogAction>
          </div>
        </div>
      </NodexDialogBody>
    </NodexDialogForm>
  );
}

function ProjectDialogShell({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent
        className="max-h-[calc(100dvh/var(--codex-window-zoom,1)-2rem)]"
        aria-describedby={undefined}
      >
        {children}
      </NodexDialogContent>
    </NodexDialog>
  );
}

interface ProjectEditDialogProps {
  readonly project: Project;
  readonly onClose: () => void;
  readonly onSubmit: (input: ProjectDialogSubmitInput) => Promise<void>;
  readonly pageKeyAuthority?: DatabasePageKeyAuthority;
  readonly onArchiveProject?: (projectId: string) => Promise<ProjectLifecycleMutationResult>;
}

function ProjectEditDialogContent({
  project,
  onClose,
  onSubmit,
  onArchiveProject,
  pageKeyAuthority = DEFAULT_PAGE_KEY_AUTHORITY,
}: ProjectEditDialogProps) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const initialSources = project.sources
    .map((source) => source.root)
    .filter((root) => root.trim().length > 0);

  return (
    <>
      <ProjectDialogShell onClose={onClose}>
        <ProjectEditorForm
          mode="edit"
          projectId={project.id}
          databaseId={project.databaseId}
          title="Edit project"
          submitLabel="Save"
          saveErrorMessage="Failed to save project"
          initialName={project.name}
          initialAppearance={project.appearance}
          initialSources={initialSources}
          onSubmit={onSubmit}
          onClose={onClose}
          onRemoveProject={onArchiveProject ? () => setRemoveOpen(true) : undefined}
          pageKeyAuthority={pageKeyAuthority}
        />
      </ProjectDialogShell>
      {removeOpen && onArchiveProject ? (
        <ProjectRemoveDialog
          open
          project={project}
          onOpenChange={setRemoveOpen}
          onArchiveProject={async (projectId) => {
            const result = await onArchiveProject(projectId);
            if (result.kind === "updated") onClose();
            return result;
          }}
        />
      ) : null}
    </>
  );
}

export function ProjectEditDialog(props: ProjectEditDialogProps) {
  const sourceIdentity = props.project.sources
    .map((source) => source.root)
    .filter((root) => root.trim().length > 0)
    .join("\0");

  return (
    <ProjectEditDialogContent
      key={`${props.project.id}:${props.project.name}:${JSON.stringify(props.project.appearance)}:${sourceIdentity}`}
      {...props}
    />
  );
}

export function ProjectCreateDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: ProjectDialogSubmitInput) => Promise<void>;
}) {
  return (
    <ProjectDialogShell onClose={onClose}>
      <ProjectEditorForm
        mode="create"
        title="Create project"
        submitLabel="Create project"
        saveErrorMessage="Failed to create project"
        initialName=""
        initialAppearance={DEFAULT_PROJECT_APPEARANCE}
        initialSources={[]}
        onSubmit={onCreate}
        onClose={onClose}
      />
    </ProjectDialogShell>
  );
}
