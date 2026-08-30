import {
  defaultProps,
  type CustomBlockConfig,
  type CustomInlineContentConfig,
} from "@blocknote/core";
export const mathBlockConfig = {
  type: "mathBlock",
  propSchema: {},
  content: "plain",
} as const satisfies CustomBlockConfig;

export const mathInlineContentConfig = {
  type: "math",
  propSchema: {},
  content: "plain",
} as const satisfies CustomInlineContentConfig;

export const calloutBlockConfig = {
  type: "callout",
  propSchema: {
    ...defaultProps,
    icon: { default: "💡" },
  },
  content: "inline",
} as const satisfies CustomBlockConfig;

export const pageRefBlockConfig = {
  type: "pageRef",
  propSchema: {
    targetBlockId: { default: "" },
  },
  content: "none",
} as const satisfies CustomBlockConfig;

export const pageBlockConfig = {
  type: "page",
  propSchema: {},
  content: "none",
} as const satisfies CustomBlockConfig;

export const databaseBlockConfig = {
  type: "database",
  propSchema: {},
  content: "none",
} as const satisfies CustomBlockConfig;

export const canvasBlockConfig = {
  type: "canvas",
  propSchema: {},
  content: "none",
} as const satisfies CustomBlockConfig;

export const databaseViewRefBlockConfig = {
  type: "databaseViewRef",
  propSchema: {
    databaseViewId: { default: "" },
    displayHint: { default: "" },
  },
  content: "none",
} as const satisfies CustomBlockConfig;

export const syncedBlockRefBlockConfig = {
  type: "syncedBlockRef",
  propSchema: {
    sourceBlockId: { default: "" },
  },
  content: "none",
} as const satisfies CustomBlockConfig;

export const reusableTemplateRefBlockConfig = {
  type: "templateRef",
  propSchema: {
    sourceBlockId: { default: "" },
    displayHint: { default: "" },
  },
  content: "none",
} as const satisfies CustomBlockConfig;

export const threadSectionBlockConfig = {
  type: "threadSection",
  propSchema: {
    ...defaultProps,
    label: { default: "" },
    threadId: { default: "" },
  },
  content: "none",
} as const satisfies CustomBlockConfig;

export const attachmentInlineContentConfig = {
  type: "attachment",
  propSchema: {
    kind: { default: "text" },
    mode: { default: "materialized" },
    source: { default: "" },
    name: { default: "" },
    mimeType: { default: undefined, type: "string" },
    bytes: { default: undefined, type: "number" },
    origin: { default: undefined, type: "string" },
  },
  content: "none",
} as const satisfies CustomInlineContentConfig;

export const agentConfigInlineContentConfig = {
  type: "agentConfig",
  propSchema: {
    mode: { default: "" },
    provider: { default: "" },
    model: { default: "" },
    reasoning: { default: "" },
    speed: { default: "" },
    permission: { default: "" },
    unknownAttributes: { default: "" },
    rawAttributes: { default: "" },
  },
  content: "none",
} as const satisfies CustomInlineContentConfig;

export const dateMentionInlineContentConfig = {
  type: "dateMention",
  propSchema: {
    start: { default: "" },
    end: { default: "" },
    tz: { default: "" },
    format: { default: "" },
    timeFormat: { default: "" },
    reminder: { default: "" },
  },
  content: "none",
} as const satisfies CustomInlineContentConfig;

export const threadMentionInlineContentConfig = {
  type: "threadMention",
  propSchema: {
    uuid: { default: "" },
  },
  content: "none",
} as const satisfies CustomInlineContentConfig;

export const pageMentionInlineContentConfig = {
  type: "pageMention",
  propSchema: {
    targetPageId: { default: "" },
  },
  content: "none",
} as const satisfies CustomInlineContentConfig;

export const blockDocumentCustomBlockConfigs = {
  callout: calloutBlockConfig,
  threadSection: threadSectionBlockConfig,
  page: pageBlockConfig,
  database: databaseBlockConfig,
  canvas: canvasBlockConfig,
  pageRef: pageRefBlockConfig,
  databaseViewRef: databaseViewRefBlockConfig,
  syncedBlockRef: syncedBlockRefBlockConfig,
  templateRef: reusableTemplateRefBlockConfig,
  mathBlock: mathBlockConfig,
} as const;

export const blockDocumentCustomInlineContentConfigs = {
  agentConfig: agentConfigInlineContentConfig,
  attachment: attachmentInlineContentConfig,
  dateMention: dateMentionInlineContentConfig,
  pageMention: pageMentionInlineContentConfig,
  threadMention: threadMentionInlineContentConfig,
  math: mathInlineContentConfig,
} as const;
