import {
  type DatabaseApplyReceiptV2,
  type DatabaseApplyResultV2,
  type DatabaseApplyV2,
  type DatabaseModuleErrorV2,
  type DatabaseModuleReadSnapshotV2,
} from "../../shared/database-module-v2";
import { compileDatabasePageDrag, compileDatabasePagesDrag } from "../../shared/database-page-drag";
import type { MovePageInput, MovePagesInput } from "../../shared/types";
import { applyDatabaseModule } from "./api";
import type { DatabaseViewRenderModel } from "./database-view-render-model";

export interface DatabasePageDragRuntimeDependencies {
  readonly apply: (projectId: string, request: DatabaseApplyV2) => Promise<DatabaseApplyResultV2>;
}

export class DatabasePageDragMutationError extends Error {
  constructor(readonly commandError: DatabaseModuleErrorV2) {
    super(commandError.message);
    this.name = "DatabasePageDragMutationError";
  }
}

const defaultDependencies: DatabasePageDragRuntimeDependencies = {
  apply: applyDatabaseModule,
};

export const databaseViewRenderModelToDragSnapshot = (
  view: DatabaseViewRenderModel,
): DatabaseModuleReadSnapshotV2 => {
  if (view.routingContext.kind !== "project") {
    throw new Error("Project Page drag requires Project Database authority");
  }
  return {
    projectId: view.routingContext.projectId,
    libraryId: view.libraryId,
    storeEpoch: view.storeEpoch,
    commitSeq: view.commitSeq,
    value: { kind: "query", value: view.query },
  };
};

const commitCompiledDrag = async (input: {
  readonly projectId: string;
  readonly operationId: string;
  readonly compile: (snapshot: DatabaseModuleReadSnapshotV2) => DatabaseApplyV2["operations"];
  readonly snapshot: DatabaseModuleReadSnapshotV2;
  readonly dependencies: DatabasePageDragRuntimeDependencies;
}): Promise<DatabaseApplyReceiptV2> => {
  const request: DatabaseApplyV2 = {
    operationId: input.operationId,
    projectId: input.projectId,
    storeEpoch: input.snapshot.storeEpoch,
    actor: { kind: "renderer_page_drag" },
    operations: input.compile(input.snapshot),
  };

  let retried = false;
  let result: DatabaseApplyResultV2;
  try {
    result = await input.dependencies.apply(input.projectId, request);
  } catch {
    retried = true;
    result = await input.dependencies.apply(input.projectId, request);
  }
  if (!result.ok && result.error.retryable && !retried) {
    result = await input.dependencies.apply(input.projectId, request);
  }
  if (result.ok) return result.value;
  throw new DatabasePageDragMutationError(result.error);
};

export const commitDatabasePageDrag = async (input: {
  readonly projectId: string;
  readonly operationId: string;
  readonly move: MovePageInput;
  readonly snapshot: DatabaseModuleReadSnapshotV2;
  readonly dependencies?: DatabasePageDragRuntimeDependencies;
}): Promise<DatabaseApplyReceiptV2> =>
  await commitCompiledDrag({
    projectId: input.projectId,
    operationId: input.operationId,
    snapshot: input.snapshot,
    compile: (snapshot) => compileDatabasePageDrag({ move: input.move, snapshot }).operations,
    dependencies: input.dependencies ?? defaultDependencies,
  });

export const commitDatabasePagesDrag = async (input: {
  readonly projectId: string;
  readonly operationId: string;
  readonly move: MovePagesInput;
  readonly snapshot: DatabaseModuleReadSnapshotV2;
  readonly dependencies?: DatabasePageDragRuntimeDependencies;
}): Promise<DatabaseApplyReceiptV2> =>
  await commitCompiledDrag({
    projectId: input.projectId,
    operationId: input.operationId,
    snapshot: input.snapshot,
    compile: (snapshot) => compileDatabasePagesDrag({ move: input.move, snapshot }).operations,
    dependencies: input.dependencies ?? defaultDependencies,
  });
