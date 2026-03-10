import { formatAttachmentBytes } from "./attachment-chip-format";

export interface AttachmentTooltipProps {
  kind: "text" | "file" | "folder";
  mode: "materialized" | "link";
  source: string;
  bytes?: number;
}

function getAttachmentSizeLabel(props: Pick<AttachmentTooltipProps, "kind" | "bytes">): string {
  if (props.kind === "folder") return "";
  return formatAttachmentBytes(props.bytes);
}

export function getAttachmentTooltipLines(
  props: AttachmentTooltipProps,
): { primary: string; secondary: string } {
  const sizeLabel = getAttachmentSizeLabel(props);

  if (props.mode === "link") {
    return {
      primary: props.source,
      secondary: `Linked attachment${sizeLabel ? ` • ${sizeLabel}` : ""} • Click for details`,
    };
  }

  return {
    primary: "Saved attachment",
    secondary: `${props.kind}${sizeLabel ? ` • ${sizeLabel}` : ""} • Click for details`,
  };
}
