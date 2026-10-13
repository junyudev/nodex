import type { ComponentProps } from "react";
import { MarkdownDocumentRenderer } from "@/lib/markdown/markdown-document-renderer";
import { readMarkdownSyntaxPolicy } from "@/lib/markdown/markdown-policy";

type Props = Omit<ComponentProps<typeof MarkdownDocumentRenderer>, "policy"> & {
  readonly preserveLineBreaks: boolean;
  readonly visualizations: boolean;
  readonly fileMedia: boolean;
};

export default function MarkdownDocumentSurface({
  preserveLineBreaks,
  visualizations,
  fileMedia,
  ...props
}: Props) {
  const policy = readMarkdownSyntaxPolicy({
    preserveLineBreaks,
    visualizations,
    fileMedia,
    repairIncomplete: props.streaming,
  });
  return <MarkdownDocumentRenderer {...props} policy={policy} />;
}
