import { useState, type ReactNode } from "react";
import { FileReadBoundary } from "@/components/board/editor/file-runtime";
import { NfmDocument, markdownImageAlt } from "@/components/board/nfm-renderer";
import { useMarkdownImage } from "@/components/board/markdown-image";
import { FileLinkWorkspaceProvider } from "@/components/shared/file-link-anchor";
import {
  ImageErrorTile,
  ImageLoadingTile,
  UserImageButton,
} from "@/features/local-conversation/view/shared/user-message-attachments";
import { UserMessageCollapse } from "@/features/local-conversation/view/shared/user-message-collapse";
import { ImagePreviewDialog } from "@/features/user-attachment-image-editor";
import type { FileReadAuthority } from "@/lib/library-file-resources";
import { parseMessageText, splitMessageContent } from "../../../shared/message-content";
import type { MarkdownBlock } from "../../../shared/nodex-markdown";

/**
 * A written message, read-only, as a bubble shows it: the images attached to it as a row of
 * thumbnails where they sit, usually above its text, and the text in chat typography, collapsed
 * after as many lines as a chat
 * message. `contentKey` identifies the message, so an expanded message collapses again when it
 * changes. `fileAuthority` reads the message's Library Files; without it, images show as
 * unavailable. `lead` opens the first line of text, which flows on after it and wraps beneath it.
 */
export function MessageDocument({
  blocks,
  contentKey,
  fileAuthority,
  collapsedLineCount,
  lead,
}: {
  readonly blocks: readonly MarkdownBlock[];
  readonly contentKey: string;
  readonly fileAuthority: FileReadAuthority | null;
  readonly collapsedLineCount?: number;
  readonly lead?: ReactNode;
}) {
  const { text, attachments, attachmentsAt } = splitMessageContent(blocks);
  const images = attachments.length > 0 ? <MessageImages images={attachments} /> : null;
  return (
    <FileReadBoundary authority={fileAuthority}>
      <div className="flex min-w-0 flex-col gap-2">
        {/* With no text, the lead opens the message on a line of its own. */}
        {lead != null && text.length === 0 ? (
          <span className="flex h-lh items-center">{lead}</span>
        ) : null}
        {attachmentsAt === "start" ? images : null}
        {text.length > 0 ? (
          <UserMessageCollapse contentKey={contentKey} collapsedLineCount={collapsedLineCount}>
            <NfmDocument
              lead={lead}
              blocks={[...text]}
              density="message"
              className="codex-markdown codex-markdown-user text-size-chat"
            />
          </UserMessageCollapse>
        ) : null}
        {attachmentsAt === "end" ? images : null}
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

function MessageImages({ images }: { readonly images: readonly MarkdownBlock[] }) {
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
  readonly image: MarkdownBlock;
  readonly onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const { url, failed } = useMarkdownImage(String(image.props?.url ?? ""));
  if (failed) return <ImageErrorTile />;
  if (!url) return <ImageLoadingTile label="Loading image" />;
  return (
    <UserImageButton
      src={url}
      alt={markdownImageAlt(image)}
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
  readonly images: readonly MarkdownBlock[];
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
  /** Takes focus back when the viewer closes. */
  readonly finalFocus: HTMLElement | null;
}) {
  const image = images[index]!;
  const { url } = useMarkdownImage(String(image.props?.url ?? ""));
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
      alt={markdownImageAlt(image)}
      onPreviousImage={index > 0 ? () => onIndexChange(index - 1) : undefined}
      onNextImage={index < images.length - 1 ? () => onIndexChange(index + 1) : undefined}
    />
  );
}
