import { useEffect, useState, useSyncExternalStore } from "react";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";
import type { SurfaceHistoryControls } from "@/lib/surface-history/controls";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { ActivitySpinnerIcon, HistoryIcon } from "@/components/shared/icons";
import {
  readContentInteractionHistories,
  readContentProjectionActivities,
  subscribeContentInteractionHistories,
  type ContentHistoryObservation,
  type ContentProjectionObservation,
  contentInteractionHistoryScopeKey,
} from "@/lib/content-interaction-history";
import type { SurfaceHistoryCapability } from "../../../shared/surface-history";
import type { Project } from "@/lib/types";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";

function ResetSurfaceHistoryDialog({
  controls,
  ownerId,
  generation,
  scopeLabel,
  onClose,
}: {
  readonly controls: SurfaceHistoryControls;
  readonly ownerId: string;
  readonly generation: number;
  readonly scopeLabel: string;
  readonly onClose: () => void;
}) {
  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent size="compact">
        <NodexDialogForm
          onSubmit={(event) => {
            event.preventDefault();
            const current = controls.snapshot();
            if (
              current.ownerId === ownerId &&
              current.generation === generation &&
              [current.undo, current.redo].some((item) => item.recoveryActions.includes("reset"))
            )
              controls.reset();
            onClose();
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle>Reset content history?</NodexDialogTitle>
            <NodexDialogDescription>
              Current content will not change. Earlier Page and Database edits for {scopeLabel} in
              this window can no longer be undone or redone. Any submitted action will still finish
              being confirmed.
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onClose}>Cancel</NodexDialogAction>
            <NodexDialogAction type="submit" tone="danger">
              Reset history
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

function HistoryDetails({
  controls,
  snapshot,
  onResetRequested,
  scopeLabel,
}: Pick<ContentHistoryObservation, "controls" | "snapshot"> & {
  readonly onResetRequested: () => void;
  readonly scopeLabel: string;
}) {
  const appHandle = useScopeHandle(appScope);
  const directions = [snapshot.undo, snapshot.redo];
  const capability =
    directions.find((item) => item.status === "waiting") ??
    directions.find((item) => item.status === "blocked");
  if (!capability) return null;
  return (
    <div
      className="flex min-w-0 flex-col gap-2 py-2 text-xs text-token-text-secondary"
      contentEditable={false}
    >
      <span className="text-token-text-tertiary">{scopeLabel}</span>
      <span className="min-w-0">
        {capability.label ? `${capability.label} · ` : ""}
        {capability.reason}
      </span>
      <div className="flex items-center gap-1">
        {capability.recoveryActions.includes("retry") ? (
          <NodexButton
            variant="ghost"
            size="xs"
            onClick={() => {
              controls.recover();
            }}
          >
            {capability.status === "waiting" ? "Check again" : "Retry"}
          </NodexButton>
        ) : null}
        {capability.recoveryActions.includes("reset") ? (
          <NodexButton
            variant="ghost"
            size="xs"
            onClick={() => {
              onResetRequested();
              openModal(appHandle, ResetSurfaceHistoryDialog, {
                controls,
                ownerId: snapshot.ownerId,
                generation: snapshot.generation,
                scopeLabel,
              });
            }}
          >
            Reset history
          </NodexButton>
        ) : null}
      </div>
    </div>
  );
}

const needsAttention = (capability: SurfaceHistoryCapability) =>
  capability.status === "blocked" || (capability.status === "waiting" && !capability.acceptsIntent);

/** One window-level entry observes retained timelines without taking ownership. */
type HistoryProjects = readonly Pick<Project, "id" | "name">[];
const EMPTY_PROJECTS: HistoryProjects = [];
export function ContentHistoryControl({
  projects = EMPTY_PROJECTS,
}: {
  readonly projects?: HistoryProjects;
}) {
  const entries = useSyncExternalStore(
    subscribeContentInteractionHistories,
    readContentInteractionHistories,
  );
  const projections = useSyncExternalStore(
    subscribeContentInteractionHistories,
    readContentProjectionActivities,
  );
  return (
    <ContentHistoryControlView entries={entries} projections={projections} projects={projects} />
  );
}

const EMPTY_PROJECTIONS: readonly ContentProjectionObservation[] = [];
export function ContentHistoryControlView({
  entries,
  projections = EMPTY_PROJECTIONS,
  projects = EMPTY_PROJECTS,
}: {
  readonly entries: readonly ContentHistoryObservation[];
  readonly projections?: readonly ContentProjectionObservation[];
  readonly projects?: HistoryProjects;
}) {
  const [open, setOpen] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const capabilities = entries.flatMap(({ snapshot }) => [snapshot.undo, snapshot.redo]);
  const attention =
    capabilities.some(needsAttention) || projections.some(({ activity }) => activity.unknown > 0);
  const submitting =
    capabilities.some((item) => item.status === "waiting" && item.acceptsIntent) ||
    projections.some(({ activity }) => activity.pending > 0);
  const reconciling = projections.some(({ activity }) => activity.acknowledged > 0);
  const pending = submitting || reconciling;
  useEffect(() => {
    if (!pending) {
      setShowProgress(false);
      return;
    }
    const timer = setTimeout(() => setShowProgress(true), 1000);
    return () => clearTimeout(timer);
  }, [pending]);
  const status = attention
    ? "Content edits need attention"
    : pending && showProgress
      ? submitting
        ? "Saving content edits"
        : "Updating views"
      : "";
  const active = entries.filter(({ snapshot }) =>
    [snapshot.undo, snapshot.redo].some(
      (item) => item.status === "waiting" || item.status === "blocked",
    ),
  );
  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexTooltip tooltipContent={status || "Content edits"}>
        <NodexPopoverTrigger>
          <button
            type="button"
            aria-label="Content edits"
            className="no-drag pointer-events-auto relative flex size-7 shrink-0 items-center justify-center rounded-lg text-token-text-tertiary hover:bg-token-foreground/5 focus-visible:outline focus-visible:outline-token-border-xstrong"
          >
            {pending && showProgress && !attention ? (
              <ActivitySpinnerIcon className="icon-xs" />
            ) : (
              <HistoryIcon className="icon-xs" />
            )}
            {attention ? (
              <span
                aria-hidden="true"
                className="absolute right-1 top-1 size-1.5 rounded-full bg-current text-danger"
              />
            ) : null}
            <span role="status" className="sr-only">
              {status}
            </span>
          </button>
        </NodexPopoverTrigger>
      </NodexTooltip>
      <NodexPopoverContent align="end" className="w-72 p-3">
        <h2 className="text-sm text-token-text-primary">Content edits</h2>
        <p className="mt-1 text-xs text-token-text-secondary">
          Page and Database edits in this window.
        </p>
        {active.length === 0 && !pending && !attention ? (
          <p className="mt-3 text-xs text-token-text-secondary">No actions need attention.</p>
        ) : (
          active.map((entry) => (
            <HistoryDetails
              key={entry.snapshot.ownerId}
              controls={entry.controls}
              snapshot={entry.snapshot}
              scopeLabel={
                entry.scope.accessContext.kind === "library"
                  ? "Library"
                  : `Project: ${projects.find((project) => entry.scope.accessContext.kind === "project" && project.id === entry.scope.accessContext.projectId)?.name ?? entry.scope.accessContext.projectId}`
              }
              onResetRequested={() => setOpen(false)}
            />
          ))
        )}
        {projections
          .filter(
            ({ activity, scope }) =>
              activity.acknowledged > 0 ||
              ((activity.pending > 0 || activity.unknown > 0) &&
                !active.some(
                  (entry) =>
                    contentInteractionHistoryScopeKey(entry.scope) ===
                    contentInteractionHistoryScopeKey(scope),
                )),
          )
          .map(({ id, label, activity, scope }) => (
            <p
              key={`${contentInteractionHistoryScopeKey(scope)}\0${id}`}
              className="mt-2 text-xs text-token-text-secondary"
            >
              {label} ·{" "}
              {activity.unknown > 0
                ? "Confirming the last action."
                : activity.pending > 0
                  ? "Saving changes."
                  : "Changes saved. Updating the view."}
            </p>
          ))}
      </NodexPopoverContent>
    </NodexPopover>
  );
}
