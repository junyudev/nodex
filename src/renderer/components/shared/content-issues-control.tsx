import { useState, useSyncExternalStore } from "react";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal, type ModalCloseProps } from "@/lib/modal-registry";
import {
  contentEditIssues,
  type ContentEditIssue,
  type ContentEditIssueAction,
  type ContentEditLocation,
} from "@/lib/content-edit-issues";
import type { ContentAccessIdentity } from "../../../shared/content-access-context";
import type { Project } from "@/lib/types";
import { useOpenDocumentRecoveryReview } from "@/features/document-recovery/recovery-entry";
import { CircleAlert } from "@/components/shared/icons/generic-icons";
import { ChevronRightIcon, LoadingIcon, MoreActionsIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexDropdownItem, NodexDropdownMenu, NodexDropdownTitle } from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
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

type RunAction = Extract<ContentEditIssueAction, { kind: "run" }>;
type Projects = readonly Pick<Project, "id" | "name">[];
const EMPTY_PROJECTS: Projects = [];
type OpenLocation = (
  scope: ContentAccessIdentity,
  location: ContentEditLocation,
) => void | Promise<unknown>;

function ConfirmContentIssueAction({
  action,
  scopeLabel,
  onClose,
}: ModalCloseProps & {
  readonly action: RunAction;
  readonly scopeLabel: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmation = action.confirmation!;
  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <NodexDialogContent size="compact">
        <NodexDialogForm
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            try {
              await action.run();
              onClose();
            } catch (error) {
              setError(
                error instanceof Error ? error.message : "The action could not be completed.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle>{confirmation.title}</NodexDialogTitle>
            <NodexDialogDescription>
              {scopeLabel}. {confirmation.description}
            </NodexDialogDescription>
          </NodexDialogHeader>
          {error ? (
            <p role="alert" className="mt-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
          <NodexDialogFooter>
            <NodexDialogAction disabled={busy} onClick={onClose}>
              Cancel
            </NodexDialogAction>
            <NodexDialogAction disabled={busy || !!error} type="submit" tone="danger">
              {confirmation.confirmLabel}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

function ContentIssueRow({
  issue,
  scopeLabel,
  onOpenLocation,
  closePopover,
}: {
  readonly issue: ContentEditIssue;
  readonly scopeLabel: string;
  readonly onOpenLocation?: OpenLocation;
  readonly closePopover: () => void;
}) {
  const appHandle = useScopeHandle(appScope);
  const review = useOpenDocumentRecoveryReview();
  const affectedScope =
    issue.scope.accessContext.kind === "project" ? `Project: ${scopeLabel}` : scopeLabel;
  const [error, setError] = useState<string | null>(null);
  const [runningAction, setRunningAction] = useState<{
    readonly action: ContentEditIssueAction;
    readonly actions: readonly ContentEditIssueAction[];
  } | null>(null);
  const busy = runningAction !== null;
  const actions = runningAction?.actions ?? issue.actions;
  const directActions = actions.filter((action) => action.kind !== "run" || !action.confirmation);
  const secondaryActions = actions.filter((action) => action.kind === "run" && action.confirmation);
  const run = async (action: ContentEditIssueAction) => {
    if (busy) return;
    setError(null);
    if (action.kind === "run" && action.confirmation) {
      closePopover();
      openModal(appHandle, ConfirmContentIssueAction, { action, scopeLabel: affectedScope });
      return;
    }
    setRunningAction({ action, actions: issue.actions });
    try {
      if (action.kind === "review") {
        await action.prepare?.();
        closePopover();
        review(action);
      } else await action.run();
    } catch (error) {
      setError(error instanceof Error ? error.message : "The action could not be completed.");
    } finally {
      setRunningAction(null);
    }
  };
  return (
    <li className="flex min-w-0 flex-col gap-2 py-3 first:pt-2 last:pb-0">
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-sm font-medium text-token-text-primary">{issue.title}</h3>
        <p className="text-sm leading-5 text-token-text-secondary">{issue.detail}</p>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {issue.location && onOpenLocation ? (
          <NodexButton
            variant="outline"
            size="sm"
            aria-label={`Open ${issue.location.label} in ${scopeLabel}`}
            className="min-w-0 shrink gap-1.5 border-[0.5px] bg-transparent px-2 text-xs"
            onClick={() => {
              closePopover();
              void Promise.resolve(onOpenLocation(issue.scope, issue.location!));
            }}
          >
            <span className="min-w-0 truncate text-left">
              <span className="text-token-text-secondary">{scopeLabel} / </span>
              {issue.location.label}
            </span>
            <ChevronRightIcon className="icon-xs" />
          </NodexButton>
        ) : (
          <span className="min-w-0 truncate text-xs text-token-text-secondary">
            {scopeLabel}
            {issue.location ? ` / ${issue.location.label}` : ""}
          </span>
        )}
        {secondaryActions.length > 0 ? (
          <NodexDropdownMenu
            align="end"
            motion="none"
            disabled={busy}
            triggerButton={
              <NodexButton
                variant="outline"
                size="icon-sm"
                aria-label={`More actions for ${issue.location?.label ?? issue.title}`}
                className="ml-auto border-[0.5px] bg-transparent"
              >
                <MoreActionsIcon className="icon-sm" />
              </NodexButton>
            }
          >
            <NodexDropdownTitle>{affectedScope}</NodexDropdownTitle>
            {secondaryActions.map((action) => (
              <NodexDropdownItem key={action.label} onSelect={() => void run(action)}>
                {action.label}…
              </NodexDropdownItem>
            ))}
          </NodexDropdownMenu>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      {directActions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {directActions.map((action, index) => (
            <NodexButton
              key={action.label}
              variant={index === 0 ? "primary" : "outline"}
              size="sm"
              disabled={busy}
              aria-busy={runningAction?.action === action || undefined}
              onClick={() => void run(action)}
            >
              {runningAction?.action === action ? (
                <LoadingIcon className="icon-xs motion-safe:animate-spin" />
              ) : null}
              {action.label}
            </NodexButton>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function ContentIssuesPopover({
  issues,
  projects,
  onOpenLocation,
}: {
  readonly issues: readonly ContentEditIssue[];
  readonly projects: Projects;
  readonly onOpenLocation?: OpenLocation;
}) {
  const [open, setOpen] = useState(false);
  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexTooltip
        tooltipContent={`${issues.length} content ${issues.length === 1 ? "issue needs" : "issues need"} attention`}
      >
        <NodexPopoverTrigger>
          <button
            type="button"
            aria-label="Content issues"
            className="no-drag pointer-events-auto flex size-7 shrink-0 items-center justify-center rounded-lg text-danger hover:bg-token-foreground/5 focus-visible:outline focus-visible:outline-token-border-xstrong"
          >
            <CircleAlert className="icon-xs" />
          </button>
        </NodexPopoverTrigger>
      </NodexTooltip>
      <NodexPopoverContent align="end" className="w-88 max-w-[calc(100vw-24px)] p-3">
        <h2 className="text-xs text-token-text-secondary">Needs attention</h2>
        <ul className="mt-1 max-h-80 overflow-y-auto divide-y divide-token-border">
          {issues.map((issue) => (
            <ContentIssueRow
              key={issue.id}
              issue={issue}
              scopeLabel={
                issue.scope.accessContext.kind === "library"
                  ? "Library"
                  : (projects.find(
                      (project) =>
                        issue.scope.accessContext.kind === "project" &&
                        project.id === issue.scope.accessContext.projectId,
                    )?.name ?? "Project")
              }
              onOpenLocation={onOpenLocation}
              closePopover={() => setOpen(false)}
            />
          ))}
        </ul>
      </NodexPopoverContent>
    </NodexPopover>
  );
}

export function ContentIssuesControlView({
  issues,
  projects = EMPTY_PROJECTS,
  onOpenLocation,
}: {
  readonly issues: readonly ContentEditIssue[];
  readonly projects?: Projects;
  readonly onOpenLocation?: OpenLocation;
}) {
  return issues.length > 0 ? (
    <ContentIssuesPopover issues={issues} projects={projects} onOpenLocation={onOpenLocation} />
  ) : null;
}

export function ContentIssuesControl({
  libraryId,
  ...props
}: {
  readonly libraryId?: string | null;
  readonly projects?: Projects;
  readonly onOpenLocation?: OpenLocation;
}) {
  const issues = useSyncExternalStore(contentEditIssues.subscribe, contentEditIssues.getSnapshot);
  return (
    <ContentIssuesControlView
      {...props}
      issues={libraryId ? issues.filter((issue) => issue.scope.libraryId === libraryId) : issues}
    />
  );
}
