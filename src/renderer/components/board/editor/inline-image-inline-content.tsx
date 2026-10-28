import { createReactInlineContentSpec } from "@blocknote/react";
import { inlineImageInlineContentConfig } from "../../../../shared/block-documents/blocknote-schema-config";
import { InlineImage, inlineImageProps } from "../inline-image";

/** The same image in the editor and in read-only previews; a copy carries a plain `<img>`. */
export const inlineImageInlineContentSpec = createReactInlineContentSpec(
  inlineImageInlineContentConfig,
  {
    render: ({ inlineContent }) => <InlineImage {...inlineImageProps(inlineContent.props)} />,
    toExternalHTML: ({ inlineContent }) => {
      const { url, alt, width, href } = inlineImageProps(inlineContent.props);
      const image = <img src={url} alt={alt} width={width} />;
      return href ? <a href={href}>{image}</a> : image;
    },
  },
);
