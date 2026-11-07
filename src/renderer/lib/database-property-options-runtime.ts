import type { DatabasePropertyOption } from "../../shared/database-kernel";
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
