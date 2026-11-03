import { deferred } from "../agent-instance-settings.test-fixtures";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../../../shared/database-identities";
import type {
  DatabaseViewRecordV2,
  DataSourceRecordV2,
} from "../../../../shared/database-module-v2";
import type { DatabaseViewConditionalColorRule } from "../../../../shared/database-kernel";
import { testPropertySemantics } from "../../../../shared/testing/database-property-record";
import { emptyDatabaseViewConfig } from "@/lib/database-view-authoring";
import type { DatabaseViewRenderModel } from "@/lib/database-view-render-model";
import { render } from "@/test/dom";
import { DatabaseSettingsRail } from "./database-settings-rail";
import type { DatabaseSettingsRuntime } from "./use-database-settings-runtime";

const databaseId = parseDatabaseId("database-colors");
const dataSourceId = parseDataSourceId("source-colors");
const viewId = parseDatabaseViewId("view-colors");
const propertyId = parseDataSourcePropertyId("p_NAME0001");
const timestamp = "2026-01-01T00:00:00.000Z";
const view: DatabaseViewRecordV2 = {
  viewId,
  databaseId,
  dataSourceId,
  name: "Tasks",
  layout: "list",
  isDefault: true,
  revision: 1,
  rankKey: "a",
  lifecycle: "active",
  createdAt: timestamp,
  updatedAt: timestamp,
  config: {
    ...emptyDatabaseViewConfig(),
    presentation: {
      ...emptyDatabaseViewConfig().presentation,
      conditionalColors: ["rule-a", "rule-b"].map((ruleId) => ({
        ruleId,
        propertyId,
        operator: "is_not_empty",
        color: "blue",
        colorSource: "fixed",
      })),
    },
  },
};
const dataSource: DataSourceRecordV2 = {
  dataSourceId,
  libraryId: "library",
  homeDatabaseId: databaseId,
  name: "Tasks",
  schemaKey: "tasks",
  schemaRevision: 1,
  lifecycle: "active",
  rankKey: "a",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const database = {
  databaseId,
  libraryId: "library",
  name: "Tasks",
  lifecycle: "active",
  defaultViewId: viewId,
  metadataRevision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;
const property = {
  propertyId,
  dataSourceId,
  name: "Name",
  ...testPropertySemantics("text"),
  valueType: "text",
  config: {},
  rankKey: "a",
  lifecycle: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;
const source = { dataSource, properties: [property] };
const descriptor = { database, dataSources: [dataSource], views: [view] };
const runtime: DatabaseSettingsRuntime = {
  authority: {
    snapshot: {
      projectId: "project",
      libraryId: "library",
      storeEpoch: "epoch",
      commitSeq: 1,
      value: { kind: "database", value: descriptor },
    },
    database: descriptor,
    view,
    dataSource,
    source,
  },
  loading: false,
  pendingKey: null,
  error: null,
  pageLayout: null,
  pageLayoutLoading: false,
  loadPageLayout: async () => null,
  refresh: async () => null,
  mutate: async () => null,
};
const model: DatabaseViewRenderModel = {
  libraryId: "library",
  routingContext: { kind: "project", projectId: "project" },
  databaseViewId: viewId,
  databaseId,
  dataSourceId,
  databaseName: "Tasks",
  dataSourceName: "Tasks",
  viewName: "Tasks",
  storeEpoch: "epoch",
  commitSeq: 1,
  columns: [],
  query: { database, dataSource, view, properties: [property], rows: [] },
};
const presentation = { layout: view.layout, ...view.config };

test("releases a failed color synchronization so a newer draft can publish", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const publish = vi
    .fn<(rules: readonly DatabaseViewConditionalColorRule[]) => Promise<void>>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockResolvedValue(undefined);
  const preview = vi.fn();
  const settings = render(
    <DatabaseSettingsRail
      runtime={runtime}
      routeStack={[{ kind: "view_conditional_color", viewId }]}
      model={model}
      effectivePresentation={presentation}
      durablePresentation={presentation}
      viewNameFocusRequest={0}
      presentationActivity={{ phase: "ready", interactionLocked: false }}
      presentationError={null}
      optionRegistries={{}}
      onRequestPropertyOptions={() => undefined}
      onChangePresentation={() => undefined}
      onResetPresentation={() => undefined}
      onPublishPresentation={() => undefined}
      onPreviewConditionalColors={preview}
      onPublishConditionalColors={publish}
      onProjectionCommitted={() => undefined}
      onSelectView={() => undefined}
      onPush={() => undefined}
      onReplace={() => undefined}
      onBack={() => undefined}
      onClose={() => undefined}
    />,
  );
  await act(async () => {
    fireEvent.click(
      settings.getAllByRole("button", { name: "Delete conditional color for Name" })[0]!,
    );
    await Promise.resolve();
  });
  await waitFor(() => expect(publish).toHaveBeenCalledOnce());
  expect(publish.mock.calls[0]?.[0]).toEqual([view.config.presentation.conditionalColors[1]]);

  await act(async () => {
    fireEvent.click(settings.getByRole("button", { name: "Delete conditional color for Name" }));
    await Promise.resolve();
  });
  expect(publish).toHaveBeenCalledOnce();
  await act(async () => {
    first.reject(new Error("Synchronization failed"));
    await Promise.resolve();
  });
  expect((await settings.findByRole("alert")).textContent).toBe("Synchronization failed");
  await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
  expect(publish.mock.calls[1]?.[0]).toEqual([]);
  await act(async () => {
    second.resolve();
    await Promise.resolve();
  });
  await waitFor(() => expect(preview).toHaveBeenLastCalledWith(null));
  expect(settings.queryByRole("alert")).toBeNull();
});
