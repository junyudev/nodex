import { defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import type { PluggableList } from "unified";
import { remarkInlineVisualizations } from "../inline-visualization/inline-visualization-directives";
import { fileMarkdownMediaRehypePlugins } from "../file-markdown-media/file-markdown-media-syntax";
import { markdownDocumentPlugins } from "./markdown-document-plugins";
import type { MarkdownSyntaxPolicy } from "./markdown-syntax";

const configurations = new Map<string, MarkdownSyntaxPolicy>();
const proseSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "tel"],
  },
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "metastring"],
  },
};
const visualizationSchema = {
  ...proseSchema,
  tagNames: [...(proseSchema.tagNames ?? []), "nodex-visualization"],
  attributes: { ...proseSchema.attributes, "nodex-visualization": ["file", "threadid", "mode"] },
};

/** Only the application's known block-local extensions may use the prefix lane. */
export function readMarkdownSyntaxPolicy(input: {
  readonly preserveLineBreaks: boolean;
  readonly visualizations: boolean;
  readonly fileMedia: boolean;
  readonly repairIncomplete: boolean;
}): MarkdownSyntaxPolicy {
  const key = `${input.preserveLineBreaks}:${input.visualizations}:${input.fileMedia}:${input.repairIncomplete}`;
  let configuration = configurations.get(key);
  if (!configuration) {
    const visualizations: PluggableList = input.visualizations
      ? [[remarkInlineVisualizations]]
      : [];
    const remarkPlugins: PluggableList = [
      ...markdownDocumentPlugins.cjk.remarkPluginsBefore,
      ...Object.values(defaultRemarkPlugins),
      ...(input.preserveLineBreaks ? [remarkBreaks] : []),
      ...visualizations,
      ...markdownDocumentPlugins.cjk.remarkPluginsAfter,
      markdownDocumentPlugins.math.remarkPlugin,
    ];
    const media = input.fileMedia ? fileMarkdownMediaRehypePlugins : null;
    const base: PluggableList = media ?? [
      defaultRehypePlugins.raw!,
      [rehypeSanitize, input.visualizations ? visualizationSchema : proseSchema],
      defaultRehypePlugins.harden!,
    ];
    const rehypePlugins: PluggableList =
      input.visualizations && media
        ? base.map((plugin) => {
            if (!Array.isArray(plugin) || plugin[0] !== rehypeSanitize) return plugin;
            const schema = plugin[1] as typeof proseSchema;
            return [
              rehypeSanitize,
              {
                ...schema,
                tagNames: [...(schema.tagNames ?? []), "nodex-visualization"],
                attributes: {
                  ...schema.attributes,
                  "nodex-visualization": ["file", "threadid", "mode"],
                },
              },
            ];
          })
        : base;
    configuration = {
      remarkPlugins,
      rehypePlugins: [...rehypePlugins, markdownDocumentPlugins.math.rehypePlugin],
      family: input.visualizations,
      normalizeLists: true,
      repairIncomplete: input.repairIncomplete,
      blockLocal: true,
    };
    configurations.set(key, configuration);
  }
  return configuration;
}
