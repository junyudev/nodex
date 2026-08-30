import {
  createCustomOptionId,
  createCustomPropertyId,
  parseDatabaseViewId,
  parseDataSourceId,
  type DataSourceId,
  type DataSourcePropertyId,
} from "../../../src/shared/database-identities";
import type {
  DatabaseApplyResultV2,
  DatabaseModuleReadResultV2,
  DatabasePropertySchemaV2,
} from "../../../src/shared/database-module-v2";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const DATABASE_SETTINGS_CONFIGURATION_SCENARIO_ID =
  "database/settings-configuration" as const;
export const DATABASE_SETTINGS_CONFIGURATION_SCENARIO_REVISION = 2 as const;

interface ConfiguredProperty {
  readonly id: DataSourcePropertyId;
  readonly kind: DatabasePropertySchemaV2["kind"];
}

export interface DatabaseSettingsConfigurationFacts extends ScenarioFacts {
  readonly boardViewId: string;
  readonly listViewId: string;
  readonly distinctViewCount: number;
  readonly customPropertyKinds: readonly DatabasePropertySchemaV2["kind"][];
  readonly deletedPropertyCount: number;
  readonly pageLayoutVisibilities: readonly string[];
  readonly quickFilterCount: number;
  readonly advancedFilterRuleCount: number;
  readonly sortCount: number;
  readonly personalSortOverrideCount: number;
}

export const requireDatabaseSettingsConfigurationFacts = (
  value: unknown,
): DatabaseSettingsConfigurationFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Record<string, unknown>;
  if (
    envelope.scenarioId !== DATABASE_SETTINGS_CONFIGURATION_SCENARIO_ID ||
    envelope.scenarioRevision !== DATABASE_SETTINGS_CONFIGURATION_SCENARIO_REVISION ||
    typeof candidate.boardViewId !== "string" ||
    typeof candidate.listViewId !== "string" ||
    candidate.boardViewId === candidate.listViewId ||
    candidate.distinctViewCount !== 2 ||
    !Array.isArray(candidate.customPropertyKinds) ||
    candidate.customPropertyKinds.length !== 8 ||
    candidate.deletedPropertyCount !== 1 ||
    !Array.isArray(candidate.pageLayoutVisibilities) ||
    candidate.quickFilterCount !== 2 ||
    candidate.advancedFilterRuleCount !== 2 ||
    candidate.sortCount !== 2 ||
    candidate.personalSortOverrideCount !== 2
  ) {
    throw new Error(
      `database/settings-configuration facts are invalid: ${JSON.stringify(candidate)}`,
    );
  }
  return value as DatabaseSettingsConfigurationFacts;
};

const requireRead = (result: DatabaseModuleReadResultV2, label: string) => {
  if (result.ok) return result.value;
  throw new Error(`${label} failed: ${result.error.message}`);
};

const requireApply = (result: DatabaseApplyResultV2, label: string) => {
  if (result.ok) return result.value;
  throw new Error(`${label} failed: ${result.error.message}`);
};

const readDatabase = async (port: ScenarioSeedPort, projectId: string) => {
  const snapshot = requireRead(
    await port.readDatabase({
      projectId,
      read: { target: { kind: "project_default" }, mode: "database" },
    }),
    "Read settings Database",
  );
  if (snapshot.value.kind !== "database") throw new Error("Expected Database descriptor");
  return { snapshot, descriptor: snapshot.value.value };
};

const readSource = async (
  port: ScenarioSeedPort,
  projectId: string,
  dataSourceId: DataSourceId,
) => {
  const snapshot = requireRead(
    await port.readDatabase({
      projectId,
      read: { target: { kind: "data_source", dataSourceId }, mode: "data_source" },
    }),
    "Read settings Data Source",
  );
  if (snapshot.value.kind !== "data_source") throw new Error("Expected Data Source descriptor");
  return { snapshot, descriptor: snapshot.value.value };
};

const apply = async (
  port: ScenarioSeedPort,
  projectId: string,
  storeEpoch: string,
  operations: Parameters<ScenarioSeedPort["applyDatabase"]>[0]["operations"],
  label: string,
) =>
  requireApply(
    await port.applyDatabase({
      operationId: createUuidV7(),
      projectId,
      storeEpoch,
      actor: { kind: "scenario_seed" },
      operations,
    }),
    label,
  );

