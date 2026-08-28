import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { DatabasePropertyOption } from "../../../shared/database-kernel";
import { createCustomOptionId } from "../../../shared/database-identities";
import { MAX_PAGE_TITLE_LENGTH } from "../../../shared/page-limits";
import {
  ChevronRightIcon,
  CloseIcon,
  EstimateIcon,
  ExpandPanelIcon,
  PriorityIcon,
  RestorePanelIcon,
  TagIcon,
} from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogClose,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogForm,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexSwitch } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { PropertyOptionPicker } from "@/components/database/property-option-picker";
import { SemanticSelectPropertyEditor } from "@/components/database/semantic-property-editors";
import { usePropertyOptionRegistries } from "@/components/database/use-property-option-registries";
import { ProjectMarker } from "@/components/workbench/project-marker";
import { resolvePageCreatePropertyCapabilities } from "@/lib/page-create-capabilities";
import { resolvePageCreateDialogLayout } from "@/lib/page-create-dialog-layout";
import {
  buildPageCreateInput,
  capturePageCreateDraftSnapshot,
  createEmptyPageCreateDraftSnapshot,
  createPageCreateDescriptionDraft,
  pageCreateDraftSnapshotsEqual,
  type PageCreateDescriptionDraft,
  type PageCreateDraftSnapshot,
} from "@/lib/page-create-draft";
import { restorePageCreateFocus, type PageCreateOrigin } from "@/lib/page-create-focus";
import { createBoardPage } from "@/lib/board-page-create-command";
import { BOARD_PRIORITY_OPTIONS } from "@/lib/board-options";
import { StatusIcon } from "@/lib/status-presentation";
import { defaultDataSourcePropertyOptionColor } from "@/lib/data-source-property-options";
import { estimateOptions, type Estimate, type Priority, type WorkflowStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { appScope, useScopeHandle } from "@/lib/maitai";
import type { ModalCloseProps } from "@/lib/modal-registry";
import type { PageCreateTarget } from "@/lib/page-create-target-registry";
import type { PageCreateSeed } from "@/lib/page-create-selection";
import { restorePageCreateDraft } from "@/lib/page-create-workflow";
import type { NfmEditorBoundaryHandle } from "./editor/nfm-editor";
import { PageCreateDescriptionEditor } from "./page-create-description-editor";

interface PageCreateDialogPropsBase extends ModalCloseProps {
  readonly requestId: string;
  readonly target: PageCreateTarget;
  readonly origin: PageCreateOrigin;
  readonly initialExpanded?: boolean;
  readonly expandRequestId?: string;
}

export type PageCreateDialogProps = PageCreateDialogPropsBase &
  (
    | {
        readonly restoredSnapshot: PageCreateDraftSnapshot;
        readonly seed?: never;
      }
    | {
        readonly restoredSnapshot?: undefined;
        readonly seed?: PageCreateSeed;
      }
  );

const formatError = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return "Couldn’t create the Page. Try again.";
};

const appendDraftTagOption = (name: string): DatabasePropertyOption => {
  const id = createCustomOptionId();
  return {
    id,
    name: name.trim(),
    color: defaultDataSourcePropertyOptionColor(id),
  };
};

function createRestoredTagOptions(
  snapshot: PageCreateDraftSnapshot | undefined,
): DatabasePropertyOption[] {
  return (snapshot?.tagNames ?? []).map(appendDraftTagOption);
}

type PageCreateNestedSurface = "status" | "priority" | "estimate" | "tags";

const INITIAL_PAGE_CREATE_NESTED_SURFACES: Record<PageCreateNestedSurface, boolean> = {
  status: false,
  priority: false,
  estimate: false,
  tags: false,
};

const PAGE_CREATE_PRIORITY_OPTIONS: readonly DatabasePropertyOption[] = BOARD_PRIORITY_OPTIONS.map(
  (option) => ({
    id: option.value,
    name: option.label,
  }),
);

const PAGE_CREATE_ESTIMATE_OPTIONS: readonly DatabasePropertyOption[] = estimateOptions.flatMap(
  (option) => (option.value === "none" ? [] : [{ id: option.value, name: option.label }]),
);

