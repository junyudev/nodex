import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import type { DatabasePropertyOption } from "../../../../shared/database-kernel";
import {
  hasPageStageScheduleCapability,
  pageStageSectionProperties,
  pageStageSemanticValues,
  readPageStageSemanticProperties,
  type PageStageDataSourceProperty,
} from "@/lib/page-stage-properties";
import { projectPageDetailToStageModel } from "@/lib/page-stage-page";
import { PageStageInlinePropertyStrip } from "./inline-property-strip";
import { buildPageDetailStoryResult } from "./page-stage-story-page-detail";
import { buildPageStageStoryPage, PAGE_STAGE_STORY_PROJECT_ID } from "./page-stage-dev-story-data";
import type { PageStagePropertyControls } from "./use-page-stage-properties";

const OPTIONS: Readonly<Record<string, readonly DatabasePropertyOption[]>> = {
  status: [
    { id: "triage", name: "Triage" },
    { id: "build", name: "Build" },
    { id: "review", name: "Review" },
    { id: "ship", name: "Ship" },
  ],
  priority: [
    { id: "p0-critical", name: "Critical" },
    { id: "p1-high", name: "High" },
    { id: "p2-medium", name: "Medium" },
    { id: "p3-low", name: "Low" },
  ],
  estimate: [
    { id: "xs", name: "XS" },
    { id: "s", name: "S" },
    { id: "m", name: "M" },
    { id: "l", name: "L" },
    { id: "xl", name: "XL" },
  ],
};

const buildProperties = (): readonly PageStageDataSourceProperty[] => {
  const page = buildPageStageStoryPage();
  const detail = buildPageDetailStoryResult(PAGE_STAGE_STORY_PROJECT_ID, page);
  if (!detail.ok) throw new Error(detail.error.message);
  const model = projectPageDetailToStageModel(detail.value);
  if (model.databaseContext.kind !== "member") {
    throw new Error("Expected Story Page to be a Data Source member");
  }
  return model.databaseContext.properties;
};

function InlinePropertyStripStory() {
  const [properties, setProperties] = useState(buildProperties);
  const semantic = useMemo(() => readPageStageSemanticProperties(properties), [properties]);
  const controls = useMemo<PageStagePropertyControls>(
    () => ({
      pageId: "page:story",
      properties,
      primaryProperties: properties.filter((item) =>
        ["priority", "status", "estimate", "due_date"].includes(item.property.propertyId),
      ),
      sectionProperties: pageStageSectionProperties(properties, semantic),
      hiddenLayoutProperties: [],
      semanticValues: pageStageSemanticValues(semantic),
      hasScheduleCapability: hasPageStageScheduleCapability(semantic),
      options: OPTIONS,
      optionRegistryStates: {},
      requestOptions: () => undefined,
      requestMoreOptions: () => undefined,
      optionRegistryHasMore: {},
      optionRegistryLoadingMore: {},
      busyPropertyIds: new Set(),
      errors: {},
      edit: async (property, edit) => {
        if (edit.kind === "replace") {
          setProperties((current) =>
            current.map((item) =>
              item.property.propertyId === property.property.propertyId
                ? {
                    ...item,
                    value: edit.value,
                    valueRevision: item.valueRevision + 1,
                  }
                : item,
            ),
          );
        }
        return { status: "updated", didMutate: true };
      },
      patchRelation: async () => ({ status: "updated", didMutate: false }),
      replaceRelation: async () => ({ status: "updated", didMutate: false }),
      patchMultiSelect: async () => ({ status: "updated", didMutate: false }),
      createOptionAndSelect: async () => ({ status: "updated", didMutate: false }),
      loadRelationTargets: async (property) => ({
        valueRevision: property.valueRevision,
        totalCount: 0,
        targets: [],
        nextCursor: null,
        projectionRevision: 0,
      }),
      searchRelationCandidates: async () => ({
        candidates: [],
        nextCursor: null,
        projectionRevision: 0,
      }),
      loadRelationTargetDescriptor: async () => null,
      refreshRelationValue: async () => undefined,
    }),
    [properties, semantic],
  );

  return (
    <div className="min-h-screen bg-(--background) p-8">
      <div className="mx-auto max-w-4xl rounded-[20px] border border-(--border) bg-(--page) p-5">
        <PageStageInlinePropertyStrip controls={controls} />
      </div>
    </div>
  );
}

const meta = {
  title: "Board/Inline Property Strip",
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <InlinePropertyStripStory />,
};
