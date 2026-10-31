import { createBoundedOperationId } from "../../shared/operation-identity";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { CreatePageForInput, CreatePageForResult } from "../../shared/workspace-page-create";
import { defineRendererCommand, invokePlainCommand } from "./renderer-command";

export type { CreatePageForInput, CreatePageForResult } from "../../shared/workspace-page-create";

const createPageForCommand = defineRendererCommand({
  key: "workspace.page.create-for",
  channel: "workspace:page:create-for",
  authority: "core",
  owner: "Workspace",
  protocol: { kind: "pending_operation" },
});

/** Core resolves the content home and links the new Page to its Session in one commit. */
export async function createPageFor(input: CreatePageForInput): Promise<CreatePageForResult> {
  return await invokePlainCommand(createPageForCommand, {
    ...input,
    operationId: createBoundedOperationId("workspace.page.create-for"),
    pageId: createUuidV7(),
    documentId: createUuidV7(),
  });
}
