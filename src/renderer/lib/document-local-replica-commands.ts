import { defineLocalCommitRendererCommand } from "./renderer-command";

export const projectDocumentUpdateCommand = defineLocalCommitRendererCommand({
  key: "document.replica.apply-project-update",
  channel: "document-sync:apply",
  authority: "core",
  owner: "nodex-y-provider",
  protocol: { kind: "local_document_replica" },
});

export const libraryDocumentUpdateCommand = defineLocalCommitRendererCommand({
  key: "document.replica.apply-library-update",
  channel: "library-document-sync:apply",
  authority: "core",
  owner: "nodex-y-provider",
  protocol: { kind: "local_document_replica" },
});

export const documentMutationCommand = defineLocalCommitRendererCommand({
  key: "document.replica.mutate",
  channel: "block-documents:mutate",
  authority: "core",
  owner: "owned-block-document",
  protocol: { kind: "local_document_replica" },
});

export const additionalDocumentCommand = defineLocalCommitRendererCommand({
  key: "document.replica.apply-additional-command",
  channel: "block-documents:command",
  authority: "core",
  owner: "additional-document-command",
  protocol: { kind: "local_document_replica" },
});

export const blockTransferCommand = defineLocalCommitRendererCommand({
  key: "document.replica.transfer-blocks",
  channel: "blocks:transfer",
  authority: "core",
  owner: "block-transfer",
  protocol: { kind: "local_document_replica" },
});

export const blockTransferUndoCommand = defineLocalCommitRendererCommand({
  key: "document.replica.undo-block-transfer",
  channel: "blocks:transfer:undo",
  authority: "core",
  owner: "block-transfer",
  protocol: { kind: "local_document_replica" },
});

export const documentVersionRestoreCommand = defineLocalCommitRendererCommand({
  key: "document.replica.restore-version",
  channel: "block-documents:history:restore",
  authority: "core",
  owner: "owned-block-document",
  protocol: { kind: "local_document_replica" },
});