const configureDatabase = async (
  port: ScenarioSeedPort,
  projectId: string,
  pageIds: readonly string[],
) => {
  const initialDatabase = await readDatabase(port, projectId);
  const source = initialDatabase.descriptor.dataSources[0];
  const board = initialDatabase.descriptor.views.find((view) => view.isDefault);
  if (!source || !board) throw new Error("Settings scenario requires a default View and Source");
  const storeEpoch = initialDatabase.snapshot.storeEpoch;
  const schemas = [
    { kind: "text" },
    { kind: "number", format: { kind: "currency", currencyCode: "cny" } },
    { kind: "checkbox" },
    { kind: "select" },
    { kind: "multi_select" },
    { kind: "date", dateFormat: "year_month_day" },
    { kind: "datetime", dateFormat: "full", timeFormat: "twenty_four_hour" },
    {
      kind: "relation",
      targetDataSourceId: source.dataSourceId,
      cardinality: "many",
    },
  ] as const satisfies readonly DatabasePropertySchemaV2[];
  const properties: ConfiguredProperty[] = [];
  let sourceRevision = source.schemaRevision;
  let commitSeq = initialDatabase.snapshot.commitSeq;
  for (const [index, schema] of schemas.entries()) {
    const id = createCustomPropertyId();
    const receipt = await apply(
      port,
      projectId,
      storeEpoch,
      [
        {
          kind: "put_property",
          dataSourceId: source.dataSourceId,
          propertyId: id,
          expectedDataSourceRevision: sourceRevision,
          expectedPropertyRevision: 0,
          name: `Scenario ${schema.kind.replace("_", " ")} ${index + 1}`,
          schema,
        },
      ],
      `Create ${schema.kind} Property`,
    );
    sourceRevision += 1;
    commitSeq = receipt.commitSeq;
    properties.push({ id, kind: schema.kind });
  }

  const select = properties.find((property) => property.kind === "select");
  const multi = properties.find((property) => property.kind === "multi_select");
  if (!select || !multi) throw new Error("Settings scenario Select Properties are missing");
  const selectOptions = [createCustomOptionId(), createCustomOptionId()] as const;
  for (const property of [select, multi]) {
    let propertyRevision = 1;
    for (const [index, optionId] of selectOptions.entries()) {
      const receipt = await apply(
        port,
        projectId,
        storeEpoch,
        [
          {
            kind: "put_option",
            dataSourceId: source.dataSourceId,
            propertyId: property.id,
            optionId,
            name: index === 0 ? "Alpha" : "Beta",
            color: index === 0 ? "blue" : "orange",
            expectedPropertyRevision: propertyRevision,
          },
        ],
        `Create ${property.kind} option`,
      );
      propertyRevision += 1;
      sourceRevision += 1;
      commitSeq = receipt.commitSeq;
    }
  }

  const deletedPropertyId = createCustomPropertyId();
  commitSeq = (
    await apply(
      port,
      projectId,
      storeEpoch,
      [
        {
          kind: "put_property",
          dataSourceId: source.dataSourceId,
          propertyId: deletedPropertyId,
          expectedDataSourceRevision: sourceRevision,
          expectedPropertyRevision: 0,
          name: "Recoverable scenario Property",
          schema: { kind: "text" },
        },
      ],
      "Create recoverable Property",
    )
  ).commitSeq;
  sourceRevision += 1;
  commitSeq = (
    await apply(
      port,
      projectId,
      storeEpoch,
      [
        {
          kind: "delete_property",
          dataSourceId: source.dataSourceId,
          propertyId: deletedPropertyId,
          expectedDataSourceRevision: sourceRevision,
          expectedPropertyRevision: 1,
        },
      ],
      "Soft-delete recoverable Property",
    )
  ).commitSeq;
  sourceRevision += 1;

  const configuredBoard = {
    ...board.config,
    rules: {
      ...board.config.rules,
      advancedFilter: {
        kind: "group" as const,
        operator: "and" as const,
        children: [
          { kind: "clause" as const, propertyId: select.id, operator: "is_not_empty" as const },
        ],
      },
    },
    presentation: {
      ...board.config.presentation,
      display: {
        ...board.config.presentation.display,
        fields: [
          ...board.config.presentation.display.fields,
          { kind: "property" as const, propertyId: select.id },
          { kind: "property" as const, propertyId: multi.id },
        ],
      },
      conditionalColors: [
        {
          ruleId: createUuidV7(),
          propertyId: select.id,
          operator: "equals" as const,
          value: selectOptions[0],
          colorSource: "fixed" as const,
          color: "blue" as const,
        },
      ],
    },
  };
  commitSeq = (
    await apply(
      port,
      projectId,
      storeEpoch,
      [
        {
          kind: "put_view",
          databaseId: board.databaseId,
          dataSourceId: board.dataSourceId,
          viewId: board.viewId,
          expectedRevision: board.revision,
          name: "Board",
          layout: "board",
          config: configuredBoard,
          isDefault: true,
        },
      ],
      "Configure Board View",
    )
  ).commitSeq;
  const listViewId = parseDatabaseViewId(createUuidV7());
  commitSeq = (
    await apply(
      port,
      projectId,
      storeEpoch,
      [
        {
          kind: "duplicate_view",
          databaseId: board.databaseId,
          sourceViewId: board.viewId,
          expectedRevision: board.revision + 1,
          newViewId: listViewId,
        },
      ],
      "Duplicate Board View",
    )
  ).commitSeq;
  commitSeq = (
    await apply(
      port,
      projectId,
      storeEpoch,
      [
        {
          kind: "change_view_layout",
          databaseId: board.databaseId,
          viewId: listViewId,
          expectedRevision: 1,
          layout: "list",
        },
      ],
      "Convert duplicate to List",
    )
  ).commitSeq;
  const listSnapshot = requireRead(
    await port.readDatabase({
      projectId,
      read: { target: { kind: "view", viewId: listViewId }, mode: "view" },
    }),
    "Read converted List View",
  );
  if (listSnapshot.value.kind !== "view") throw new Error("Expected converted List View");
  const listView = listSnapshot.value.value;
  commitSeq = (
    await apply(
      port,
      projectId,
      storeEpoch,
      [
        {
          kind: "put_view",
          databaseId: listView.databaseId,
          dataSourceId: listView.dataSourceId,
          viewId: listView.viewId,
          expectedRevision: listView.revision,
          name: "List",
          layout: "list",
          config: listView.config,
          isDefault: false,
        },
      ],
      "Name List View",
    )
  ).commitSeq;

  const text = properties.find((property) => property.kind === "text")!;
  const number = properties.find((property) => property.kind === "number")!;
  const checkbox = properties.find((property) => property.kind === "checkbox")!;
  const configuredList = {
    ...listView.config,
    rules: {
      propertyFilters: [
        {
          filterId: createUuidV7(),
          clause: {
            kind: "clause" as const,
            propertyId: select.id,
            operator: "select_is" as const,
            value: selectOptions[0],
          },
        },
        {
          filterId: createUuidV7(),
          clause: {
            kind: "clause" as const,
            propertyId: text.id,
            operator: "text_contains" as const,
            value: "",
          },
        },
      ],
      advancedFilter: {
        kind: "group" as const,
        operator: "and" as const,
        children: [
          {
            kind: "clause" as const,
            propertyId: text.id,
            operator: "text_contains" as const,
            value: "",
          },
          {
            kind: "group" as const,
            operator: "or" as const,
            children: [
              {
                kind: "clause" as const,
                propertyId: checkbox.id,
                operator: "checkbox_is" as const,
                value: false,
              },
            ],
          },
        ],
      },
      sorts: [
        {
          field: { kind: "property" as const, propertyId: number.id },
          direction: "asc" as const,
          nulls: "last" as const,
        },
        {
          field: { kind: "created" as const },
          direction: "desc" as const,
          nulls: "last" as const,
        },
      ],
    },
  };
  commitSeq = (
    await apply(
      port,
      projectId,
      storeEpoch,
      [
        {
          kind: "put_view",
          databaseId: listView.databaseId,
          dataSourceId: listView.dataSourceId,
          viewId: listView.viewId,
          expectedRevision: listView.revision + 1,
          name: "List",
          layout: "list",
          config: configuredList,
          isDefault: false,
        },
      ],
      "Configure inline rules on List View",
    )
  ).commitSeq;
  commitSeq = (
    await apply(
      port,
      projectId,
      storeEpoch,
      [
        {
          kind: "put_view_personal_preferences",
          viewId: listView.viewId,
          expectedRevision: 0,
          rulesOverride: {
            sorts: [
              {
                field: { kind: "created" as const },
                direction: "desc" as const,
                nulls: "last" as const,
              },
              {
                field: { kind: "property" as const, propertyId: number.id },
                direction: "desc" as const,
                nulls: "last" as const,
              },
            ],
          },
          presentationOverride: {},
        },
      ],
      "Seed a personal Sort override",
    )
  ).commitSeq;

  if (pageIds.length >= 2) {
    const byKind = new Map(properties.map((property) => [property.kind, property.id]));
    const value = (kind: DatabasePropertySchemaV2["kind"]) => {
      const propertyId = byKind.get(kind);
      if (!propertyId) throw new Error(`Missing ${kind} Property`);
      return propertyId;
    };
    commitSeq = (
      await apply(
        port,
        projectId,
        storeEpoch,
        [
          {
            kind: "edit_property_values",
            edits: [
              {
                pageId: pageIds[0]!,
                dataSourceId: source.dataSourceId,
                propertyId: value("text"),
                edit: {
                  kind: "replace",
                  expectedValueRevision: 0,
                  value: { kind: "text", value: "Configured" },
                },
              },
              {
                pageId: pageIds[0]!,
                dataSourceId: source.dataSourceId,
                propertyId: value("number"),
                edit: {
                  kind: "replace",
                  expectedValueRevision: 0,
                  value: { kind: "number", value: 0 },
                },
              },
              {
                pageId: pageIds[0]!,
                dataSourceId: source.dataSourceId,
                propertyId: value("checkbox"),
                edit: {
                  kind: "replace",
                  expectedValueRevision: 0,
                  value: { kind: "checkbox", value: false },
                },
              },
              {
                pageId: pageIds[0]!,
                dataSourceId: source.dataSourceId,
                propertyId: select.id,
                edit: {
                  kind: "replace",
                  expectedValueRevision: 0,
                  value: { kind: "select", optionId: selectOptions[0] },
                },
              },
              {
                pageId: pageIds[0]!,
                dataSourceId: source.dataSourceId,
                propertyId: multi.id,
                edit: {
                  kind: "replace",
                  expectedValueRevision: 0,
                  value: { kind: "multi_select", optionIds: [...selectOptions] },
                },
              },
              {
                pageId: pageIds[0]!,
                dataSourceId: source.dataSourceId,
                propertyId: value("date"),
                edit: {
                  kind: "replace",
                  expectedValueRevision: 0,
                  value: { kind: "date", value: "2026-08-29" },
                },
              },
              {
                pageId: pageIds[0]!,
                dataSourceId: source.dataSourceId,
                propertyId: value("datetime"),
                edit: {
                  kind: "replace",
                  expectedValueRevision: 0,
                  value: { kind: "datetime", value: "2026-08-29T09:30:00.000Z" },
                },
              },
              {
                pageId: pageIds[0]!,
                dataSourceId: source.dataSourceId,
                propertyId: value("relation"),
                edit: {
                  kind: "patch_set",
                  delta: {
                    kind: "relation",
                    addPageIds: [pageIds[1]!],
                    removeEdgeIds: [],
                  },
                },
              },
            ],
          },
        ],
        "Seed typed Property values",
      )
    ).commitSeq;
  }

  const pageLayout = requireRead(
    await port.readDatabase({
      projectId,
      read: {
        target: { kind: "data_source", dataSourceId: source.dataSourceId },
        mode: "page_layout",
      },
    }),
    "Read Page layout",
  );
  if (pageLayout.value.kind !== "page_layout") throw new Error("Expected Page layout");
  commitSeq = (
    await apply(
      port,
      projectId,
      storeEpoch,
      [
        {
          kind: "put_page_layout_entry",
          dataSourceId: source.dataSourceId,
          expectedRevision: pageLayout.value.value.revision,
          propertyId: text.id,
          visibility: "hide_when_empty",
        },
        {
          kind: "put_page_layout_entry",
          dataSourceId: source.dataSourceId,
          expectedRevision: pageLayout.value.value.revision + 1,
          propertyId: checkbox.id,
          visibility: "always_hide",
        },
      ],
      "Configure Page layout visibilities",
    )
  ).commitSeq;

  return {
    boardViewId: board.viewId,
    listViewId,
    dataSourceId: source.dataSourceId,
    deletedPropertyId,
    properties,
    commitSeq,
  };
};

