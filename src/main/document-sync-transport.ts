import type { DocumentSyncCommandResult } from "../shared/block-documents/document-sync";

export interface DocumentSyncClientTarget {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
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
