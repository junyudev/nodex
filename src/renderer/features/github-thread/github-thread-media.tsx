import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useState, type ComponentProps } from "react";
import type { Element } from "hast";
import { ImageLoadingTile } from "@/features/local-conversation/view/shared/user-message-attachments";
import { FileMarkdownImageFrame } from "@/lib/file-markdown-media/file-markdown-image-presentation";
import { gitHubThreadMediaQueryOptions } from "@/lib/github-threads";
import { useIntl } from "@/lib/i18n";
import {
  MarkdownNativeImage,
  markdownPublicLeafComponents,
} from "@/lib/markdown/markdown-public-leaves";
import { FileLinkAnchor } from "@/components/shared/file-link-anchor";
import { parseGitHubAttachment } from "../../../shared/github-media";
import type { GitHubThreadRef } from "../../../shared/github-thread";

export const GitHubAttachmentThread = createContext<GitHubThreadRef | null>(null);

type ImageProps = ComponentProps<"img"> & { node?: Element };
const PublicImage = markdownPublicLeafComponents.img;

export function GitHubAttachmentImage(props: ImageProps) {
  const thread = useContext(GitHubAttachmentThread);
  const attachment = typeof props.src === "string" ? parseGitHubAttachment(props.src) : null;
  if (!attachment || !thread)
    return typeof PublicImage === "function" ? <PublicImage {...props} /> : null;
  return (
    <GitHubAttachment
      key={attachment.id}
      thread={thread}
      attachment={attachment}
      alt={props.alt}
      title={props.title}
      width={props.width}
      height={props.height}
    />
  );
}

function GitHubAttachment({
  thread,
  attachment,
  alt,
  title,
  width,
  height,
}: Pick<ImageProps, "alt" | "title" | "width" | "height"> & {
  readonly thread: GitHubThreadRef;
  readonly attachment: NonNullable<ReturnType<typeof parseGitHubAttachment>>;
}) {
  const intl = useIntl();
  const query = useQuery(gitHubThreadMediaQueryOptions(thread, attachment.url));
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (query.isPending) {
    return (
      <ImageLoadingTile
        inline
        label={intl.formatMessage({
          id: "githubThread.media.loading",
          defaultMessage: "Loading attachment",
        })}
      />
    );
  }
  const media = query.data;
  if (media?.status !== "ready" || failedUrl === media.url) {
    return (
      <FileLinkAnchor href={attachment.url} className="text-token-text-link-foreground underline">
        {alt ||
          intl.formatMessage({
            id: "githubThread.media.open",
            defaultMessage: "Open attachment on GitHub",
          })}
      </FileLinkAnchor>
    );
  }
  const onError = () => setFailedUrl(media.url);
  if (media.kind === "video") {
    return (
      <video
        key={media.url}
        src={media.url}
        controls
        playsInline
        preload="metadata"
        aria-label={
          alt ||
          intl.formatMessage({
            id: "githubThread.media.video",
            defaultMessage: "GitHub attachment video",
          })
        }
        className="my-3 max-h-[480px] max-w-full rounded-lg"
        onError={onError}
      />
    );
  }
  return (
    <FileMarkdownImageFrame identity={media.url}>
      <MarkdownNativeImage
        src={media.url}
        alt={alt}
        title={title}
        width={width}
        height={height}
        resolvedName={alt || attachment.id}
        onError={onError}
      />
    </FileMarkdownImageFrame>
  );
}
