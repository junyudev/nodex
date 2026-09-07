import {
  WORKBENCH_COMMAND_MAX_BYTES,
  WORKBENCH_COMMAND_MAX_RECEIPTS,
  WorkbenchCommandEnvelopeSchema,
  type WorkbenchCommandEnvelope,
  type WorkbenchCommandError,
  type WorkbenchCommandReceipt,
} from "../../shared/nodex-app-tools/workbench-commands";
import type { WorkbenchSceneCommandExecutor } from "./workbench-scene-commands";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** A ledger belongs to one renderer bridge generation. It never mirrors Scene state or replays mutations. */
export function createWorkbenchAgentCommands(
  owner: WorkbenchWindowOwner,
  executor: WorkbenchSceneCommandExecutor,
) {
  const receipts = new Map<
    string,
    { readonly digest: string; readonly promise: Promise<WorkbenchCommandReceipt> }
  >();
  return {
    async execute(
      input: WorkbenchCommandEnvelope,
      isCurrent: () => boolean,
    ): Promise<WorkbenchCommandReceipt> {
      const reject = (error: WorkbenchCommandError): WorkbenchCommandReceipt => ({
        operationId: input.operationId,
        sceneOwner: input.sceneOwner,
        applied: false,
        persisted: false,
        presentationRevision: owner.read().presentationRevision,
        layoutRevision: null,
        tabId: null,
        groupId: null,
        error,
      });
      const parsed = WorkbenchCommandEnvelopeSchema.safeParse(input);
      if (!parsed.success) return reject("invalid_command");
      // Session presentation discovers a fresh revision on each call. That concurrency
      // precondition is not a new semantic operation when an exact retry arrives.
      const sessionPresentation =
        parsed.data.command.kind === "activate_surface" ||
        parsed.data.command.kind === "open_surface" ||
        parsed.data.command.kind === "navigate_session";
      const digestInput = sessionPresentation
        ? { ...parsed.data, expectedPresentationRevision: undefined }
        : parsed.data;
      const encoded = new TextEncoder().encode(canonicalJson(digestInput));
      if (encoded.byteLength > WORKBENCH_COMMAND_MAX_BYTES) return reject("invalid_command");
      const hash = await crypto.subtle.digest("SHA-256", encoded);
      const digest = Array.from(new Uint8Array(hash), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      if (!isCurrent()) return reject("revoked_generation");
      const existing = receipts.get(input.operationId);
      if (existing)
        return existing.digest === digest ? existing.promise : reject("operation_id_reused");
      // Do not evict committed receipts and silently make an old operation eligible for replay.
      if (receipts.size >= WORKBENCH_COMMAND_MAX_RECEIPTS) return reject("receipt_capacity");
      const promise = executor.execute(parsed.data, isCurrent).then((receipt) => {
        // A stale preflight has no effects. A high-level presentation retry can
        // observe a new revision; applied or uncertain outcomes remain retained.
        if (
          sessionPresentation &&
          !receipt.applied &&
          receipt.error === "stale_presentation" &&
          receipts.get(input.operationId)?.promise === promise
        )
          receipts.delete(input.operationId);
        return receipt;
      });
      receipts.set(input.operationId, { digest, promise });
      return promise;
    },
  };
}
