export type PageStagePropertySignal = "unresolved" | "quiet" | "informative" | "attention";

export interface PageStageQuietPropertiesInput {
  readonly pageId: string;
  readonly files: {
    readonly signal: PageStagePropertySignal;
    readonly manifestRevision: number | null;
  };
  readonly linkedChats: {
    readonly signal: PageStagePropertySignal;
  };
}

interface StickyPropertyVisibility {
  readonly resolved: boolean;
  readonly visible: boolean;
}

interface StickyFilePropertyVisibility extends StickyPropertyVisibility {
  readonly manifestRevision: number | null;
}

export interface PageStageQuietPropertiesState {
  readonly pageId: string;
  readonly files: StickyFilePropertyVisibility;
  readonly linkedChats: StickyPropertyVisibility;
}

const signalIsVisible = (signal: PageStagePropertySignal): boolean =>
  signal === "informative" || signal === "attention";

export function resolvePageFilesPropertySignal(input: {
  readonly hasManifest: boolean;
  readonly unplacedTotal: number;
  readonly hasError: boolean;
}): PageStagePropertySignal {
  if (input.hasError) return "attention";
  if (!input.hasManifest) return "unresolved";
  return input.unplacedTotal > 0 ? "informative" : "quiet";
}

export function resolveLinkedChatsPropertySignal(input: {
  readonly count: number;
  readonly loading: boolean;
  readonly hasError: boolean;
}): PageStagePropertySignal {
  if (input.hasError) return "attention";
  if (input.count > 0) return "informative";
  return input.loading ? "unresolved" : "quiet";
}

export function formatPageStageQuietPropertyCountLabel(count: number, expanded: boolean): string {
  const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  const suffix = normalizedCount === 1 ? "property" : "properties";

  return expanded ? `Hide ${normalizedCount} ${suffix}` : `${normalizedCount} more ${suffix}`;
}

export function createPageStageQuietPropertiesState(
  input: PageStageQuietPropertiesInput,
): PageStageQuietPropertiesState {
  return {
    pageId: input.pageId,
    files: {
      resolved: input.files.signal !== "unresolved",
      visible: signalIsVisible(input.files.signal),
      manifestRevision: input.files.manifestRevision,
    },
    linkedChats: {
      resolved: input.linkedChats.signal !== "unresolved",
      visible: signalIsVisible(input.linkedChats.signal),
    },
  };
}

/**
 * Keeps promoted rows stable for one mounted Page. File placement churn alone
 * cannot promote Files; a manifest change or attention state can.
 */
export function advancePageStageQuietPropertiesState(
  current: PageStageQuietPropertiesState,
  input: PageStageQuietPropertiesInput,
): PageStageQuietPropertiesState {
  if (current.pageId !== input.pageId) return createPageStageQuietPropertiesState(input);

  const files = (() => {
    if (input.files.signal === "unresolved") return current.files;

    const manifestChanged =
      current.files.resolved &&
      input.files.manifestRevision !== null &&
      input.files.manifestRevision !== current.files.manifestRevision;
    const visible =
      current.files.visible ||
      input.files.signal === "attention" ||
      (!current.files.resolved && input.files.signal === "informative") ||
      (manifestChanged && input.files.signal === "informative");
    const next = {
      resolved: true,
      visible,
      manifestRevision: input.files.manifestRevision,
    };

    return next.resolved === current.files.resolved &&
      next.visible === current.files.visible &&
      next.manifestRevision === current.files.manifestRevision
      ? current.files
      : next;
  })();

  const linkedChats = (() => {
    if (input.linkedChats.signal === "unresolved") return current.linkedChats;

    const next = {
      resolved: true,
      visible: current.linkedChats.visible || signalIsVisible(input.linkedChats.signal),
    };

    return next.resolved === current.linkedChats.resolved &&
      next.visible === current.linkedChats.visible
      ? current.linkedChats
      : next;
  })();

  if (files === current.files && linkedChats === current.linkedChats) return current;
  return { pageId: current.pageId, files, linkedChats };
}
