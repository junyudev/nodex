import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  FileReadBoundary,
  useFilePlacementRuntime,
  useFileReadSnapshot,
} from "@/components/board/editor/file-runtime";
import { useMarkdownImage } from "@/components/board/markdown-image";
import { PlusIcon } from "@/components/shared/icons";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  classifyComposerDataTransfer,
  ComposerImageAttachmentThumbnail,
  handleComposerFilePaste,
  isSupportedComposerImageFile,
  resolveComposerImageAttachmentSize,
  takeComposerLibraryImagePaste,
  type ComposerPastedFiles,
} from "@/features/local-conversation/view/composer/image-attachments";
import { ComposerAttachmentStrip } from "@/components/composer/composer-attachments";
import { COMPOSER_FOOTER_GHOST_ICON_BUTTON_CLASS_NAME } from "@/components/composer/composer-footer-controls";
import { useDragDepth } from "@/lib/use-drag-depth";
import type { FileReadAuthority } from "@/lib/library-file-resources";
import { insertTyped, pasteMarkdownSource } from "@/lib/text-field-paste";
import {
  COMPOSER_IMAGE_MIME_TYPES,
  isSupportedComposerImageMimeType,
} from "../../../shared/composer-image-input";
import { fileSource } from "../../../shared/file-resources";
import { messageImageBlock } from "../../../shared/message-content";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { MessageImagePreview } from "./message-document";

/** An image attached to a message being written, already imported as a Library File. */
export interface MessageDraftImage {
  readonly fileId: string;
  readonly name: string;
  /** The File's revision when this draft imported it; only such an image is discarded with it. */
  readonly importedRevision?: number;
}

/** What a Composer needs to take images: where they are imported, and how they are read back. */
export interface MessageImageAccess {
  readonly importImage: (file: File) => Promise<MessageDraftImage>;
  /** Moves a File a draft imported to Trash, unless it changed or came into use since. */
  readonly discardImport: (fileId: string, importedRevision: number) => Promise<void>;
  readonly readAuthority: FileReadAuthority;
}

interface MessageImageUpload {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

/**
 * Whether a drag may hold an image, which marks the Composer for it. Only a drop names its files,
 * and a name decides, so a type that says nothing could still be an image.
 */
const dragMayHoldImage = (transfer: DataTransfer): boolean =>
  Array.from(transfer.items ?? []).some(
    (item) =>
      item.kind === "file" &&
      (item.type === "" ||
        item.type === "application/octet-stream" ||
        isSupportedComposerImageMimeType(item.type)),
  );

/**
 * Takes images pasted, dropped, or picked into a Composer and imports each as a Library File;
 * `onImported` attaches them to the draft. A local preview stands in while each one imports.
 * An image the draft imported and then let go of, before it was sent, goes to Trash.
 */
export function useMessageImageInput({
  access,
  onImported,
}: {
  readonly access: MessageImageAccess | null;
  readonly onImported: (images: readonly MessageDraftImage[]) => void;
}) {
  const [uploads, setUploads] = useState<readonly MessageImageUpload[]>([]);
  const drag = useDragDepth();
  const cancelled = useRef(new Set<string>());
  const previews = useRef(new Map<string, string>());
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, []);

  const discard = (images: readonly MessageDraftImage[], from = access) => {
    for (const image of images) {
      if (!from || image.importedRevision === undefined) continue;
      // Best effort: a File that stays behind is only an unused File in the Library.
      void from.discardImport(image.fileId, image.importedRevision).catch(() => undefined);
    }
  };

  const add = (files: readonly File[]): boolean => {
    const images = files.filter(isSupportedComposerImageFile);
    if (!access || images.length === 0) return false;
    const from = access;
    for (const file of images) {
      const upload = { id: createUuidV7(), name: file.name, url: URL.createObjectURL(file) };
      setUploads((current) => [...current, upload]);
      void from
        .importImage(file)
        .then(
          (image) => {
            previews.current.set(image.fileId, upload.url);
            if (cancelled.current.has(upload.id)) discard([image], from);
            else onImported([image]);
          },
          () => {
            URL.revokeObjectURL(upload.url);
            toast.danger(file.name ? `Couldn’t add ${file.name}` : "Couldn’t add the image");
          },
        )
        .finally(() => {
          cancelled.current.delete(upload.id);
          setUploads((current) => current.filter((entry) => entry.id !== upload.id));
        });
    }
    return true;
  };

