import type { WebContentsDestructionSource } from "./platform/electron/WebContentsDestructionSubscriptions";
import type { DocumentSyncCommandResult } from "../shared/block-documents/document-sync";

export interface DocumentSyncClientTarget extends WebContentsDestructionSource {
  readonly id: number;
  send(channel: string, ...args: unknown[]): void;
}

export const documentSyncInvalidSession = <Value>(): DocumentSyncCommandResult<Value> => ({
  ok: false,
  error: {
    code: "invalid_session",
    message: "Document sync requires an active subscription for this client session",
    retryable: false,
    resetRequired: false,
  },
});
