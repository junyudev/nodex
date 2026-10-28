import type {
  CreatePastedTextAttachmentInput,
  CreatePastedTextAttachmentResult,
  ReadPastedTextAttachmentInput,
  RemovePastedTextAttachmentInput,
} from "../../../../../shared/pasted-text-attachments";
import type { ComposerDraftTransfer, ComposerPastedTextAttachment } from "./composer-draft-state";

export interface PreparedComposerDraftTransfer {
  readonly transfer: ComposerDraftTransfer;
  discard(): Promise<void>;
}

export interface ComposerDraftPastedTextPort {
  read(input: ReadPastedTextAttachmentInput): Promise<string>;
  create(input: CreatePastedTextAttachmentInput): Promise<CreatePastedTextAttachmentResult>;
  remove(input: RemovePastedTextAttachmentInput): Promise<void>;
}

/** Each draft owns its pasted files, including while a failed save keeps both drafts open. */
export async function prepareComposerDraftTransferAttachments(
  transfer: ComposerDraftTransfer,
  port: ComposerDraftPastedTextPort,
  fallbackHostId: string,
): Promise<PreparedComposerDraftTransfer> {
  const created: CreatePastedTextAttachmentResult[] = [];
  const discard = async () => {
    // The attachment owner records failed removals for retry; cleanup must not mask a save failure.
    await Promise.allSettled(
      created.splice(0).map((attachment) => port.remove({ file: attachment.file })),
    );
  };
  const pastedTextAttachments: ComposerPastedTextAttachment[] = [];
  try {
    for (const item of transfer.pastedTextAttachments) {
      if (item.status !== "ready") throw new Error("Finish pasted text attachments before saving");
      const hostId = item.attachment.hostId ?? item.attachment.file.hostId ?? fallbackHostId;
      const text = await port.read({ file: { ...item.attachment.file, hostId } });
      const attachment = await port.create({
        text,
        hostId,
      });
      created.push(attachment);
      pastedTextAttachments.push({
        ...item,
        attachment: {
          ...item.attachment,
          file: {
            ...item.attachment.file,
            ...attachment.file,
            label: item.attachment.file.label,
          },
        },
      });
    }
    return { transfer: { ...transfer, pastedTextAttachments }, discard };
  } catch (error) {
    await discard();
    throw error;
  }
}