const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({ name: "Database settings", sources: [workspace] });
  const pageIdsByKey = {
    configured: createUuidV7(),
    empty: createUuidV7(),
  };
  for (const [key, pageId] of Object.entries(pageIdsByKey)) {
    await port.createPage({
      key,
      pageId,
      operationId: createUuidV7(),
      projectId: project.id,
      status: key === "configured" ? "build" : "plan",
      title: key === "configured" ? "Configured property values" : "Empty property values",
      nfm: key === "configured" ? "Every settings surface has durable evidence." : "",
    });
  }
  const configured = await configureDatabase(port, project.id, Object.values(pageIdsByKey));
  return {
    version: 1,
    scenarioId: DATABASE_SETTINGS_CONFIGURATION_SCENARIO_ID,
    scenarioRevision: DATABASE_SETTINGS_CONFIGURATION_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: configured.boardViewId,
    pageIdsByKey,
    entityIdsByKey: {
      boardView: configured.boardViewId,
      listView: configured.listViewId,
      dataSource: configured.dataSourceId,
      deletedProperty: configured.deletedPropertyId,
      ...Object.fromEntries(
        configured.properties.map((property) => [`property_${property.kind}`, property.id]),
      ),
    },
    minimumCommitSeq: configured.commitSeq,
    materializedAt: new Date().toISOString(),
  };
};

