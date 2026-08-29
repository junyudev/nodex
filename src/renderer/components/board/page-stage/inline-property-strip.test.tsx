import { describe, expect, test, vi } from "vite-plus/test";
import type { PageDetail } from "../../../../shared/page-detail";
import { render } from "@/test/dom";
import { buildPageStageStoryPage } from "./page-stage-dev-story-data";
import { buildPageDetailStoryResult } from "./page-stage-story-page-detail";
import { projectPageDetailToStageModel } from "@/lib/page-stage-page";
import {
  hasPageStageScheduleCapability,
  isPageStagePrimaryProperty,
  pageStageSectionProperties,
  pageStageSemanticValues,
} from "@/lib/page-stage-properties";
import { PageStageInlinePropertyStrip } from "./inline-property-strip";
import type { PageStagePropertyControls } from "./use-page-stage-properties";

const detail = (): PageDetail => {
  const result = buildPageDetailStoryResult("project-1", buildPageStageStoryPage());
  if (!result.ok) throw new Error("Expected Page Detail fixture");
  return result.value;
};

const withoutProperties = (source: PageDetail, removedIds: ReadonlySet<string>): PageDetail => {
  if (source.dataSourceContext.kind !== "member") return source;
  return {
    ...source,
    dataSourceContext: {
      ...source.dataSourceContext,
      properties: source.dataSourceContext.properties.filter(
        (property) => !removedIds.has(property.propertyId),
      ),
      values: Object.fromEntries(
        Object.entries(source.dataSourceContext.values).filter(
          ([propertyId]) => !removedIds.has(propertyId),
        ),
      ),
    },
  };
};

describe("PageStageInlinePropertyStrip", () => {
  test("renders remaining primary Properties when Due date and Assignee are deleted", () => {
    const model = projectPageDetailToStageModel(
      withoutProperties(detail(), new Set(["due_date", "assignee"])),
    );
    if (model.databaseContext.kind !== "member") {
      throw new Error("Expected member Data Source context");
    }
    const properties = model.databaseContext.properties;
    const semantic = model.databaseContext.semanticProperties;
    const controls: PageStagePropertyControls = {
      pageId: "page:test",
      properties,
      primaryProperties: properties.filter(isPageStagePrimaryProperty),
      sectionProperties: pageStageSectionProperties(properties, semantic),
      hiddenLayoutProperties: [],
      semanticValues: pageStageSemanticValues(semantic),
      hasScheduleCapability: hasPageStageScheduleCapability(semantic),
      options: {},
      optionRegistryStates: { status: "loading", priority: "loading", estimate: "loading" },
      requestOptions: vi.fn(),
      requestMoreOptions: vi.fn(),
      optionRegistryHasMore: {},
      optionRegistryLoadingMore: {},
      busyPropertyIds: new Set(),
      errors: {},
      edit: vi.fn(async () => ({ status: "updated", didMutate: true }) as const),
      patchRelation: vi.fn(async () => ({ status: "updated", didMutate: true }) as const),
      replaceRelation: vi.fn(async () => ({ status: "updated", didMutate: true }) as const),
      patchMultiSelect: vi.fn(async () => ({ status: "updated", didMutate: true }) as const),
      createOptionAndSelect: vi.fn(async () => ({ status: "updated", didMutate: true }) as const),
      loadRelationTargets: vi.fn(async (property) => ({
        valueRevision: property.valueRevision,
        totalCount: 0,
        targets: [],
        nextCursor: null,
        projectionRevision: 0,
      })),
      searchRelationCandidates: vi.fn(async () => ({
        candidates: [],
        nextCursor: null,
        projectionRevision: 0,
      })),
      loadRelationTargetDescriptor: vi.fn(async () => null),
      refreshRelationValue: vi.fn(async () => undefined),
    };
    const view = render(<PageStageInlinePropertyStrip controls={controls} />);

    expect(view.getByText(/^status$/i)).toBeTruthy();
    expect(view.getByText(/^priority$/i)).toBeTruthy();
    expect(view.getByText(/^estimate$/i)).toBeTruthy();
    expect(view.queryByText(/^due date$/i)).toBeNull();
    expect(view.queryByText(/^assignee$/i)).toBeNull();
  });
});