  return {
    uploads,
    importing: uploads.length > 0,
    add,
    discard,
    cancel: (id: string) => {
      cancelled.current.add(id);
      setUploads((current) => current.filter((entry) => entry.id !== id));
    },
    /** The local preview of an image imported here, shown until its File is read. */
    previewUrl: (fileId: string) => previews.current.get(fileId) ?? null,
    /**
     * The Composer's paste: images become attachments, text arrives as its Markdown source. An
     * image copied from Nodex is already a Library File, so the draft uses that File itself.
     */
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const take = ({ imageFiles, libraryImages }: ComposerPastedFiles) => {
        if (!access) return false;
        if (libraryImages.length === 0) return add(imageFiles);
        onImported(libraryImages.map(({ fileId, caption }) => ({ fileId, name: caption })));
        return true;
      };
      if (handleComposerFilePaste(event.nativeEvent, take)) return;
      const library = takeComposerLibraryImagePaste(event.nativeEvent, take);
      if (!library) {
        pasteMarkdownSource(event);
        return;
      }
      event.preventDefault();
      if (library.text) insertTyped(event.currentTarget, library.text);
    },
    /** True while a drag this Composer takes is over its drop target. */
    dropActive: drag.active,
    /** Spread on the element that takes dropped images. */
    dropTarget: {
      onDragEnter: (event: DragEvent<HTMLElement>) => {
        if (!access || !dragMayHoldImage(event.dataTransfer)) return;
        event.preventDefault();
        drag.enter();
      },
      onDragLeave: () => {
        drag.leave();
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        // Stays open to every file: refusing one here would refuse an image the drop would take.
        if (!access || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        drag.end();
        if (add(classifyComposerDataTransfer(event.dataTransfer).imageFiles))
          event.preventDefault();
      },
    },
  };
}

export type MessageImageInput = ReturnType<typeof useMessageImageInput>;

/** The draft's images in one row above its text, as thumbnails that open and can be removed. */
export function MessageImageRow({
  images,
  input,
  readAuthority,
  onRemove,
}: {
  readonly images: readonly MessageDraftImage[];
  readonly input: MessageImageInput;
  readonly readAuthority: FileReadAuthority | null;
  readonly onRemove: (fileId: string) => void;
}) {
  const [preview, setPreview] = useState<{
    readonly index: number;
    readonly finalFocus: HTMLElement | null;
  } | null>(null);
  if (images.length === 0 && input.uploads.length === 0) return null;
  const size = resolveComposerImageAttachmentSize(false);
  const viewed = images.map((image) => messageImageBlock(image.fileId));
  return (
    <FileReadBoundary authority={readAuthority}>
      <ComposerAttachmentStrip>
        {images.map((image, index) => (
          <DraftImageThumbnail
            key={image.fileId}
            image={image}
            size={size}
            previewUrl={input.previewUrl(image.fileId)}
            onOpen={() =>
              setPreview({
                index,
                finalFocus:
                  document.activeElement instanceof HTMLElement ? document.activeElement : null,
              })
            }
            onRemove={() => {
              onRemove(image.fileId);
              input.discard([image]);
            }}
          />
        ))}
        {input.uploads.map((upload) => (
          <ComposerImageAttachmentThumbnail
            key={upload.id}
            attachment={{
              id: upload.id,
              filename: upload.name,
              src: upload.url,
              uploadStatus: "uploading",
            }}
            previewEnabled={false}
            size={size}
            onOpen={() => undefined}
            onRemove={input.cancel}
          />
        ))}
      </ComposerAttachmentStrip>
      {preview && viewed[preview.index] ? (
        <MessageImagePreview
          images={viewed}
          index={preview.index}
          onIndexChange={(index) => setPreview({ ...preview, index })}
          onClose={() => setPreview(null)}
          finalFocus={preview.finalFocus}
        />
      ) : null}
    </FileReadBoundary>
  );
}

function DraftImageThumbnail({
  image,
  size,
  previewUrl,
  onOpen,
  onRemove,
}: {
  readonly image: MessageDraftImage;
  readonly size: 80 | 54;
  readonly previewUrl: string | null;
  readonly onOpen: () => void;
  readonly onRemove: () => void;
}) {
  const source = fileSource(image.fileId);
  const runtime = useFilePlacementRuntime();
  const metadata = useFileReadSnapshot(runtime, source, { metadata: true }).metadata;
  const { url, failed } = useMarkdownImage(source);
  const src = url ?? previewUrl;
  return (
    <ComposerImageAttachmentThumbnail
      attachment={{
        id: image.fileId,
        filename: image.name || metadata?.default_name || "Image",
        src: src ?? "",
        uploadStatus: src || failed ? "idle" : "uploading",
      }}
      previewEnabled={src !== null}
      size={size}
      onOpen={onOpen}
      onRemove={onRemove}
    />
  );
}

/** Opens the system picker for images; the picked ones go to `onFiles`. */
export function MessageImagePicker({
  onFiles,
  disabled = false,
}: {
  readonly onFiles: (files: readonly File[]) => void;
  readonly disabled?: boolean;
}): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <NodexTooltip tooltipContent="Add photos">
        <button
          type="button"
          aria-label="Add photos"
          disabled={disabled}
          className={COMPOSER_FOOTER_GHOST_ICON_BUTTON_CLASS_NAME}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => inputRef.current?.click()}
        >
          <PlusIcon className="icon-sm" />
        </button>
      </NodexTooltip>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        data-testid="message-image-picker"
        accept={COMPOSER_IMAGE_MIME_TYPES.join(",")}
        onChange={(event) => {
          onFiles([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = "";
        }}
      />
    </>
  );
}
