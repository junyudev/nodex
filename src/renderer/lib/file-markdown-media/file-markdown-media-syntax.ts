import type { Element, Root, RootContent } from "hast";
import type { Plugin, PluggableList } from "unified";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { defaultRehypePlugins } from "streamdown";

export const FILE_MARKDOWN_IMAGE_TAG = "nodex-file-markdown-image";
export const FILE_MARKDOWN_SOURCE_TAG = "nodex-file-markdown-source";

const resourceProperties = (node: Element) => ({
  filesrc: typeof node.properties.src === "string" ? node.properties.src : "",
  filesrcset: typeof node.properties.srcSet === "string" ? node.properties.srcSet : "",
  alt: node.properties.alt,
  title: node.properties.title,
  width: node.properties.width,
  height: node.properties.height,
  sizes: node.properties.sizes,
  media: node.properties.media,
  type: node.properties.type,
});

/** Convert before sanitization: no authored filesystem URL reaches native media props. */
const rehypeFileMarkdownMedia: Plugin<[], Root> = () => (tree) => {
  const convert = (node: RootContent) => {
    if (node.type !== "element") return;
    if (node.tagName === "img" || node.tagName === "source") {
      node.properties = resourceProperties(node);
      node.tagName = node.tagName === "img" ? FILE_MARKDOWN_IMAGE_TAG : FILE_MARKDOWN_SOURCE_TAG;
    }
    node.children.forEach(convert);
  };
  tree.children.forEach(convert);
};

export const fileMarkdownMediaRehypePlugins: PluggableList = [
  defaultRehypePlugins.raw!,
  rehypeFileMarkdownMedia,
  [
    rehypeSanitize,
    {
      ...defaultSchema,
      protocols: {
        ...defaultSchema.protocols,
        href: [...(defaultSchema.protocols?.href ?? []), "tel"],
      },
      tagNames: [
        ...(defaultSchema.tagNames ?? []),
        FILE_MARKDOWN_IMAGE_TAG,
        FILE_MARKDOWN_SOURCE_TAG,
      ],
      attributes: {
        ...defaultSchema.attributes,
        code: [...(defaultSchema.attributes?.code ?? []), "metastring"],
        [FILE_MARKDOWN_IMAGE_TAG]: [
          "filesrc",
          "filesrcset",
          "alt",
          "title",
          "width",
          "height",
          "sizes",
        ],
        [FILE_MARKDOWN_SOURCE_TAG]: ["filesrcset", "sizes", "media", "type", "width", "height"],
      },
    },
  ],
  defaultRehypePlugins.harden!,
];
