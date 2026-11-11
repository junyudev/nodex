import {
  useFilePlacementRuntime,
  useFileReadSnapshot,
} from "@/components/board/editor/file-runtime";
import { toast } from "@/components/ui/toast";
import { ImagePreviewDialog } from "@/features/user-attachment-image-editor";
import { fileSource } from "../../../shared/file-resources";

/**
 * One Page image shown over the Page it belongs to, read through the surrounding File read
 * boundary. Looking at an image opens no tab; `onOpenInTab` is how the person asks for one.
 */
export function PageFileImagePreview({
  fileId,
  name,
  onClose,
  onPrevious,
  onNext,
  onOpenInTab,
}: {
  readonly fileId: string;
  readonly name: string;
  readonly onClose: () => void;
  readonly onPrevious?: () => void;
  readonly onNext?: () => void;
  readonly onOpenInTab?: () => void;
}) {
  const runtime = useFilePlacementRuntime();
  const source = fileSource(fileId);
  const snapshot = useFileReadSnapshot(runtime, source, { objectUrl: true });
  const unavailable = !runtime || Boolean(snapshot.contentError || snapshot.metadataError);
  return (
    <ImagePreviewDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      src={snapshot.objectUrl ?? ""}
      loading={!snapshot.objectUrl && !unavailable}
      unavailable={unavailable}
      alt={name}
      title={name}
      onDownload={async () => {
        try {
          await runtime?.save(source, name);
        } catch (error) {
          toast.danger(error instanceof Error ? error.message : "Couldn’t save File");
        }
      }}
      onPreviousImage={onPrevious}
      onNextImage={onNext}
      openIn={onOpenInTab ? { label: "Open in tab", open: onOpenInTab } : undefined}
    />
  );
}
