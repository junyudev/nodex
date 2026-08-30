import type { QueryClient } from "@tanstack/react-query";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { CoreApiError } from "./api";
import {
  createProjectCatalogStore,
  type ProjectCatalogStore,
  type ProjectCatalogUpdatePort,
} from "./project-catalog-store";
import { defineLocalCommitRendererCommand, invokeLocalCommitCommand } from "./renderer-command";

export const projectCatalogUpdateCommand = defineLocalCommitRendererCommand({
  key: "workspace.project.update",
  channel: "projects:update",
  authority: "core",
  owner: "project-catalog",
  protocol: {
    kind: "receipt_fenced_projection",
    presentation: "required",
  },
});

const stores = new WeakMap<QueryClient, ProjectCatalogStore>();

const projectCatalogUpdatePort: ProjectCatalogUpdatePort = {
  send: async (command) => {
    try {
      const result = await invokeLocalCommitCommand(projectCatalogUpdateCommand, command);
      return {
        kind: "acknowledged",
        project: result.value,
        acknowledgement: result.acknowledgement,
      };
    } catch (cause) {
      if (!(cause instanceof CoreApiError)) throw cause;
      return {
        kind: "definitive_failure",
        failure: {
          code: cause.code,
          message: cause.message,
        },
      };
    }
  },
};

/** One Project catalog owner per renderer QueryClient/window. */
export function projectCatalogStoreFor(queryClient: QueryClient): ProjectCatalogStore {
  const current = stores.get(queryClient);
  if (current) return current;

  const store = createProjectCatalogStore({
    operationId: () => createBoundedOperationId("renderer.project-catalog.update"),
    port: projectCatalogUpdatePort,
  });
  stores.set(queryClient, store);
  return store;
}
