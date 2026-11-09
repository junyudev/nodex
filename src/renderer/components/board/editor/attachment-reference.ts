import { formatBytes } from "@/lib/file-metadata-format";
import type { FilePreviewAuthority, FileReadAuthority } from "@/lib/library-file-resources";
import { describeFileFormat } from "@/lib/page-file-view-kind";
import type { ContentRoutingContext } from "../../../../shared/content-routing-context";
import { parseAssetSource } from "../../../../shared/assets";
import { parseFileSource } from "../../../../shared/file-resources";

export interface AttachmentReferenceProps {
  readonly kind: "text" | "file" | "folder";
  readonly mode: "materialized" | "link";
  readonly source: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly bytes?: number;
}

/**
 * Where an attachment opens. A Library File opens beside its Page like any Page File; one read
 * through a captured or other non-Page authority opens in a viewer bound to that authority. A
 * linked path, or a saved copy from an older surface, opens as the local file it is.
 */
export type AttachmentDestination =
  | {
      readonly kind: "page-file";
      readonly routingContext: ContentRoutingContext;
      readonly pageId: string;
      readonly fileId: string;
    }
  | {
      readonly kind: "file-viewer";
      readonly authority: FileReadAuthority | FilePreviewAuthority;
      readonly fileId: string;
    }
  | { readonly kind: "local-path"; readonly path: string; readonly directory: boolean }
  | { readonly kind: "managed-asset"; readonly source: string; readonly directory: boolean }
  | { readonly kind: "none" };

export function resolveAttachmentDestination(input: {
  readonly attachment: Pick<AttachmentReferenceProps, "kind" | "mode" | "source">;
  /** The read capability of the surface showing the attachment, when it has one. */
  readonly authority: FileReadAuthority | FilePreviewAuthority | null;
  /** Whether the surface can open a Page File tab beside its Page. */
  readonly canOpenPageFile: boolean;
}): AttachmentDestination {
  const { attachment, authority } = input;
  const fileId = parseFileSource(attachment.source);
  if (fileId) {
    if (!authority) return { kind: "none" };
    const currentPage =
      "readSource" in authority &&
      authority.readSource.kind === "page" &&
      authority.version === undefined
        ? authority.readSource.page_id
        : null;
    if (currentPage && input.canOpenPageFile) {
      return {
        kind: "page-file",
        routingContext: authority.contentRoutingContext,
        pageId: currentPage,
        fileId,
      };
    }
    return { kind: "file-viewer", authority, fileId };
  }
  const directory = attachment.kind === "folder";
  if (attachment.mode === "link" && attachment.source.length > 0) {
    return { kind: "local-path", path: attachment.source, directory };
  }
  if (parseAssetSource(attachment.source)) {
    return { kind: "managed-asset", source: attachment.source, directory };
  }
  return { kind: "none" };
}

/** The hover summary: the full name, then what the attachment is and where it lives. */
export function describeAttachment(attachment: AttachmentReferenceProps): {
  readonly title: string;
  readonly detail: string;
} {
  const title =
    attachment.name.trim() || (attachment.kind === "text" ? "Pasted text" : "Untitled attachment");
  if (attachment.mode === "link") return { title, detail: attachment.source };
  if (attachment.kind === "folder") return { title, detail: "Folder" };
  const format = describeFileFormat({
    name: attachment.name,
    mimeType: attachment.mimeType || (attachment.kind === "text" ? "text/plain" : ""),
  });
  const size =
    typeof attachment.bytes === "number" &&
    Number.isFinite(attachment.bytes) &&
    attachment.bytes >= 0
      ? formatBytes(attachment.bytes)
      : null;
  return { title, detail: size ? `${format} · ${size}` : format };
}