function PageCreateDialogContent({
  requestId,
  target,
  origin,
  restoredSnapshot,
  seed,
  initialExpanded = false,
  expandRequestId,
  onClose,
}: PageCreateDialogProps) {
  const appHandle = useScopeHandle(appScope);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const descriptionNavigationRef = useRef<NfmEditorBoundaryHandle>(null);
  const pendingRef = useRef(false);
  const restoredTagOptionsRef = useRef(createRestoredTagOptions(restoredSnapshot));
  const initialStatus = target.columns.some((column) => column.id === restoredSnapshot?.status)
    ? (restoredSnapshot?.status ?? origin.columnId)
    : origin.columnId;
  const [title, setTitle] = useState(restoredSnapshot?.title ?? seed?.title ?? "");
  const [status, setStatus] = useState<WorkflowStatus>(initialStatus);
  const [priority, setPriority] = useState<Priority | null>(restoredSnapshot?.priority ?? null);
  const [estimate, setEstimate] = useState<Estimate | null>(restoredSnapshot?.estimate ?? null);
  const [draftTagOptions, setDraftTagOptions] = useState<readonly DatabasePropertyOption[]>(
    restoredTagOptionsRef.current,
  );
  const [selectedTagIds, setSelectedTagIds] = useState<readonly string[]>(
    restoredTagOptionsRef.current.map((option) => option.id),
  );
  const [descriptionDraft, setDescriptionDraft] = useState<PageCreateDescriptionDraft>(() =>
    createPageCreateDescriptionDraft(requestId, 0, restoredSnapshot?.descriptionNfm ?? ""),
  );
  const [createMore, setCreateMore] = useState(restoredSnapshot?.createMore ?? false);
  const [expanded, setExpanded] = useState(restoredSnapshot?.expanded ?? initialExpanded);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nestedSurfaces, setNestedSurfaces] = useState(INITIAL_PAGE_CREATE_NESTED_SURFACES);
  useEffect(() => {
    if (expandRequestId) setExpanded(true);
  }, [expandRequestId]);
  const nestedSurfaceOpen = Object.values(nestedSurfaces).some(Boolean);
  const setNestedSurfaceOpen = (surface: PageCreateNestedSurface, open: boolean) => {
    setNestedSurfaces((current) => {
      if (current[surface] === open) return current;
      return { ...current, [surface]: open };
    });
  };
  const layout = resolvePageCreateDialogLayout(expanded);
  const capabilities = resolvePageCreatePropertyCapabilities(target.properties);
  const optionRegistries = usePropertyOptionRegistries({
    accessContext: target.accessContext,
    properties: target.properties,
  });
  const tagsProperty = capabilities.tagsProperty;
  const persistedTagOptions = tagsProperty
    ? (optionRegistries.options[tagsProperty.propertyId] ?? [])
    : [];
  const tagOptions = [...persistedTagOptions, ...draftTagOptions];
  const statusOptions: readonly DatabasePropertyOption[] = target.columns.map((column) => ({
    id: column.id,
    name: column.name,
  }));
  const baselineRef = useRef<PageCreateDraftSnapshot>(
    restoredSnapshot
      ? { ...restoredSnapshot, status: initialStatus }
      : createEmptyPageCreateDraftSnapshot(initialStatus),
  );

  useEffect(() => () => descriptionDraft.document.destroy(), [descriptionDraft]);

  const captureSnapshot = (): PageCreateDraftSnapshot =>
    capturePageCreateDraftSnapshot({
      title,
      descriptionDraft,
      status,
      priority,
      estimate,
      selectedTagIds,
      tagOptions,
      createMore,
      expanded,
    });

  const closeAndRestoreFocus = (createdPageId?: string) => {
    if (pendingRef.current) return;
    onClose();
    restorePageCreateFocus(origin, createdPageId);
  };

  const closeWithRecovery = () => {
    if (pendingRef.current) return;
    let snapshot: PageCreateDraftSnapshot;
    try {
      snapshot = captureSnapshot();
    } catch (cause) {
      console.error("[page-create:draft-capture]", cause);
      closeAndRestoreFocus();
      toast.danger("Page draft couldn’t be preserved.");
      return;
    }
    const dirty = !pageCreateDraftSnapshotsEqual(snapshot, baselineRef.current);
    closeAndRestoreFocus();
    if (!dirty) return;

    toast.info("Page draft closed", {
      id: `page-create-draft:${target.surfaceId}`,
      duration: 10_000,
      action: {
        label: "Restore",
        onClick: () =>
          restorePageCreateDraft(appHandle, {
            target,
            origin,
            snapshot,
          }),
      },
    });
  };

  const resetForNextPage = (tagNames: readonly string[]) => {
    const nextBaseline = createEmptyPageCreateDraftSnapshot(status, {
      priority,
      estimate,
      tagNames,
      createMore,
      expanded,
    });
    baselineRef.current = nextBaseline;
    setTitle("");
    setError(null);
    setDescriptionDraft((current) =>
      createPageCreateDescriptionDraft(requestId, current.generation + 1),
    );
    requestAnimationFrame(() => titleInputRef.current?.focus());
  };

  const submit = async (continueCreating: boolean) => {
    if (pendingRef.current) return;

    let input;
    try {
      input = buildPageCreateInput({
        title,
        descriptionDraft,
        priority,
        estimate,
        selectedTagIds,
        tagOptions,
        capabilities,
      });
    } catch (cause) {
      setError(formatError(cause));
      titleInputRef.current?.focus();
      return;
    }

    pendingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await createBoardPage({
        projectId: target.project.id,
        databaseViewId: target.databaseViewId,
        clientSessionId: target.clientSessionId,
        status,
        input,
        placement: "top",
      });
      if (result.status === "error") throw new Error(result.error);
      if (continueCreating) {
        pendingRef.current = false;
        setSaving(false);
        resetForNextPage(input.tagOptions?.map((option) => option.optionId) ?? []);
        return;
      }
      pendingRef.current = false;
      closeAndRestoreFocus(result.page.id);
    } catch (cause) {
      pendingRef.current = false;
      setSaving(false);
      setError(formatError(cause));
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit(createMore);
  };

  const handleShortcut = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    void submit(event.shiftKey || createMore);
  };

  return (
    <NodexDialog
      open
      disablePointerDismissal={pendingRef.current}
      onOpenChange={(open, details) => {
        if (open) return;
        if (pendingRef.current || (details.reason === "escape" && nestedSurfaceOpen)) {
          details.cancel();
          return;
        }
        closeWithRecovery();
      }}
    >
      <NodexDialogContent
        size="large"
        showCloseButton={false}
        data-page-create-dialog
        style={{
          width: `min(${layout.width}px, calc(100vw - 24px))`,
          top: `calc(36px + ${layout.topViewportPercent}vh)`,
          height: layout.fillsAvailableHeight ? "calc(100vh - 36px - 12vh)" : undefined,
        }}
        className="left-1/2 -translate-x-1/2 translate-y-0 max-w-[calc(100vw-24px)] rounded-[22px] transition-[top,width] duration-150 ease-out motion-reduce:transition-none"
        initialFocus={() => {
          requestAnimationFrame(() => titleInputRef.current?.focus());
          return false;
        }}
        finalFocus={false}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <NodexDialogForm
          data-page-create-project-id={target.project.id}
          data-page-create-request-id={requestId}
          className={cn(
            "min-h-0 p-0",
            expanded ? "flex h-full flex-col" : "max-h-[calc(100vh-36px-16vh)]",
          )}
          onSubmit={handleSubmit}
          onKeyDownCapture={handleShortcut}
        >
          <header className="flex h-13 shrink-0 items-center gap-2 px-3">
            <div className="flex min-w-0 items-center gap-1.5 text-sm text-token-description-foreground">
              <ProjectMarker appearance={target.project.appearance} className="size-4" />
              <span className="max-w-56 truncate font-medium text-token-foreground">
                {target.project.name}
              </span>
              <ChevronRightIcon className="icon-2xs shrink-0" />
              <NodexDialogTitle className="truncate text-sm font-medium tracking-normal">
                New page
              </NodexDialogTitle>
            </div>
            <NodexDialogDescription className="sr-only">
              Create a Page in {target.project.name} with a title, description, and properties.
            </NodexDialogDescription>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                disabled={saving}
                aria-label={expanded ? "Collapse Page composer" : "Expand Page composer"}
                aria-expanded={expanded}
                onClick={() => setExpanded((current) => !current)}
                className="grid size-7 place-items-center rounded-full text-token-description-foreground outline-none hover:bg-token-foreground/5 hover:text-token-foreground focus-visible:ring-2 focus-visible:ring-token-focus disabled:cursor-not-allowed disabled:opacity-40"
              >
                {expanded ? (
                  <RestorePanelIcon className="icon-xs" />
                ) : (
                  <ExpandPanelIcon className="icon-xs" />
                )}
              </button>
              <NodexDialogClose>
                <button
                  type="button"
                  disabled={saving}
                  aria-label="Close Page creation"
                  className="grid size-7 place-items-center rounded-full text-token-description-foreground outline-none hover:bg-token-foreground/5 hover:text-token-foreground focus-visible:ring-2 focus-visible:ring-token-focus disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <CloseIcon className="icon-xs" />
                </button>
              </NodexDialogClose>
            </div>
          </header>

          <div className={cn("mx-4 flex min-h-0 flex-col", expanded ? "flex-1" : "")}>
            <label htmlFor={`page-create-title-${requestId}`} className="sr-only">
              Page title
            </label>
            <input
              ref={titleInputRef}
              id={`page-create-title-${requestId}`}
              value={title}
              maxLength={MAX_PAGE_TITLE_LENGTH}
              disabled={saving}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.shiftKey)
                  return;
                event.preventDefault();
                descriptionNavigationRef.current?.focus();
              }}
              placeholder="Page title"
              className="w-full shrink-0 bg-transparent px-1 py-0 text-[18px]/[28.8px] font-semibold tracking-[-0.1px] text-token-foreground outline-none placeholder:text-token-description-foreground/65 disabled:opacity-60"
            />
            <div
              className={cn(
                "min-h-[79px] overflow-y-auto px-1 pb-3 pt-1.5 text-[15px]/6 font-normal",
                expanded ? "flex-1" : "max-h-[min(360px,38vh)]",
              )}
              style={{ minHeight: layout.minimumWritingHeight }}
            >
              <PageCreateDescriptionEditor
                draft={descriptionDraft}
                navigationRef={descriptionNavigationRef}
                titleInputRef={titleInputRef}
              />
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pb-2 pt-1">
            <PropertyOptionPicker
              label="Status"
              triggerAriaLabel="Status"
              mode="single"
              presentation="chip"
              triggerPrefix={<StatusIcon statusId={status} className="icon-xs" />}
              options={statusOptions}
              selectedIds={[status]}
              disabled={saving}
              allowClear={false}
              searchPlaceholder="Change status…"
              searchLeading={null}
              contentClassName="w-[min(220px,calc(100vw-16px))]"
              onOpenChange={(open) => setNestedSurfaceOpen("status", open)}
              onSelectedIdsChange={(selectedIds) => {
                const nextStatus = selectedIds[0];
                if (!nextStatus) return;
                if (!target.columns.some((column) => column.id === nextStatus)) return;
                setStatus(nextStatus as WorkflowStatus);
              }}
              renderOption={(option) => (
                <span className="flex min-w-0 items-center gap-2">
                  <StatusIcon statusId={option.id} className="icon-xs" />
                  <span className="truncate">{option.name}</span>
                </span>
              )}
            />
            {capabilities.priorityProperty ? (
              <SemanticSelectPropertyEditor
                kind="priority"
                label="Priority"
                triggerAriaLabel="Priority"
                options={PAGE_CREATE_PRIORITY_OPTIONS}
                selectedId={priority}
                disabled={saving}
                presentation="chip"
                triggerPrefix={
                  <PriorityIcon className="icon-xs shrink-0 text-token-description-foreground" />
                }
                searchPlaceholder="Change priority…"
                searchLeading={null}
                contentClassName="w-[min(220px,calc(100vw-16px))]"
                emptyOptionLabel="No priority"
                onOpenChange={(open) => setNestedSurfaceOpen("priority", open)}
                onChange={(value) => {
                  if (value === null) {
                    setPriority(null);
                    return;
                  }
                  if (!BOARD_PRIORITY_OPTIONS.some((option) => option.value === value)) return;
                  setPriority(value as Priority);
                }}
              />
            ) : null}
            {capabilities.estimateProperty ? (
              <SemanticSelectPropertyEditor
                kind="estimate"
                label="Estimate"
                triggerAriaLabel="Estimate"
                options={PAGE_CREATE_ESTIMATE_OPTIONS}
                selectedId={estimate}
                disabled={saving}
                presentation="chip"
                triggerPrefix={
                  <EstimateIcon className="icon-xs shrink-0 text-token-description-foreground" />
                }
                searchPlaceholder="Change estimate…"
                searchLeading={null}
                contentClassName="w-[min(220px,calc(100vw-16px))]"
                emptyOptionLabel="No estimate"
                onOpenChange={(open) => setNestedSurfaceOpen("estimate", open)}
                onChange={(value) => {
                  if (value === null) {
                    setEstimate(null);
                    return;
                  }
                  if (!PAGE_CREATE_ESTIMATE_OPTIONS.some((option) => option.id === value)) return;
                  setEstimate(value as Estimate);
                }}
              />
            ) : null}
            {tagsProperty ? (
              <PropertyOptionPicker
                label="Tags"
                mode="multiple"
                presentation="chip"
                triggerPrefix={
                  <TagIcon className="icon-xs shrink-0 text-token-description-foreground" />
                }
                options={tagOptions}
                selectedIds={selectedTagIds}
                disabled={saving}
                loading={optionRegistries.states[tagsProperty.propertyId] === "loading"}
                loadingMore={optionRegistries.loadingMore[tagsProperty.propertyId] ?? false}
                registryError={optionRegistries.states[tagsProperty.propertyId] === "error"}
                hasMore={optionRegistries.hasMore[tagsProperty.propertyId] ?? false}
                allowCreate
                onOpenChange={(open) => setNestedSurfaceOpen("tags", open)}
                onOpen={() => optionRegistries.requestOptions(tagsProperty)}
                onLoadMore={() => optionRegistries.requestMoreOptions(tagsProperty)}
                onSelectedIdsChange={setSelectedTagIds}
                onCreateOption={(name) => {
                  const option = appendDraftTagOption(name);
                  setDraftTagOptions((current) => [...current, option]);
                  setSelectedTagIds((current) => [...current, option.id]);
                }}
              />
            ) : null}
          </div>

          {error ? (
            <p
              role="alert"
              aria-live="polite"
              className="max-h-20 shrink-0 overflow-y-auto break-words px-4 pb-1 text-xs/4 text-token-error-foreground"
            >
              {error}
            </p>
          ) : null}

          <footer className="flex min-h-11 shrink-0 items-center justify-end gap-3 px-3 pb-3 pt-1">
            <label className="flex shrink-0 items-center gap-1.5 text-xs/4.5 text-token-description-foreground">
              <NodexSwitch
                ariaLabel="Create more Pages"
                checked={createMore}
                disabled={saving}
                size="compact"
                onCheckedChange={setCreateMore}
              />
              Create more
            </label>
            <NodexDialogAction
              type="submit"
              tone="primary"
              size="compact"
              aria-keyshortcuts="Control+Enter Meta+Enter Control+Shift+Enter Meta+Shift+Enter"
              title="Create Page (⌘/Ctrl+Enter; add Shift to continue)"
              disabled={saving || !title.trim()}
            >
              {saving ? "Creating…" : "Create page"}
            </NodexDialogAction>
          </footer>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

export function PageCreateDialog(props: PageCreateDialogProps) {
  return <PageCreateDialogContent key={props.requestId} {...props} />;
}
