import { createUuidV7 } from "../../../src/shared/uuid-v7";
import { parseDatabaseViewId } from "../../../src/shared/database-identities";
import type { ScenarioSeedPort } from "../contracts";

/** A Project starts with one Board; scenarios that exercise List add it as an ordinary View. */
export const createProjectListView = async (
  port: ScenarioSeedPort,
  projectId: string,
): Promise<{ readonly viewId: string; readonly commitSeq: number }> => {
  const databaseRead = await port.readDatabase({
    projectId,
    read: { target: { kind: "project_default" }, mode: "database" },
  });
  if (!databaseRead.ok) throw new Error(databaseRead.error.message);
  const databaseSnapshot = databaseRead.value;
  if (databaseSnapshot.value.kind !== "database") {
    throw new Error("The Project's default Database descriptor is unavailable");
  }
  const board = databaseSnapshot.value.value.views.find((view) => view.isDefault);
  if (!board) throw new Error("The Project's default Board View is unavailable");
  const viewId = parseDatabaseViewId(createUuidV7());
  const apply = async (
    operations: Parameters<ScenarioSeedPort["applyDatabase"]>[0]["operations"],
  ) => {
    const result = await port.applyDatabase({
      operationId: createUuidV7(),
      projectId,
      storeEpoch: databaseSnapshot.storeEpoch,
      actor: { kind: "scenario_seed" },
      operations,
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  await apply([
    {
      kind: "duplicate_view",
      databaseId: board.databaseId,
      sourceViewId: board.viewId,
      expectedRevision: board.revision,
      newViewId: viewId,
    },
  ]);
  await apply([
    {
      kind: "change_view_layout",
      databaseId: board.databaseId,
      viewId,
      expectedRevision: 1,
      layout: "list",
    },
  ]);
  const listRead = await port.readDatabase({
    projectId,
    read: { target: { kind: "view", viewId }, mode: "view" },
  });
  if (!listRead.ok) throw new Error(listRead.error.message);
  if (listRead.value.value.kind !== "view") {
    throw new Error("The Project's List View descriptor is unavailable");
  }
  const list = listRead.value.value.value;
  const renamed = await apply([
    {
      kind: "put_view",
      databaseId: list.databaseId,
      dataSourceId: list.dataSourceId,
      viewId: list.viewId,
      expectedRevision: list.revision,
      name: "List",
      layout: "list",
      config: list.config,
      isDefault: false,
    },
  ]);
  return { viewId, commitSeq: renamed.commitSeq };
};
