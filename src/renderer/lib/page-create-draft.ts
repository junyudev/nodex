import type { DatabasePropertyOption } from "../../shared/database-kernel";
import {
  materializePageDocument,
  populateBlockDocumentBodyFromMarkdown,
} from "../../shared/block-documents/block-document-codec";
import {
  createPageDocument,
  type PageDocumentEnvelope,
} from "../../shared/block-documents/page-document";
import type { Estimate, PageCreateInput, Priority } from "./types";
import type { WorkflowStatus } from "./types";
import {
  gatePageCreateInputByCapabilities,
  type PageCreatePropertyCapabilities,
} from "./page-create-capabilities";

export interface PageCreateDescriptionDraft extends PageDocumentEnvelope {
  readonly generation: number;
  readonly clientSessionId: string;
}

export interface BuildPageCreateInputOptions {
  readonly title: string;
  readonly descriptionDraft: PageCreateDescriptionDraft;
  readonly priority: Priority | null;
  readonly estimate: Estimate | null;
  readonly selectedTagIds: readonly string[];
  readonly tagOptions: readonly DatabasePropertyOption[];
  readonly capabilities?: PageCreatePropertyCapabilities;
}

export interface PageCreateDraftSnapshot {
  readonly title: string;
  readonly descriptionMarkdown: string;
  readonly status: WorkflowStatus;
  readonly priority: Priority | null;
  readonly estimate: Estimate | null;
  readonly tagNames: readonly string[];
  readonly createMore: boolean;
  readonly expanded: boolean;
}

export interface CapturePageCreateDraftSnapshotOptions {
  readonly title: string;
  readonly descriptionDraft: PageCreateDescriptionDraft;
  readonly status: WorkflowStatus;
  readonly priority: Priority | null;
  readonly estimate: Estimate | null;
  readonly selectedTagIds: readonly string[];
  readonly tagOptions: readonly DatabasePropertyOption[];
  readonly createMore: boolean;
  readonly expanded: boolean;
}

export const createPageCreateDescriptionDraft = (
  requestId: string,
  generation = 0,
  descriptionMarkdown = "",
): PageCreateDescriptionDraft => {
  const normalizedRequestId = requestId.trim();
  if (!normalizedRequestId) {
    throw new TypeError("Page create requestId must not be empty");
  }
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError("Page create draft generation must be a non-negative integer");
  }

  const documentId = `draft:page-create:${normalizedRequestId}:${generation}`;
  const envelope = createPageDocument({
    documentId,
    initializeBody: false,
  });
  try {
    populateBlockDocumentBodyFromMarkdown(envelope.body, descriptionMarkdown);
    return {
      ...envelope,
      generation,
      clientSessionId: documentId,
    };
  } catch (cause) {
    envelope.document.destroy();
    throw cause;
  }
};

export const materializePageCreateDescription = (draft: PageCreateDescriptionDraft): string =>
  materializePageDocument(draft.document).markdown;

export const resolvePageCreateTagNames = (
  selectedIds: readonly string[],
  options: readonly DatabasePropertyOption[],
): string[] => resolvePageCreateTagOptions(selectedIds, options).map((option) => option.name);

export const resolvePageCreateTagOptions = (
  selectedIds: readonly string[],
  options: readonly DatabasePropertyOption[],
): NonNullable<PageCreateInput["tagOptions"]> => {
  const optionById = new Map(options.map((option) => [option.id, option]));
  const selected = selectedIds.map((selectedId) => {
    const option = optionById.get(selectedId);
    if (!option) {
      throw new Error("A selected tag is no longer available");
    }
    const name = option.name.trim();
    if (!name) {
      throw new Error("Tags must have a name");
    }
    return { optionId: option.id, name };
  });
  const seenNames = new Set<string>();
  return selected.filter((option) => {
    if (seenNames.has(option.name)) return false;
    seenNames.add(option.name);
    return true;
  });
};

const resolveRecoverablePageCreateTagNames = (
  selectedIds: readonly string[],
  options: readonly DatabasePropertyOption[],
): string[] => {
  const optionById = new Map(options.map((option) => [option.id, option]));
  return [
    ...new Set(
      selectedIds.flatMap((selectedId) => {
        const name = optionById.get(selectedId)?.name.trim() ?? "";
        return name ? [name] : [];
      }),
    ),
  ];
};

export const buildPageCreateInput = ({
  title,
  descriptionDraft,
  priority,
  estimate,
  selectedTagIds,
  tagOptions,
  capabilities,
}: BuildPageCreateInputOptions): PageCreateInput => {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    throw new Error("Page title is required");
  }

  const input: PageCreateInput = {
    title: normalizedTitle,
    description: materializePageCreateDescription(descriptionDraft),
    priority: priority ?? undefined,
    estimate: estimate ?? undefined,
    tagOptions: resolvePageCreateTagOptions(selectedTagIds, tagOptions),
  };
  return capabilities ? gatePageCreateInputByCapabilities(input, capabilities) : input;
};

export const capturePageCreateDraftSnapshot = ({
  title,
  descriptionDraft,
  status,
  priority,
  estimate,
  selectedTagIds,
  tagOptions,
  createMore,
  expanded,
}: CapturePageCreateDraftSnapshotOptions): PageCreateDraftSnapshot => ({
  title,
  descriptionMarkdown: materializePageCreateDescription(descriptionDraft),
  status,
  priority,
  estimate,
  tagNames: resolveRecoverablePageCreateTagNames(selectedTagIds, tagOptions),
  createMore,
  expanded,
});

export const createEmptyPageCreateDraftSnapshot = (
  status: WorkflowStatus,
  options: Partial<
    Pick<PageCreateDraftSnapshot, "priority" | "estimate" | "tagNames" | "createMore" | "expanded">
  > = {},
): PageCreateDraftSnapshot => ({
  title: "",
  descriptionMarkdown: "",
  status,
  priority: options.priority ?? null,
  estimate: options.estimate ?? null,
  tagNames: [...(options.tagNames ?? [])],
  createMore: options.createMore ?? false,
  expanded: options.expanded ?? false,
});

export const pageCreateDraftSnapshotsEqual = (
  left: PageCreateDraftSnapshot,
  right: PageCreateDraftSnapshot,
): boolean =>
  left.title === right.title &&
  left.descriptionMarkdown === right.descriptionMarkdown &&
  left.status === right.status &&
  left.priority === right.priority &&
  left.estimate === right.estimate &&
  left.createMore === right.createMore &&
  left.expanded === right.expanded &&
  left.tagNames.length === right.tagNames.length &&
  left.tagNames.every((name, index) => name === right.tagNames[index]);
