import { toast } from "@/components/ui/toast";
import { createUuidV7 } from "../../../../shared/uuid-v7";
import type { ImageSourceDimensions } from "../../../../shared/image-layout";
import { hasTypedOwnerType } from "@/lib/typed-owner-blocks";
import type { NfmEditorOwner } from "./nfm-editor-owner";
import type { FilePlacementRuntime } from "./file-runtime";
import {
  canMaterializePasteResourceItems,
  createPastedTextUploadFile,
  derivePastedTextAttachmentName,
  insertAttachmentsAtPasteTarget,
  insertBlocksAtPasteTarget,
  type PasteAttachmentInlineContent,
  type PasteResourceDialogState,
  type PasteResourceTarget,
} from "./paste-resource";

type PasteCommandOwner = Pick<NfmEditorOwner, "editor" | "getActiveStructuralSession">;

/** The dialog retains its selection lease for retry until a successful insert closes it. */
export async function pasteNfmResourceAttachments({
  owner,
  fileRuntime,
  dialog,
  mode,
  setPending,
  setError,
  closeDialog,
}: {
  readonly owner: PasteCommandOwner;
  readonly fileRuntime: Pick<FilePlacementRuntime, "upload"> | null;
  readonly dialog: PasteResourceDialogState;
  readonly mode: "materialized" | "link";
  readonly setPending: (pending: boolean) => void;
  readonly setError: (error: string | null) => void;
  readonly closeDialog: () => void;
}): Promise<void> {
  const editor = owner.editor;
  const typedTarget = hasTypedOwnerType([
    ...(dialog.target.selectedBlockTypes ?? []),
    dialog.target.currentBlockType ?? null,
  ]);
  if (mode === "materialized" && !canMaterializePasteResourceItems(dialog.items)) {
    setError("Folders can only be kept as links.");
    return;
  }

  try {
    setPending(true);
    setError(null);

    const nextAttachments: PasteAttachmentInlineContent[] = [];

    for (const item of dialog.items) {
      if (item.kind === "text") {
        if (!fileRuntime) throw new Error("File authority is unavailable");
        const text = dialog.textPayload ?? "";
        const upload = createPastedTextUploadFile(text);
        const uploaded = {
          source: await fileRuntime.upload({ kind: "browser_file", file: upload }),
          mimeType: upload.type || "text/plain",
          bytes: upload.size,
        };
        nextAttachments.push({
          type: "attachment",
          props: {
            kind: "text",
            mode,
            source: uploaded.source,
            name: derivePastedTextAttachmentName(text),
            mimeType: uploaded.mimeType,
            bytes: uploaded.bytes,
          },
        });
        continue;
      }

      if (mode === "link" && item.path) {
        nextAttachments.push({
          type: "attachment",
          props: {
            kind: item.kind,
            mode: "link",
            source: item.path,
            name: item.name,
            ...(item.mimeType ? { mimeType: item.mimeType } : {}),
            ...(item.kind === "file" && typeof item.bytes === "number"
              ? { bytes: item.bytes }
              : {}),
          },
        });
        continue;
      }

      if (item.path) {
        if (!fileRuntime) throw new Error("File authority is unavailable");
        const uploaded = {
          source: await fileRuntime.upload({ kind: "local_path", path: item.path }, item.name),
          name: item.name,
          mimeType: item.mimeType ?? "application/octet-stream",
          bytes: item.bytes,
        };
        nextAttachments.push({
          type: "attachment",
          props: {
            kind: item.kind,
            mode: "materialized",
            source: uploaded.source,
            name: uploaded.name,
            mimeType: uploaded.mimeType,
            ...(typeof uploaded.bytes === "number" ? { bytes: uploaded.bytes } : {}),
            origin: item.path,
          },
        });
        continue;
      }

      if (item.file) {
        if (!fileRuntime) throw new Error("File authority is unavailable");
        const uploaded = {
          source: await fileRuntime.upload({ kind: "browser_file", file: item.file }),
          name: item.file.name,
          mimeType: item.file.type || "application/octet-stream",
          bytes: item.file.size,
        };
        nextAttachments.push({
          type: "attachment",
          props: {
            kind: item.kind,
            mode: "materialized",
            source: uploaded.source,
            name: uploaded.name,
            mimeType: uploaded.mimeType,
            bytes: uploaded.bytes,
          },
        });
      }
    }

    if (nextAttachments.length === 0) {
      throw new Error("No pasted attachment could be created.");
    }

    if (!dialog.target.selection?.restore()) {
      throw new Error("The original paste position is no longer available.");
    }
    const inserted = typedTarget
      ? (owner.getActiveStructuralSession()?.handleBlockPaste([
          {
            id: createUuidV7(),
            type: "paragraph",
            props: {},
            content: nextAttachments,
            children: [],
          },
        ]) ?? false)
      : insertAttachmentsAtPasteTarget(editor, dialog.target, nextAttachments);
    if (!inserted) {
      throw new Error("Could not insert the attachment at the current cursor position.");
    }

    closeDialog();
  } catch (error) {
    console.error("Failed to insert pasted attachments", error);
    setError(
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "Failed to insert the pasted attachment.",
    );
  } finally {
    setPending(false);
  }
}

/** Restore the captured position after upload and release only this paste's lease. */
export async function pasteNfmImages({
  owner,
  files,
  target,
  uploadFile,
}: {
  readonly owner: PasteCommandOwner;
  readonly files: readonly File[];
  readonly target: PasteResourceTarget;
  readonly uploadFile: (file: File) => Promise<{
    props: { url: string; name: string } & Partial<ImageSourceDimensions>;
  }>;
}): Promise<void> {
  const editor = owner.editor;
  try {
    const blocks = await Promise.all(
      files.map(async (file) => {
        const uploaded = await uploadFile(file);
        return {
          id: createUuidV7(),
          type: "image" as const,
          props: uploaded.props,
          children: [],
        };
      }),
    );
    const typedTarget = hasTypedOwnerType([
      ...(target.selectedBlockTypes ?? []),
      target.currentBlockType ?? null,
    ]);
    if (!target.selection?.restore()) {
      throw new Error("The original paste position is no longer available.");
    }
    const inserted = typedTarget
      ? (owner
          .getActiveStructuralSession()
          ?.handleBlockPaste(
            blocks as Parameters<
              NonNullable<
                ReturnType<NfmEditorOwner["getActiveStructuralSession"]>
              >["handleBlockPaste"]
            >[0],
          ) ?? false)
      : insertBlocksAtPasteTarget(editor, target, blocks);
    if (!inserted) throw new Error("Couldn’t insert the pasted image at the original position");
  } catch (error) {
    console.error("Failed to paste image", error);
    toast.danger(error instanceof Error ? error.message : "Couldn’t paste image");
  } finally {
    target.selection?.release();
  }
}
