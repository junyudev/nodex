import type { StartWorkInput } from "../../shared/work-application";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { defineLocalCommitRendererCommand, invokeLocalCommitCommand } from "./renderer-command";
import type { LibraryDatabaseReadV2 } from "../../shared/database-module-v2";
import { readLibraryDatabaseModule, readDatabaseModule } from "./api";
import type { DatabaseViewRoutingContext } from "./database-view-render-model";

const readWorkGraph = async (
  routingContext: DatabaseViewRoutingContext,
  read: LibraryDatabaseReadV2,
) => {
  const result =
    routingContext.kind === "project"
      ? await readDatabaseModule(routingContext.projectId, {
          projectId: routingContext.projectId,
          read,
        })
      : await readLibraryDatabaseModule({ read });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.value;
};

export const readPageBlocking = async (input: {
  readonly routingContext: DatabaseViewRoutingContext;
  readonly pageId: string;
  readonly after?: string | null;
  readonly first?: number;
}) => {
  const result = await readWorkGraph(input.routingContext, {
    target: { kind: "page", pageId: input.pageId },
    mode: "blocking",
    window: { after: input.after, first: input.first ?? 50 },
  });
  if (result.kind !== "blocking") throw new Error("Database returned a non-Blocking window");
  return result.value;
};

export const readPagePrerequisites = async (input: {
  readonly routingContext: DatabaseViewRoutingContext;
  readonly pageId: string;
}) => {
  const result = await readWorkGraph(input.routingContext, {
    target: { kind: "page", pageId: input.pageId },
    mode: "prerequisites",
  });
  if (result.kind !== "prerequisites")
    throw new Error("Database returned a non-Prerequisites summary");
  return result.value;
};

export const readReadyWork = async (
  input: {
    readonly projectId?: string;
    readonly limit?: number;
    readonly afterPageId?: string;
  } = {},
) => {
  const result = await readWorkGraph(
    { kind: "library" },
    { target: { kind: "library" }, mode: "ready_work", ...input },
  );
  if (result.kind !== "ready_work") throw new Error("Database returned a non-ReadyWork result");
  return result.value;
};

const startWorkCommand = defineLocalCommitRendererCommand({
  key: "work.start",
  channel: "work:start",
  authority: "core",
  owner: "Work",
  protocol: { kind: "receipt_fenced_projection", presentation: "pending" },
});
export const startWork = (input: StartWorkInput) =>
  invokeLocalCommitCommand(startWorkCommand, {
    ...input,
    operationId: input.operationId ?? createBoundedOperationId("work.start"),
  });
