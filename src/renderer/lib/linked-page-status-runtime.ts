import { libraryContentRoute } from "../../shared/content-routing-context";
import { MAX_DATA_SOURCE_PROPERTY_OPTIONS } from "../../shared/data-source-option-registry";
import type { DatabasePropertyOption } from "../../shared/database-kernel";
import type { LibraryPageDetail } from "../../shared/page-detail";
import { createUuidV7 } from "../../shared/uuid-v7";
import { readLibraryPageDetail } from "./api";
import {
  mergePropertyOptionPages,
  propertyOptionWindowMatchesProjection,
  readPropertyOptionWindow,
  type PropertyOptionWindow,
} from "./database-property-options-runtime";
import { commitLibraryPageDetailPropertyEdit } from "./page-detail-metadata-runtime";
import type { PageStageMetadataMutationResult } from "./page-stage-page";

export interface LinkedPageStatusPort {
  readonly loadOptions: (pageId: string) => Promise<readonly DatabasePropertyOption[]>;
  readonly updateStatus: (pageId: string, statusOptionId: string) => Promise<void>;
}

export interface LinkedPageStatusRuntimeDependencies {
  readonly readDetail: (pageId: string) => Promise<LibraryPageDetail | null>;
  readonly readOptionWindow: (
    property: Extract<
      LibraryPageDetail["dataSourceContext"],
      { readonly kind: "member" }
    >["properties"][number],
    after: string | null,
  ) => Promise<PropertyOptionWindow>;
  readonly commitPropertyEdit: (input: {
    readonly pageId: string;
    readonly propertyId: string;
    readonly operationId: string;
    readonly expectedValueRevision: number;
    readonly value: string;
  }) => Promise<PageStageMetadataMutationResult>;
  readonly createOperationId?: () => string;
}

const DEFAULT_DEPENDENCIES: LinkedPageStatusRuntimeDependencies = {
  readDetail: async (pageId) => {
    const result = await readLibraryPageDetail(pageId);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  },
  readOptionWindow: (property, after) =>
    readPropertyOptionWindow(libraryContentRoute, property, after),
  commitPropertyEdit: async ({ pageId, propertyId, operationId, expectedValueRevision, value }) =>
    await commitLibraryPageDetailPropertyEdit({
      pageId,
      propertyId,
      operationId,
      edit: {
        kind: "replace",
        expectedValueRevision,
        value,
      },
    }),
  createOperationId: createUuidV7,
};

function requireStatusProperty(detail: LibraryPageDetail) {
  if (detail.dataSourceContext.kind !== "member") {
    throw new Error("This Page does not have a Status property");
  }
  const property = detail.dataSourceContext.properties.find(
    (candidate) =>
      candidate.propertyId === "status" &&
      candidate.lifecycle === "active" &&
      candidate.valueType === "select",
  );
  if (!property) {
    throw new Error("This Page does not have an active Status property");
  }
  return {
    property,
    currentValue: detail.dataSourceContext.values[property.propertyId]?.value ?? null,
    currentValueRevision: detail.dataSourceContext.values[property.propertyId]?.revision ?? 0,
  };
}

/** Loads all Status options for a linked Page's Data Source through the bounded option registry. */
export async function loadLinkedPageStatusOptions(
  pageId: string,
  dependencies: LinkedPageStatusRuntimeDependencies = DEFAULT_DEPENDENCIES,
): Promise<readonly DatabasePropertyOption[]> {
  const detail = await dependencies.readDetail(pageId);
  if (!detail) throw new Error("Page is unavailable");
  const { property } = requireStatusProperty(detail);

  let options: readonly DatabasePropertyOption[] = [];
  let after: string | null = null;
  let projectionRevision: number | null = null;
  const seenCursors = new Set<string>();

  while (true) {
    let page: PropertyOptionWindow;
    let replace = after === null;
    try {
      page = await dependencies.readOptionWindow(property, after);
    } catch (cause) {
      if (after === null) throw cause;
      page = await dependencies.readOptionWindow(property, null);
      replace = true;
    }
    if (
      !replace &&
      !propertyOptionWindowMatchesProjection(projectionRevision, page.projectionRevision)
    ) {
      page = await dependencies.readOptionWindow(property, null);
      replace = true;
    }
    if (replace) {
      seenCursors.clear();
      options = page.options;
    } else {
      options = mergePropertyOptionPages(options, page.options);
    }
    if (options.length > MAX_DATA_SOURCE_PROPERTY_OPTIONS) {
      throw new Error("Status option registry exceeded its declared bound");
    }
    projectionRevision = page.projectionRevision;
    if (!page.nextCursor) return options;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("Status option registry returned a repeated cursor");
    }
    seenCursors.add(page.nextCursor);
    after = page.nextCursor;
  }
}

/** Commits a Status select value update for a linked Page using its observed value revision. */
export async function updateLinkedPageStatus(
  input: {
    readonly pageId: string;
    readonly statusOptionId: string;
  },
  dependencies: LinkedPageStatusRuntimeDependencies = DEFAULT_DEPENDENCIES,
): Promise<PageStageMetadataMutationResult> {
  const detail = await dependencies.readDetail(input.pageId);
  if (!detail) return { status: "not_found" };
  const { property, currentValue, currentValueRevision } = requireStatusProperty(detail);
  if (currentValue === input.statusOptionId) {
    return { status: "updated", didMutate: false };
  }
  const createOperationId = dependencies.createOperationId ?? createUuidV7;
  return await dependencies.commitPropertyEdit({
    pageId: input.pageId,
    propertyId: property.propertyId,
    operationId: createOperationId(),
    expectedValueRevision: currentValueRevision,
    value: input.statusOptionId,
  });
}
