import type { LibraryFile } from "../../../shared/library-files";
import { formatBytes, formatDate } from "@/lib/file-metadata-format";

/** Both managers show File metadata; a historical preview overrides version-specific fields. */
export function FileDetailsMetadata({
  file,
  version,
  mimeType,
  byteLength,
}: {
  file: LibraryFile;
  version?: number;
  mimeType?: string;
  byteLength?: number;
}) {
  return (
    <p className="mt-1 flex flex-wrap gap-x-1 text-xs text-token-description-foreground">
      <span>
        {mimeType ?? file.mime_type} · {formatBytes(byteLength ?? file.byte_length)} · v
        {version ?? file.head_version}
      </span>
      <span>
        · Updated <time dateTime={file.updated_at}>{formatDate(file.updated_at)}</time>
      </span>
    </p>
  );
}

/** List rows prioritize recognition; detailed version metadata stays in the preview. */
export function FileListMetadata({ file }: { file: LibraryFile }) {
  const updated = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(file.updated_at),
  );
  return (
    <span className="block truncate text-xs text-token-description-foreground">
      {formatBytes(file.byte_length)} · Updated <time dateTime={file.updated_at}>{updated}</time>
    </span>
  );
}
