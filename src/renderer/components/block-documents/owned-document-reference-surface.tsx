import { ChevronRightIcon } from "@/components/shared/icons";
import { useId, type ReactNode } from "react";

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
import { useElementVisibility } from "@/lib/use-element-visibility";
import { cn } from "@/lib/utils";

export interface OwnedDocumentReferenceRenderInput {
  readonly ownerBlockId: string;
  readonly isActive: boolean;
}

export type OwnedDocumentReferenceRenderer = (
  input: OwnedDocumentReferenceRenderInput,
) => ReactNode;

export interface OwnedDocumentReferenceStateDependencies {
  readonly disclosureStore?: BlockDisclosureStateStore;
  readonly activationBudget?: ReferenceSurfaceActivationBudget;
  /** Deterministic visibility for focused tests; production uses IntersectionObserver. */
  readonly visibilityOverride?: boolean;
}

export interface OwnedDocumentReferenceSurfaceProps extends OwnedDocumentReferenceStateDependencies {
  readonly disclosureKey: string;
  readonly ownerBlockId: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly detail: string;
  readonly disabledReason?: string;
  readonly renderDocument?: OwnedDocumentReferenceRenderer;
}

/**
 * Per-user disclosure shell for a body-only document-bearing Block. The host
 * Y.Doc owns only this row and its stable target identity. Provider activation
 * remains per-mount and eligible only while expanded and visible.
 */
export function OwnedDocumentReferenceSurface({
  disclosureKey,
  ownerBlockId,
  icon,
  label,
  detail,
  disabledReason,
  renderDocument,
  disclosureStore = blockDisclosureStateStore,
  activationBudget = referenceSurfaceActivationBudget,
  visibilityOverride,
}: OwnedDocumentReferenceSurfaceProps) {
  const surfaceInstanceId = useId();
  const surfaceInstanceKey = `owned-document:${disclosureKey}:mount:${surfaceInstanceId}`;
  const [preferredExpanded, setExpanded] = useBlockDisclosure(disclosureKey, disclosureStore);
  const visibility = useElementVisibility();
  const visible = visibilityOverride ?? visibility.visible;
  const normalizedOwnerBlockId = ownerBlockId.trim();
  const expandable =
    normalizedOwnerBlockId.length > 0 && !disabledReason && typeof renderDocument === "function";
  const expanded = expandable && preferredExpanded;
  const eligible = expandable && expanded && visible;
  const budgetActive = useReferenceSurfaceActivation(
    surfaceInstanceKey,
    eligible,
    activationBudget,
  );
  const active = eligible && budgetActive;
  const displayDetail = detail.trim() || "Untitled";
  const accessibleName = `${label}: ${displayDetail}`;
  const renderExpandedContent = (): ReactNode => {
    if (active && renderDocument) {
      return renderDocument({
        ownerBlockId: normalizedOwnerBlockId,
        isActive: true,
      });
    }
    if (!visible || !expandable) return null;
    return (
      <button
        type="button"
        className="my-1 rounded-md px-2 py-1 text-xs text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-text-primary"
        onClick={() => activationBudget.touch(surfaceInstanceKey)}
      >
        Activate inline editor
      </button>
    );
  };

  return (
    <section
      ref={visibility.ref}
      contentEditable={false}
      data-document-bearing-owner-id={normalizedOwnerBlockId || undefined}
      data-owned-document-expanded={expanded ? "true" : "false"}
      data-owned-document-editor-active={active ? "true" : "false"}
      className="min-w-0 py-0.5"
      onFocusCapture={() => activationBudget.touch(surfaceInstanceKey)}
      onPointerDownCapture={() => activationBudget.touch(surfaceInstanceKey)}
    >
      <div className="group/owned-document flex min-h-8 min-w-0 items-center gap-1 rounded-md px-1 hover:bg-token-foreground/5">
        <button
          type="button"
          aria-label={expanded ? `Collapse ${accessibleName}` : `Expand ${accessibleName}`}
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
        <span className="shrink-0 text-token-description-foreground">{icon}</span>
        <span className="shrink-0 text-xs font-medium text-token-text-secondary">{label}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-token-description-foreground">
          {displayDetail}
        </span>
        {disabledReason ? (
          <span className="shrink-0 text-[11px] text-token-description-foreground">
            {disabledReason}
          </span>
        ) : null}
      </div>

      {expanded ? (
        <div className="ml-3 min-w-0 border-l-[0.5px] border-token-foreground/10 pl-3">
          {renderExpandedContent()}
        </div>
      ) : null}
    </section>
  );
}
