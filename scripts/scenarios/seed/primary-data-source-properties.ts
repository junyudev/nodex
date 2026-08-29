import { createCustomPropertyId } from "../../../src/shared/database-identities";
import type {
  DatabaseApplyV2,
  DatabaseApplyResultV2,
  DatabaseModuleReadRequestV2,
  DatabaseModuleReadResultV2,
  DatabasePropertySchemaV2,
} from "../../../src/shared/database-module-v2";
import { createUuidV7 } from "../../../src/shared/uuid-v7";

export interface ScenarioDatabasePort {
  read(request: DatabaseModuleReadRequestV2): Promise<DatabaseModuleReadResultV2>;
  apply(request: DatabaseApplyV2): Promise<DatabaseApplyResultV2>;
}

const requireSuccess = <Value>(
  result:
    | { readonly ok: true; readonly value: Value }
    | {
        readonly ok: false;
        readonly error: { readonly message: string };
      },
  label: string,
): Value => {
  if (result.ok) return result.value;
  throw new Error(`${label} failed: ${result.error.message}`);
};

const readPrimaryDataSource = async (port: ScenarioDatabasePort, projectId: string) => {
  const database = requireSuccess(
    await port.read({
      projectId,
      read: { target: { kind: "project_default" }, mode: "database" },
    }),
    "Read primary Database",
  );
  if (database.value.kind !== "database") {
    throw new Error("Primary Database read returned the wrong projection");
  }
  const dataSource = database.value.value.dataSources[0];
  if (!dataSource) throw new Error("Primary Database has no Data Source");
  const descriptor = requireSuccess(
    await port.read({
      projectId,
      read: {
        target: { kind: "data_source", dataSourceId: dataSource.dataSourceId },
        mode: "data_source",
      },
    }),
    "Read primary Data Source",
  );
  if (descriptor.value.kind !== "data_source") {
    throw new Error("Primary Data Source read returned the wrong projection");
  }
  return { snapshot: descriptor, descriptor: descriptor.value.value };
};

export const readPrimaryDataSourcePropertyCount = async (
  port: ScenarioDatabasePort,
  projectId: string,
): Promise<number> => {
  const { descriptor } = await readPrimaryDataSource(port, projectId);
  return descriptor.properties.filter((property) => property.lifecycle === "active").length;
};

export const ensurePrimaryDataSourcePropertyCount = async (
  port: ScenarioDatabasePort,
  projectId: string,
  count: number,
): Promise<{ readonly commitSeq: number; readonly propertyCount: number }> => {
  const initial = await readPrimaryDataSource(port, projectId);
  const activeCount = initial.descriptor.properties.filter(
    (property) => property.lifecycle === "active",
  ).length;
  if (activeCount >= count) {
    return { commitSeq: initial.snapshot.commitSeq, propertyCount: activeCount };
  }

  const schemas = [
    { kind: "text" },
    { kind: "number", format: { kind: "plain" } },
    { kind: "checkbox" },
    { kind: "date", dateFormat: "full" },
  ] as const satisfies readonly DatabasePropertySchemaV2[];
  let schemaRevision = initial.descriptor.dataSource.schemaRevision;
  let commitSeq = initial.snapshot.commitSeq;
  for (let index = activeCount; index < count; index += 1) {
    const result = requireSuccess(
      await port.apply({
        operationId: createUuidV7(),
        projectId,
        storeEpoch: initial.snapshot.storeEpoch,
        actor: { kind: "scenario_seed" },
        operations: [
          {
            kind: "put_property",
            dataSourceId: initial.descriptor.dataSource.dataSourceId,
            propertyId: createCustomPropertyId(),
            expectedDataSourceRevision: schemaRevision,
            expectedPropertyRevision: 0,
            name: `Performance Property ${String(index + 1).padStart(2, "0")}`,
            schema: schemas[index % schemas.length]!,
          },
        ],
      }),
      `Create performance Property ${index + 1}`,
    );
    schemaRevision += 1;
    commitSeq = result.commitSeq;
  }
  return { commitSeq, propertyCount: count };
};
