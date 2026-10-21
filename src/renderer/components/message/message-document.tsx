import { useState } from "react";
import { FileReadBoundary } from "@/components/board/editor/file-runtime";
import { NfmDocument, nfmImageAlt, useNfmImage } from "@/components/board/nfm-renderer";
import { FileLinkWorkspaceProvider } from "@/components/shared/file-link-anchor";
import {
  ImageErrorTile,
  ImageLoadingTile,
  UserImageButton,
} from "@/features/local-conversation/view/shared/user-message-attachments";
import { UserMessageCollapse } from "@/features/local-conversation/view/shared/user-message-collapse";
import { ImagePreviewDialog } from "@/features/user-attachment-image-editor";
import type { FileReadAuthority } from "@/lib/library-file-resources";
import { splitMessageContent } from "../../../shared/message-content";
import { parseMessageText } from "../../../shared/message-text";
import type { NfmBlock, NfmImage } from "../../../shared/nfm/types";

/**
 * A written message, read-only, as a bubble shows it: the images attached to it as thumbnails
 * above its text, and the text in chat typography, collapsed after as many lines as a chat
 * message. `contentKey` identifies the message, so an expanded message collapses again when it
 * changes. `fileAuthority` reads the message's Library Files; without it, images show as
 * unavailable.
 */
export function MessageDocument({
  blocks,
  contentKey,
  fileAuthority,
  collapsedLineCount,
}: {
  readonly blocks: readonly NfmBlock[];
  readonly contentKey: string;
  readonly fileAuthority: FileReadAuthority | null;
  readonly collapsedLineCount?: number;
}) {
  const { text, attachments } = splitMessageContent(blocks);
  return (
    <FileReadBoundary authority={fileAuthority}>
      <div className="flex min-w-0 flex-col gap-2">
        {attachments.length > 0 ? <MessageImages images={attachments} /> : null}
        {text.length > 0 ? (
          <UserMessageCollapse contentKey={contentKey} collapsedLineCount={collapsedLineCount}>
            <NfmDocument
              blocks={[...text]}
              density="message"
              className="codex-markdown codex-markdown-user text-size-chat"
            />
          </UserMessageCollapse>
        ) : null}
      </div>
    </FileReadBoundary>
  );
}

/**
 * Text someone wrote to an Agent, such as a chat message or a prompt, read as message text.
 * Relative file links resolve from `cwd`, else the Project workspace.
 */
export function MessageText({
  text,
  cwd,
  projectWorkspacePath,
  collapsedLineCount,
}: {
  readonly text: string;
  readonly cwd?: string | null;
  readonly projectWorkspacePath?: string | null;
  readonly collapsedLineCount?: number;
}) {
  return (
    <FileLinkWorkspaceProvider cwd={cwd} workspacePath={projectWorkspacePath}>
      <MessageDocument
        blocks={parseMessageText(text)}
        contentKey={text}
        fileAuthority={null}
        collapsedLineCount={collapsedLineCount}
      />
    </FileLinkWorkspaceProvider>
  );
}

function MessageImages({ images }: { readonly images: readonly NfmImage[] }) {
  const [preview, setPreview] = useState<{
    readonly index: number;
    readonly trigger: HTMLButtonElement;
  } | null>(null);
  return (
    <div className="flex flex-wrap gap-2" data-message-images="true">
      {images.map((image, index) => (
        <MessageImage
          key={index}
          image={image}
          onOpen={(trigger) => setPreview({ index, trigger })}
        />
      ))}
      {preview ? (
        <MessageImagePreview
          images={images}
          index={preview.index}
          onIndexChange={(index) => setPreview({ ...preview, index })}
          onClose={() => setPreview(null)}
          finalFocus={preview.trigger}
        />
      ) : null}
    </div>
  );
}

function MessageImage({
  image,
  onOpen,
}: {
  readonly image: NfmImage;
  readonly onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const { url, failed } = useNfmImage(image.source);
  if (failed) return <ImageErrorTile />;
  if (!url) return <ImageLoadingTile label="Loading image" />;
  return (
    <UserImageButton
      src={url}
      alt={nfmImageAlt(image)}
      fit="cover"
      bordered
      onOpenPreview={onOpen}
    />
  );
}

/** The image viewer over a message's images, starting at `index`. */
export function MessageImagePreview({
  images,
  index,
  onIndexChange,
  onClose,
  finalFocus,
}: {
  readonly images: readonly NfmImage[];
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
  /** Takes focus back when the viewer closes. */
  readonly finalFocus: HTMLElement | null;
}) {
  const image = images[index]!;
  const { url } = useNfmImage(image.source);
  if (!url) return null;
  return (
    <ImagePreviewDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      finalFocus={() => {
        finalFocus?.focus();
        return false;
      }}
      src={url}
      alt={nfmImageAlt(image)}
      onPreviousImage={index > 0 ? () => onIndexChange(index - 1) : undefined}
      onNextImage={index < images.length - 1 ? () => onIndexChange(index + 1) : undefined}
    />
  );
}
