import { ArchiveIcon, ChevronRightIcon, OpenInIcon } from "@/components/shared/icons";
import { useId, type ReactNode } from "react";
import { Rows3, TriangleAlert } from "@/components/shared/icons/generic-icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import type { DatabaseViewReadModel } from "../../../shared/database-views";
import { isInlineCardCycle } from "./block-reference-runtime-context";
import type { DatabasePageSummary } from "@/lib/types";
import { resolveBoardPriorityOption } from "@/lib/board-options";
import {
  BlockDisclosureStateStore,
  blockDisclosureStateStore,
  useBlockDisclosure,
} from "@/lib/block-disclosure-state";
import {
  ReferenceSurfaceActivationBudget,
  referenceSurfaceActivationBudget,
  useReferenceSurfaceActivation,
} from "@/lib/reference-surface-state";
import { StatusIcon } from "@/lib/status-presentation";
import { useElementVisibility } from "@/lib/use-element-visibility";
import { cn } from "@/lib/utils";
import {
  contentAccessContextKey,
  libraryContentAccess,
  projectContentAccess,
  type ContentAccessContext,
  type ContentPageNavigationTarget,
} from "../../../shared/content-access-context";

export interface ReferencedPageDocumentInput {
  readonly accessContext: ContentAccessContext;
  readonly card: DatabasePageSummary;
  readonly isActive: boolean;
}

export type ReferencedPageDocumentRenderer = (input: ReferencedPageDocumentInput) => ReactNode;

interface ReferenceSurfaceStateDependencies {
  readonly disclosureStore?: BlockDisclosureStateStore;
  readonly activationBudget?: ReferenceSurfaceActivationBudget;
  /** Deterministic test/story seam; production always uses IntersectionObserver. */
  readonly visibilityOverride?: boolean;
}

export interface ReferencedCardRowProps extends ReferenceSurfaceStateDependencies {
  readonly disclosureKey: string;
  readonly accessContext: ContentAccessContext;
  readonly card: DatabasePageSummary;
  readonly canEdit: boolean;
  readonly archived?: boolean;
  readonly legacy?: boolean;
  readonly inlineEditingDisabledReason?: string;
  readonly metadata?: ReactNode;
  readonly showPageKey?: boolean;
  readonly renderDocument?: ReferencedPageDocumentRenderer;
  readonly onOpenPage?: (input: ContentPageNavigationTarget) => void | Promise<void>;
}

const META_CHIP =
  "inline-flex h-5 shrink-0 items-center rounded-sm bg-token-foreground/5 px-1.5 text-xs text-token-description-foreground";

function CardRowMetadata({
  card,
  archived,
}: {
  readonly card: DatabasePageSummary;
  readonly archived: boolean;
}) {
  const priority = resolveBoardPriorityOption(card.priority);
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
      {priority ? (
        <span className={cn(META_CHIP, priority.className)}>
          {priority.shortLabel.split(" - ")[0]}
        </span>
      ) : null}
      {card.estimate ? <span className={META_CHIP}>{card.estimate.toUpperCase()}</span> : null}
      <NodexTooltip tooltipContent={archived ? "Archived" : card.status} side="top">
        <span className="inline-flex min-w-0 items-center gap-1 text-xs text-token-description-foreground">
          {archived ? (
            <ArchiveIcon aria-hidden="true" className="size-3.5 shrink-0" />
          ) : (
            <StatusIcon statusId={card.status} className="size-3.5!" />
          )}
        </span>
      </NodexTooltip>
    </span>
  );
}

