import { defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import type { PluggableList } from "unified";
import { remarkInlineVisualizations } from "../inline-visualization/inline-visualization-directives";
import { fileMarkdownMediaRehypePlugins } from "../file-markdown-media/file-markdown-media-syntax";
import { streamdownPlugins } from "../streamdown";
import type { MarkdownSyntaxPolicy } from "./markdown-syntax";

import { remarkConversationMarkdown } from "./conversation-markdown-grammar";
import {
  CONVERSATION_MARKDOWN_HIDDEN_DIRECTIVES,
  type MarkdownDisplayDialect,
} from "../../../shared/conversation-markdown-display";

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
  readonly dialect?: MarkdownDisplayDialect;
  readonly preserveLineBreaks: boolean;
  readonly visualizations: boolean;
  readonly fileMedia: boolean;
  readonly repairIncomplete: boolean;
}): MarkdownSyntaxPolicy {
  const conversation = input.dialect === "conversation";
  const key = `${input.dialect ?? "document"}:${input.preserveLineBreaks}:${input.visualizations}:${input.fileMedia}:${input.repairIncomplete}`;
  let configuration = configurations.get(key);
  if (!configuration) {
    const grammar: PluggableList = conversation
      ? [
          [
            remarkConversationMarkdown,
            {
              renderedDirectiveNames: input.visualizations ? ["codex-inline-vis"] : [],
              nullDirectiveNames: [
                ...CONVERSATION_MARKDOWN_HIDDEN_DIRECTIVES.filter(
                  (name) => name !== "code-comment",
                ),
                ...(input.visualizations ? ["codex-live-vis"] : []),
              ],
            },
          ],
          ...Object.entries(defaultRemarkPlugins)
            .filter(([name]) => name !== "gfm")
            .map(([, plugin]) => plugin),
        ]
      : Object.values(defaultRemarkPlugins);
    const visualizations: PluggableList = input.visualizations
      ? [[remarkInlineVisualizations, { syntaxAlreadyRegistered: conversation }]]
      : [];
    const remarkPlugins: PluggableList = [
      ...streamdownPlugins.cjk.remarkPluginsBefore,
      ...grammar,
      ...(input.preserveLineBreaks ? [remarkBreaks] : []),
      ...visualizations,
      ...streamdownPlugins.cjk.remarkPluginsAfter,
      streamdownPlugins.math.remarkPlugin,
    ];
    const media = input.fileMedia ? fileMarkdownMediaRehypePlugins : null;
    const base: PluggableList = media ?? [
      ...(conversation ? [] : [defaultRehypePlugins.raw!]),
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
      rehypePlugins: [...rehypePlugins, streamdownPlugins.math.rehypePlugin],
      family: input.visualizations,
      dialect: input.dialect ?? "document",
      visualizationDirectives: input.visualizations,
      normalizeLists: true,
      repairIncomplete: input.repairIncomplete,
      blockLocal: true,
    };
    configurations.set(key, configuration);
  }
  return configuration;
}