const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<DatabaseSettingsConfigurationFacts> => {
  const database = await readDatabase(port, manifest.projectId);
  const encodedDataSourceId = manifest.entityIdsByKey?.dataSource;
  if (!encodedDataSourceId) throw new Error("Settings scenario Data Source identity is missing");
  const dataSourceId = parseDataSourceId(encodedDataSourceId);
  const source = await readSource(port, manifest.projectId, dataSourceId);
  const pageLayout = requireRead(
    await port.readDatabase({
      projectId: manifest.projectId,
      read: { target: { kind: "data_source", dataSourceId }, mode: "page_layout" },
    }),
    "Inspect Page layout",
  );
  if (pageLayout.value.kind !== "page_layout") throw new Error("Expected Page layout facts");
  const propertyIds = new Set(
    Object.entries(manifest.entityIdsByKey ?? {})
      .filter(([key]) => key.startsWith("property_"))
      .map(([, id]) => id),
  );
  const customProperties = source.descriptor.properties.filter(
    (property) => propertyIds.has(property.propertyId) && property.lifecycle === "active",
  );
  const boardViewId = manifest.entityIdsByKey?.boardView;
  const listViewId = manifest.entityIdsByKey?.listView;
  if (!boardViewId || !listViewId) throw new Error("Settings View identities are missing");
  const listSnapshot = requireRead(
    await port.readDatabase({
      projectId: manifest.projectId,
      read: {
        target: { kind: "view", viewId: parseDatabaseViewId(listViewId) },
        mode: "view",
      },
    }),
    "Inspect inline rules View",
  );
  if (listSnapshot.value.kind !== "view") throw new Error("Expected inline rules View facts");
  const preferencesSnapshot = requireRead(
    await port.readDatabase({
      projectId: manifest.projectId,
      read: {
        target: { kind: "view", viewId: parseDatabaseViewId(listViewId) },
        mode: "view_personal_preferences",
      },
    }),
    "Inspect inline rules personal preferences",
  );
  if (preferencesSnapshot.value.kind !== "view_personal_preferences") {
    throw new Error("Expected inline rules personal preference facts");
  }
  const countFilterRules = (
    node: typeof listSnapshot.value.value.config.rules.advancedFilter,
  ): number => {
    if (!node) return 0;
    return node.children.reduce(
      (count, child) => count + (child.kind === "clause" ? 1 : countFilterRules(child)),
      0,
    );
  };
  const facts: DatabaseSettingsConfigurationFacts = {
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    boardViewId,
    listViewId,
    distinctViewCount: new Set(database.descriptor.views.map((view) => view.viewId)).size,
    customPropertyKinds: customProperties.map((property) => property.schema.kind).sort(),
    deletedPropertyCount: source.descriptor.properties.filter(
      (property) => property.lifecycle === "deleted",
    ).length,
    pageLayoutVisibilities: pageLayout.value.value.entries.map((entry) => entry.visibility),
    quickFilterCount: listSnapshot.value.value.config.rules.propertyFilters.length,
    advancedFilterRuleCount: countFilterRules(listSnapshot.value.value.config.rules.advancedFilter),
    sortCount: listSnapshot.value.value.config.rules.sorts.length,
    personalSortOverrideCount: preferencesSnapshot.value.value.rulesOverride.sorts?.length ?? 0,
  };
  return requireDatabaseSettingsConfigurationFacts(facts);
};

export const databaseSettingsConfigurationScenario: ScenarioDomainRecipe = {
  id: DATABASE_SETTINGS_CONFIGURATION_SCENARIO_ID,
  revision: DATABASE_SETTINGS_CONFIGURATION_SCENARIO_REVISION,
  materialize,
  inspect,
  parseFacts: requireDatabaseSettingsConfigurationFacts,
};