export function ReferencedCardRow({
  disclosureKey,
  accessContext,
  card,
  canEdit,
  archived = false,
  legacy = false,
  inlineEditingDisabledReason,
  metadata,
  showPageKey = true,
  renderDocument,
  onOpenPage,
  disclosureStore = blockDisclosureStateStore,
  activationBudget = referenceSurfaceActivationBudget,
  visibilityOverride,
}: ReferencedCardRowProps) {
  const surfaceInstanceId = useId();
  const surfaceInstanceKey = `referenced-card:${disclosureKey}:mount:${surfaceInstanceId}`;
  const [preferredExpanded, setExpanded] = useBlockDisclosure(disclosureKey, disclosureStore);
  const visibility = useElementVisibility();
  const visible = visibilityOverride ?? visibility.visible;
  const expandable = canEdit && typeof renderDocument === "function";
  const expanded = expandable && preferredExpanded;
  const active = useReferenceSurfaceActivation(
    surfaceInstanceKey,
    expanded && visible,
    activationBudget,
  );
  const title = card.title.trim() || "Untitled";

  return (
    <section
      ref={visibility.ref}
      contentEditable={false}
      data-reference-card={card.id}
      data-reference-access={contentAccessContextKey(accessContext)}
      data-reference-expanded={expanded ? "true" : "false"}
      data-reference-editor-active={active ? "true" : "false"}
      className="min-w-0 py-0.5"
      onFocusCapture={() => activationBudget.touch(surfaceInstanceKey)}
      onPointerDownCapture={() => activationBudget.touch(surfaceInstanceKey)}
    >
      <div className="group/reference-row flex min-h-8 min-w-0 items-center gap-1 rounded-md px-1 hover:bg-token-foreground/5">
        <button
          type="button"
          aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
          aria-expanded={expanded}
          disabled={!expandable}
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-token-description-foreground",
            expandable
              ? "cursor-pointer hover:bg-token-foreground/10 hover:text-token-text-primary"
              : "cursor-default opacity-35",
          )}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-150 ease-out",
              expanded && "rotate-90",
            )}
          />
        </button>

        <span className="flex min-w-0 flex-1 items-baseline gap-2 text-sm text-token-text-primary">
          {showPageKey && card.pageKey ? (
            <span className="w-20 shrink-0 truncate text-xs font-medium tabular-nums text-token-description-foreground">
              {card.pageKey}
            </span>
          ) : null}
          <span className="min-w-0 truncate">{title}</span>
        </span>
        {legacy ? (
          <span className="shrink-0 text-[11px] text-token-description-foreground">Migrating</span>
        ) : null}
        {inlineEditingDisabledReason ? (
          <span className="shrink-0 text-[11px] text-token-description-foreground">
            {inlineEditingDisabledReason}
          </span>
        ) : null}
        {metadata ?? <CardRowMetadata card={card} archived={archived} />}
        {onOpenPage ? (
          <NodexTooltip tooltipContent="Open Page" side="top">
            <button
              type="button"
              aria-label={`Open ${title}`}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-token-description-foreground opacity-0 group-hover/reference-row:opacity-100 hover:bg-token-foreground/10 hover:text-token-text-primary focus-visible:opacity-100"
              onClick={() =>
                void onOpenPage({
                  accessContext,
                  pageId: card.id,
                  titleSnapshot: title,
                })
              }
            >
              <OpenInIcon aria-hidden="true" className="size-3.5 shrink-0" />
            </button>
          </NodexTooltip>
        ) : null}
      </div>

      {expanded ? (
        <div className="ml-3 min-w-0 border-l-[0.5px] border-token-foreground/10 pl-3">
          {active && renderDocument ? (
            renderDocument({ accessContext, card, isActive: true })
          ) : visible && expandable ? (
            <button
              type="button"
              className="my-1 rounded-md px-2 py-1 text-xs text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-text-primary"
              onClick={() => activationBudget.touch(surfaceInstanceKey)}
            >
              Activate inline editor
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const ReferenceMessage = ({
  icon,
  children,
  tone = "muted",
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly tone?: "muted" | "danger";
}) => (
  <div
    className={cn(
      "flex min-h-8 items-center gap-2 py-1 text-sm",
      tone === "danger" ? "text-token-error-foreground" : "text-token-description-foreground",
    )}
  >
    {icon}
    <span className="min-w-0 truncate">{children}</span>
  </div>
);

export interface DatabaseViewReferenceSurfaceProps extends ReferenceSurfaceStateDependencies {
  readonly referenceKey: string;
  readonly displayHint: string;
  readonly model: DatabaseViewReadModel | null;
  readonly accessContext?: ContentAccessContext;
  readonly loading?: boolean;
  readonly error?: Error | null;
  readonly renderDocument?: ReferencedPageDocumentRenderer;
  readonly onOpenPage?: ReferencedCardRowProps["onOpenPage"];
  readonly hostPageId?: string | null;
  readonly ancestorPageIds?: readonly string[];
}

const EMPTY_ANCESTOR_PAGE_IDS: readonly string[] = [];

export function DatabaseViewReferenceSurface({
  referenceKey,
  displayHint,
  model,
  accessContext,
  loading = false,
  error = null,
  renderDocument,
  onOpenPage,
  hostPageId = null,
  ancestorPageIds = EMPTY_ANCESTOR_PAGE_IDS,
  disclosureStore,
  activationBudget,
  visibilityOverride,
}: DatabaseViewReferenceSurfaceProps) {
  if (loading) {
    return (
      <ReferenceMessage icon={<Rows3 aria-hidden="true" className="size-3.5 shrink-0" />}>
        Loading Database view…
      </ReferenceMessage>
    );
  }
  if (error) {
    return (
      <ReferenceMessage
        tone="danger"
        icon={<TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />}
      >
        {error.message || "Couldn’t load this Database view"}
      </ReferenceMessage>
    );
  }
  if (!model) {
    return (
      <ReferenceMessage icon={<Rows3 aria-hidden="true" className="size-3.5 shrink-0" />}>
        {displayHint.trim() || "Database view unavailable"}
      </ReferenceMessage>
    );
  }

  const name = model.view.name.trim() || displayHint.trim() || "Database view";
  const rowAccessContext =
    accessContext ??
    (model.view.projectId ? projectContentAccess(model.view.projectId) : libraryContentAccess);
  return (
    <section contentEditable={false} data-database-view={model.view.id} className="min-w-0 py-1">
      <header className="flex min-h-8 items-center gap-2 px-1 text-sm">
        <Rows3 aria-hidden="true" className="size-3.5 shrink-0 text-token-description-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium text-token-text-primary">{name}</span>
        <span className="shrink-0 text-xs tabular-nums text-token-description-foreground">
          {model.rows.length}
        </span>
      </header>
      <div className="min-w-0" style={{ contentVisibility: "auto" }}>
        {model.rows.map((row) => {
          const referencesHost = row.page.id === hostPageId;
          const referencesAncestor = isInlineCardCycle(ancestorPageIds, row.page.id);
          return (
            <ReferencedCardRow
              key={row.page.id}
              disclosureKey={`${referenceKey}:${row.page.id}`}
              accessContext={rowAccessContext}
              card={row.page}
              canEdit={!row.page.archived && !referencesAncestor}
              archived={row.page.archived}
              inlineEditingDisabledReason={
                referencesHost ? "Self" : referencesAncestor ? "Cycle" : undefined
              }
              renderDocument={renderDocument}
              onOpenPage={onOpenPage}
              disclosureStore={disclosureStore}
              activationBudget={activationBudget}
              visibilityOverride={visibilityOverride}
            />
          );
        })}
      </div>
    </section>
  );
}
