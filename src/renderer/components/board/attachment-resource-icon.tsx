import { ColorfulFileResourceIcon } from "@/components/shared/file-resource-icon";

interface AttachmentResourceIconProps {
  readonly kind: "text" | "file" | "folder";
  readonly name?: string | null;
  readonly mimeType?: string | null;
  readonly className?: string;
}

/** Keeps attachment identity on the same path/MIME projection as every File surface. */
export function AttachmentResourceIcon({
  kind,
  name,
  mimeType,
  className,
}: AttachmentResourceIconProps) {
  const resourcePath = kind === "folder" ? `${name || "folder"}/` : name;
  const resourceMimeType = mimeType || (kind === "text" ? "text/plain" : undefined);

  return (
    <ColorfulFileResourceIcon
      path={resourcePath}
      mimeType={resourceMimeType}
      className={className}
    />
  );
}
