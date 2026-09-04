import { CoreClient } from "../core-client";
import { createCoreLibraryModuleAdapter } from "../library-module-adapter";
import { createUuidV7 } from "../../../shared/uuid-v7";

// A disposable authenticated Host, deliberately terminated without cleanup by
// the process-lifetime test. Its IPC channel keeps it alive after the command.
async function run(): Promise<void> {
  const [nodexHome, projectId, sourcePageId, childPageId, ownerId] = process.argv.slice(2);
  if (!nodexHome || !projectId || !sourcePageId || !childPageId || !ownerId || !process.send)
    throw new Error("Missing isolated history Host arguments or IPC channel");
  process.on("message", () => {});
  const host = await CoreClient.connect({
    nodexHome,
    clientKind: "electron_host",
    buildId: "history-process-lifetime-test",
  });
  const client = host.forProject(projectId);
  const descriptor = await client.documentRead(createUuidV7(), {
    kind: "descriptor",
    owner_block_id: sourcePageId,
  });
  if (descriptor.value.kind !== "descriptor") throw new Error("Missing source Document");
  const source = descriptor.value.descriptor;
  const library = createCoreLibraryModuleAdapter({
    client,
    profileId: host.handshake.generation.profile_id,
    libraryId: host.handshake.library_id,
    storeEpoch: host.handshake.store_epoch,
    editorHistoryOwnerId: ownerId,
  });
  const deleted = await library.apply({
    operationId: createUuidV7(),
    storeEpoch: source.storeEpoch,
    operation: {
      kind: "apply_structural_edit",
      command: {
        kind: "delete_selection",
        selection: {
          sourceDocumentId: source.documentId,
          rootBlockIds: [childPageId],
          sourceHead: {
            documentId: source.documentId,
            generation: source.generation,
            expectedHeadSeq: source.headSeq,
          },
        },
        reason: { kind: "delete" },
        direction: "forward",
      },
    },
  });
  if (!deleted.ok || !deleted.value.structuralEdit?.history)
    throw new Error(JSON.stringify(deleted));
  process.send(deleted.value.structuralEdit.history);
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
