import { useIntl } from "@/lib/i18n";
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
  const intl = useIntl();
  return (
    <p className="mt-1 flex flex-wrap gap-x-1 text-xs text-token-description-foreground">
      <span>
        {intl.formatMessage(
          {
            id: "components.fileMetadata.details",
            defaultMessage: "{mimeType} · {size} · v{version}",
          },
          {
            mimeType: mimeType ?? file.mime_type,
            size: formatBytes(byteLength ?? file.byte_length),
            version: intl.formatNumber(version ?? file.head_version),
          },
        )}
      </span>
      <span>
        {intl.formatMessage(
          {
            id: "components.fileMetadata.updated",
            defaultMessage: "· Updated <date>{value}</date>",
          },
          {
            value: formatDate(file.updated_at),
            date: (chunks) => <time dateTime={file.updated_at}>{chunks}</time>,
          },
        )}
      </span>
    </p>
  );
}

/** List rows prioritize recognition; detailed version metadata stays in the preview. */
export function FileListMetadata({ file }: { file: LibraryFile }) {
  const intl = useIntl();
  const updated = intl.formatDate(new Date(file.updated_at), { dateStyle: "medium" });
  return (
    <span className="block truncate text-xs text-token-description-foreground">
      {formatBytes(file.byte_length)}{" "}
      {intl.formatMessage(
        { id: "components.fileMetadata.updated", defaultMessage: "· Updated <date>{value}</date>" },
        { value: updated, date: (chunks) => <time dateTime={file.updated_at}>{chunks}</time> },
      )}
    </span>
  );
}
