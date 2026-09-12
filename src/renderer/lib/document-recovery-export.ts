import type {
  DocumentRecoveryScope,
  RecoveryExportCommand,
} from "../../shared/block-documents/document-recovery";
import {
  encodeRecoveryExport,
  recoveryPayloadHash,
} from "../../shared/block-documents/recovery-bundle";
import { defineRendererCommand, invokePlainCommand } from "./renderer-command";

const command = defineRendererCommand({
  key: "document.recovery.export",
  channel: "document-recovery:export",
  authority: "main",
  owner: "DocumentRecovery",
  protocol: { kind: "returned_value" },
});
export const recoveryExportPort = (request: RecoveryExportCommand) =>
  invokePlainCommand(command, request);

/** All local sources use the same verified Main output, including emergency in-memory replicas. */
export async function saveRecoveryExport(
  scope: DocumentRecoveryScope,
  bytes: Uint8Array,
  port = recoveryExportPort,
): Promise<void> {
  const opened = await port({
    ...scope,
    kind: "begin",
    byteLength: bytes.length,
    payloadHash: await recoveryPayloadHash(bytes),
  });
  if (!opened.ok) throw new Error(opened.error.message);
  if (opened.status === "cancelled") return;
  if (opened.status !== "ready") throw new Error("Recovery export could not be opened");
  try {
    for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
      const result = await port({
        ...scope,
        kind: "append",
        handle: opened.handle,
        offset,
        bytes: bytes.subarray(offset, offset + 256 * 1024),
      });
      if (!result.ok) throw new Error(result.error.message);
    }
    const result = await port({ ...scope, kind: "complete", handle: opened.handle });
    if (!result.ok) throw new Error(result.error.message);
    if (result.status !== "saved") throw new Error("Recovery export was not confirmed");
  } catch (error) {
    await port({ ...scope, kind: "cancel", handle: opened.handle }).catch(() => undefined);
    throw error;
  }
}

export async function exportRecoveryEnvelope(
  scope: DocumentRecoveryScope,
  documentId: string,
  data: string,
): Promise<void> {
  const bytes = await encodeRecoveryExport(new TextEncoder().encode(data), {
    draftId: `local:${documentId}`,
    documentId,
    encoding: "local_legacy_json",
  });
  await saveRecoveryExport(scope, bytes);
}
