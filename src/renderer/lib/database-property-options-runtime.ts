import type { DatabasePropertyOption } from "../../shared/database-kernel";
import { MAX_DATA_SOURCE_PROPERTY_OPTIONS } from "../../shared/data-source-option-registry";
import type {
  DataSourcePropertyRecordV2,
  DatabaseModuleReadResultV2,
} from "../../shared/database-module-v2";
import type { DatabaseViewRoutingContext } from "./database-view-render-model";
import { readDatabaseModule, readLibraryDatabaseModule } from "./api";

const assertOptionWindow = (
  result: DatabaseModuleReadResultV2 | Awaited<ReturnType<typeof readLibraryDatabaseModule>>,
) => {
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.value.kind !== "option_window") {
    throw new Error("Database returned a non-option Property window");
  }
  return result.value.value.value;
};

export interface PropertyOptionWindow {
  readonly options: readonly DatabasePropertyOption[];
  readonly nextCursor: string | null;
  readonly projectionRevision: number;
}

export const readPropertyOptionWindow = async (
  routingContext: DatabaseViewRoutingContext,
  property: DataSourcePropertyRecordV2,
  after: string | null,
): Promise<PropertyOptionWindow> => {
  if (property.valueType !== "select" && property.valueType !== "multi_select") {
    return { options: [], nextCursor: null, projectionRevision: 0 };
  }
  const read = {
    target: {
      kind: "property" as const,
      dataSourceId: property.dataSourceId,
      propertyId: property.propertyId,
    },
    mode: "option_window" as const,
    window: { after, first: 100 },
  };
  const result =
    routingContext.kind === "library"
      ? await readLibraryDatabaseModule({
          read,
        })
      : await readDatabaseModule(routingContext.projectId, {
          projectId: routingContext.projectId,
          read,
        });
  return assertOptionWindow(result);
};

export const mergePropertyOptionPages = (
  current: readonly DatabasePropertyOption[],
  incoming: readonly DatabasePropertyOption[],
): readonly DatabasePropertyOption[] => {
  const byId = new Map(current.map((option) => [option.id, option]));
  for (const option of incoming) byId.set(option.id, option);
  return [...byId.values()];
};

export const propertyOptionWindowMatchesProjection = (
  expectedProjectionRevision: number | null,
  actualProjectionRevision: number,
): boolean =>
  expectedProjectionRevision === null || expectedProjectionRevision === actualProjectionRevision;

export const readPropertyOptionRegistry = async (
  routingContext: DatabaseViewRoutingContext,
  property: DataSourcePropertyRecordV2,
): Promise<readonly DatabasePropertyOption[]> => {
  if (property.valueType !== "select" && property.valueType !== "multi_select") {
    return [];
  }
  if (property.optionCount > MAX_DATA_SOURCE_PROPERTY_OPTIONS) {
    throw new Error("Property option registry exceeded its declared bound");
  }
  let restartCount = 0;
  let totalPageCount = 0;
  while (restartCount <= 3) {
    let after: string | null = null;
    let options: readonly DatabasePropertyOption[] = [];
    let projectionRevision: number | null = null;
    const seenCursors = new Set<string>();
    let shouldRestart = false;
    do {
      const page = await readPropertyOptionWindow(routingContext, property, after);
      totalPageCount += 1;
      if (!propertyOptionWindowMatchesProjection(projectionRevision, page.projectionRevision)) {
        restartCount += 1;
        shouldRestart = true;
        break;
      }
      projectionRevision = page.projectionRevision;
      options = mergePropertyOptionPages(options, page.options);
      if (options.length > MAX_DATA_SOURCE_PROPERTY_OPTIONS) {
        throw new Error("Property option registry exceeded its fixed bound");
      }
      after = page.nextCursor;
      if (!after) return options;
      if (seenCursors.has(after)) {
        throw new Error("Property option registry returned a repeated cursor");
      }
      seenCursors.add(after);
    } while (totalPageCount < 100 && options.length <= MAX_DATA_SOURCE_PROPERTY_OPTIONS);
    if (shouldRestart) continue;
    break;
  }
  throw new Error("Property option registry exceeded its declared bound");
};

export const withPropertyOptions = (
  property: DataSourcePropertyRecordV2,
  options: readonly DatabasePropertyOption[],
): DataSourcePropertyRecordV2 => ({
  ...property,
  config: {
    options: options.map((option) => ({
      id: option.id,
      name: option.name,
      ...(option.color === undefined ? {} : { color: option.color }),
    })),
  },
});
