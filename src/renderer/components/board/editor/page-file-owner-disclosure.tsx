import { useContentPageDetail } from "@/lib/content-page-detail";
import { cn } from "@/lib/utils";

import { useBlockReferenceHostRuntime } from "../../block-documents/block-reference-runtime-context";
import { parsePageFileSource } from "../../../../shared/page-files";
import { usePageFilePlacementRuntime, usePageFileReadSnapshot } from "./page-file-runtime";

export interface PageFileOwnerDisclosureModel {
  readonly label: string;
  readonly ownerTitle: string | null;
  readonly openable: boolean;
}

export function resolvePageFileOwnerDisclosure(input: {
  readonly containingPageId: string | null;
  readonly ownerPageId: string | null;
  readonly ownerTitle: string | null;
  readonly ownerReadable: boolean;
  readonly canOpen: boolean;
}): PageFileOwnerDisclosureModel | null {
  if (!input.containingPageId || !input.ownerPageId) return null;
  if (input.containingPageId === input.ownerPageId) return null;

  const ownerTitle = input.ownerReadable ? input.ownerTitle?.trim() || "Untitled" : null;
  return ownerTitle
    ? {
        label: `From ${ownerTitle}`,
        ownerTitle,
        openable: input.canOpen,
      }
    : {
        label: "From another Page",
        ownerTitle: null,
        openable: false,
      };
}

function PageFileOwnerDisclosurePresentation({
  model,
  onOpen,
  className,
}: {
  readonly model: PageFileOwnerDisclosureModel;
  readonly onOpen?: () => void;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1 text-xs text-token-description-foreground",
        className,
      )}
    >
      {model.openable && model.ownerTitle && onOpen ? (
        <>
          <span className="shrink-0">From</span>
          <button
            type="button"
            className="min-w-0 truncate text-left text-token-text-secondary underline decoration-token-border underline-offset-2 hover:text-token-text-primary"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpen();
            }}
          >
            {model.ownerTitle}
          </button>
        </>
      ) : (
        <span className="truncate">{model.label}</span>
      )}
    </div>
  );
}

function ReadablePageFileOwnerDisclosure({
  ownerPageId,
  libraryId,
  className,
}: {
  readonly ownerPageId: string;
  readonly libraryId: string;
  readonly className?: string;
}) {
  const runtime = usePageFilePlacementRuntime();
  const host = useBlockReferenceHostRuntime();
  const accessContext = runtime?.authority.contentAccessContext ?? { kind: "library" as const };
  const detail = useContentPageDetail(libraryId, accessContext, ownerPageId);
  if (!detail.detail && !detail.error) return null;

  const model = resolvePageFileOwnerDisclosure({
    containingPageId: runtime?.authority.pageId ?? null,
    ownerPageId,
    ownerTitle: detail.detail?.page.title ?? null,
    ownerReadable: detail.detail !== null,
    canOpen: detail.detail !== null && Boolean(host?.openPage),
  });
  if (!model) return null;

  return (
    <PageFileOwnerDisclosurePresentation
      model={model}
      className={className}
      onOpen={
        model.openable && host?.openPage
          ? () => {
              void host.openPage?.({
                accessContext,
                pageId: ownerPageId,
                ...(model.ownerTitle ? { titleSnapshot: model.ownerTitle } : {}),
              });
            }
          : undefined
      }
    />
  );
}

export function PageFileOwnerDisclosure({
  ownerPageId,
  className,
}: {
  readonly ownerPageId: string | null | undefined;
  readonly className?: string;
}) {
  const runtime = usePageFilePlacementRuntime();
  const model = resolvePageFileOwnerDisclosure({
    containingPageId: runtime?.authority.pageId ?? null,
    ownerPageId: ownerPageId ?? null,
    ownerTitle: null,
    ownerReadable: false,
    canOpen: false,
  });
  if (!model || !ownerPageId) return null;

  const libraryId = runtime?.authority.libraryId;
  if (libraryId) {
    return (
      <ReadablePageFileOwnerDisclosure
        ownerPageId={ownerPageId}
        libraryId={libraryId}
        className={className}
      />
    );
  }
  return <PageFileOwnerDisclosurePresentation model={model} className={className} />;
}

export function PageFileOwnerDisclosureForSource({
  source,
  className,
}: {
  readonly source: string;
  readonly className?: string;
}) {
  const runtime = usePageFilePlacementRuntime();
  const isPageFile = parsePageFileSource(source) !== null;
  const snapshot = usePageFileReadSnapshot(runtime, source, { metadata: isPageFile });
  if (!isPageFile) return null;
  return (
    <PageFileOwnerDisclosure ownerPageId={snapshot.metadata?.ownerPageId} className={className} />
  );
}
