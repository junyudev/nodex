import { lazy, Suspense, type ComponentType } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { LayoutTemplate } from "@/components/shared/icons/generic-icons";
import {
  isInlineDocumentOwnerCycle,
  useBlockReferenceHostRuntime,
} from "@/components/block-documents/block-reference-runtime-context";
import {
  OwnedDocumentReferenceSurface,
  type OwnedDocumentReferenceStateDependencies,
  type OwnedDocumentReferenceRenderer,
} from "@/components/block-documents/owned-document-reference-surface";
import { reusableTemplateRefBlockConfig } from "../../../../shared/block-documents/blocknote-schema-config";

const EmbeddedOwnedBlockDocument = lazy(() =>
  import("./embedded-owned-block-document").then((module) => ({
    default: module.EmbeddedOwnedBlockDocument,
  })),
);

export interface DocumentBearingShellVisualProps extends OwnedDocumentReferenceStateDependencies {
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly detail: string;
  readonly identity?: string;
  readonly disclosureKey?: string;
  readonly disabledReason?: string;
  readonly renderDocument?: OwnedDocumentReferenceRenderer;
}

/** Host-Document shell. Its optional body renderer always targets another Y.Doc. */
export function DocumentBearingShellVisual({
  icon: Icon,
  label,
  detail,
  identity,
  disclosureKey = `document-bearing:${identity ?? "unscoped"}`,
  disabledReason,
  renderDocument,
  disclosureStore,
  activationBudget,
  visibilityOverride,
}: DocumentBearingShellVisualProps) {
  return (
    <OwnedDocumentReferenceSurface
      disclosureKey={disclosureKey}
      ownerBlockId={identity ?? ""}
      icon={<Icon className="icon-2xs shrink-0" />}
      label={label}
      detail={detail}
      disabledReason={disabledReason}
      renderDocument={renderDocument}
      disclosureStore={disclosureStore}
      activationBudget={activationBudget}
      visibilityOverride={visibilityOverride}
    />
  );
}

export interface DocumentBearingShellBlockProps extends Omit<
  DocumentBearingShellVisualProps,
  "disclosureKey" | "disabledReason" | "renderDocument"
> {
  readonly shellBlockId: string;
}

const resolveShellDisabledReason = (input: {
  readonly hasOwner: boolean;
  readonly hasHost: boolean;
  readonly cycle: boolean;
}): string | undefined => {
  if (!input.hasOwner) return "Missing source";
  if (!input.hasHost) return "Unavailable";
  if (input.cycle) return "Cycle";
  return undefined;
};

export function DocumentBearingShellBlock({
  shellBlockId,
  identity = "",
  ...visual
}: DocumentBearingShellBlockProps) {
  const host = useBlockReferenceHostRuntime();
  const ownerBlockId = identity.trim();
  const cycle =
    ownerBlockId.length > 0 &&
    isInlineDocumentOwnerCycle(host?.ancestorDocumentOwnerBlockIds ?? [], ownerBlockId);
  const disabledReason = resolveShellDisabledReason({
    hasOwner: ownerBlockId.length > 0,
    hasHost: host !== null,
    cycle,
  });
  const renderDocument: OwnedDocumentReferenceRenderer | undefined =
    host && !disabledReason
      ? ({ isActive }) => (
          <Suspense
            fallback={
              <div className="py-2 text-sm text-token-description-foreground">
                Opening collaborative content…
              </div>
            }
          >
            <EmbeddedOwnedBlockDocument
              ownerBlockId={ownerBlockId}
              isActive={isActive && host.isActiveSurface}
              hostRuntime={host}
            />
          </Suspense>
        )
      : undefined;

  return (
    <DocumentBearingShellVisual
      {...visual}
      identity={ownerBlockId}
      disclosureKey={shellBlockId}
      disabledReason={disabledReason}
      renderDocument={renderDocument}
    />
  );
}

export const createReusableTemplateRefBlockSpec = createReactBlockSpec(
  reusableTemplateRefBlockConfig,
  {
    render: ({ block }) => (
      <DocumentBearingShellBlock
        icon={LayoutTemplate}
        label="Template"
        detail={block.props.displayHint || "Reusable content"}
        identity={block.props.sourceBlockId}
        shellBlockId={block.id}
      />
    ),
  },
);
