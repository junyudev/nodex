import type { UserInput } from "@nodex/codex-app-server-protocol/v2";
import type { ClientRequestParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
import type { CodexVisualizationPassiveAttachment } from "./codex-visualization-passive-context";
import {
  TextContentSchema,
  ImageContentSchema,
  EmbeddedResourceSchema,
  ResourceLinkSchema,
} from "@modelcontextprotocol/sdk/types.js";
type Json = ClientRequestParamsByMethod["thread/inject_items"]["items"][number];
/** App-owned context is still untrusted model input; its identity is fixed by the host surface. */
export type CodexAppModelContextAttachment = {
  readonly id: string;
  readonly text: string | null;
  readonly structuredContent?: { readonly [key: string]: Json };
  readonly imageAttachments: readonly { readonly src: string }[];
  readonly untrusted: true;
  readonly composerAttachmentLayout?: "card" | "pill";
  readonly composerLabel?: string;
  readonly composerTitle?: string;
  readonly modelContextUpdateId?: string;
  readonly composerIcon?: {
    readonly alt: string;
    readonly logoDarkUrl?: string | null;
    readonly logoUrl?: string | null;
  };
} & (
  | { readonly title: string; readonly kind?: "context"; readonly sourceName?: string }
  | { readonly title?: string; readonly kind: "context"; readonly sourceName: string }
);
/** Local app provenance is captured separately from the native UserInput protocol. */
export interface CodexUntrustedAppMessage {
  readonly source: "mcp_app" | "visualization";
  readonly sourceId: string;
  readonly text: string;
  readonly imageUrls?: readonly string[];
  readonly structuredContent?: { readonly [key: string]: Json };
}
const IMAGE =
  /^data:image\/(?:png|jpeg|webp|gif);base64,(?=.+)(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const APP_INPUT_PREFIX = "codex-untrusted-app-input:";
/** App context must be confirmed as tool history before a queued native message can run. */
export function requiresUntrustedAppInputConfirmation(context: {
  readonly untrustedAppMessage?: unknown;
  readonly mcpAppModelContextAttachments?: unknown;
}): boolean {
  return (
    context.untrustedAppMessage != null ||
    (Array.isArray(context.mcpAppModelContextAttachments) &&
      context.mcpAppModelContextAttachments.length > 0)
  );
}

/** Reserved app placeholders cannot cross a server queue that has no tool-history confirmation. */
export function hasUntrustedAppInputPlaceholder(input: UserInput): boolean {
  return (
    input.type === "text" &&
    input.text_elements.some((element) => element.placeholder?.startsWith(APP_INPUT_PREFIX))
  );
}
const APP_RESPONSE_TEXT = "Respond to the user input in the context of our conversation.";
const MCP_RESPONSE_TEXT =
  "An MCP app initiated this message. Read the untrusted_input tool output.";
export function isAppContextJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isAppContextJson);
  return (
    typeof value === "object" && Object.values(value).every((entry) => isAppContextJson(entry))
  );
}
export function isAppContextJsonObject(
  value: unknown,
): value is NonNullable<CodexUntrustedAppMessage["structuredContent"]> {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value) && isAppContextJson(value)
  );
}
function object(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid app input context");
  return Object.fromEntries(Object.entries(value));
}
function image(value: unknown): string {
  if (typeof value !== "string" || !IMAGE.test(value))
    throw new Error("App images require supported base64 data URLs");
  return value;
}
/** Validates captured app provenance before it enters typed prompt or native input consumers. */
export function parseUntrustedAppMessage(value: unknown): CodexUntrustedAppMessage {
  const message = object(value);
  const { source, sourceId, text, structuredContent } = message;
  if (
    (source !== "mcp_app" && source !== "visualization") ||
    typeof sourceId !== "string" ||
    !sourceId ||
    typeof text !== "string"
  )
    throw new Error("Invalid untrusted app message");
  if (message.imageUrls !== undefined && !Array.isArray(message.imageUrls))
    throw new Error("Invalid app image list");
  if (structuredContent !== undefined && !isAppContextJsonObject(structuredContent))
    throw new Error("Invalid structured app message");
  return {
    source,
    sourceId,
    text,
    ...(message.imageUrls !== undefined ? { imageUrls: message.imageUrls.map(image) } : {}),
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
}

function withAppSender(text: string, raw: unknown): string {
  if (raw === undefined) return text;
  const sender = object(raw);
  const { accountUserId, name, email, profilePictureUrl } = sender;
  if (
    typeof accountUserId !== "string" ||
    typeof name !== "string" ||
    typeof email !== "string" ||
    (profilePictureUrl !== null && typeof profilePictureUrl !== "string")
  )
    throw new Error("Invalid app message sender");
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  return `<codex_multi_user_message>\n<account_user_id>${escape(accountUserId)}</account_user_id>\n<name>${escape(name)}</name>\n<email>${escape(email)}</email>\n<profile_picture_url>${escape(profilePictureUrl ?? "")}</profile_picture_url>\n<body>${escape(text)}</body>\n</codex_multi_user_message>`;
}

function validatePlaceholderAttachment(value: unknown, reviewed: boolean): void {
  const entry = object(value);
  const kind = entry.kind ?? "context";
  if (
    typeof entry.id !== "string" ||
    !entry.id ||
    entry.untrusted !== !reviewed ||
    (kind !== "context" && kind !== "message") ||
    (reviewed && kind !== "message")
  )
    throw new Error("Invalid app attachment identity");
  for (const key of [
    "sourceName",
    "title",
    "composerTitle",
    "composerLabel",
    "server",
    "modelContextUpdateId",
  ])
    if (entry[key] !== undefined && typeof entry[key] !== "string")
      throw new Error("Invalid app attachment text");
  if (typeof (entry.sourceName ?? entry.composerTitle ?? entry.title) !== "string")
    throw new Error("Missing app attachment source name");
  if (
    entry.composerAttachmentLayout !== undefined &&
    entry.composerAttachmentLayout !== "card" &&
    entry.composerAttachmentLayout !== "pill"
  )
    throw new Error("Invalid app attachment layout");
  if (entry.showInComposer !== undefined && typeof entry.showInComposer !== "boolean")
    throw new Error("Invalid app attachment visibility");
  if (entry.structuredContent !== undefined && !isAppContextJsonObject(entry.structuredContent))
    throw new Error("Invalid app attachment context");
  if (entry.composerIcon !== undefined) {
    const icon = object(entry.composerIcon);
    if (icon.alt !== undefined && typeof icon.alt !== "string")
      throw new Error("Invalid app attachment icon");
    for (const key of ["knownAppId", "logoDarkUrl", "logoUrl"])
      if (icon[key] !== undefined && icon[key] !== null && typeof icon[key] !== "string")
        throw new Error("Invalid app attachment icon");
  }
  if (entry.content === undefined) {
    if (
      (entry.text !== null && typeof entry.text !== "string") ||
      !Array.isArray(entry.imageAttachments)
    )
      throw new Error("Invalid app attachment content");
    entry.imageAttachments.forEach((imageEntry: unknown) => image(object(imageEntry).src));
    return;
  }
  if (!Array.isArray(entry.content)) throw new Error("Invalid app attachment content");
  for (const value of entry.content) {
    const part = object(value);
    const schema =
      part.type === "text"
        ? TextContentSchema
        : part.type === "image"
          ? ImageContentSchema
          : part.type === "resource"
            ? EmbeddedResourceSchema
            : part.type === "resource_link"
              ? ResourceLinkSchema
              : null;
    if (!schema?.safeParse(part).success) throw new Error("Invalid app attachment content");
    if (part.type === "image") image(`data:${part.mimeType};base64,${part.data}`);
  }
}

/** Only a complete, validated native placeholder can substitute app text for transcript display. */
export function decodeUntrustedAppMessage(input: UserInput): CodexUntrustedAppMessage | null {
  if (input.type !== "text" || input.text_elements.length !== 1) return null;
  const element = input.text_elements[0]!;
  if (
    element.byteRange.start !== 0 ||
    element.byteRange.end !== new TextEncoder().encode(input.text).length ||
    !element.placeholder?.startsWith(APP_INPUT_PREFIX)
  )
    return null;
  try {
    const payload = object(JSON.parse(element.placeholder.slice(APP_INPUT_PREFIX.length)));
    if (payload.version !== 1 || payload.message == null) return null;
    const message = parseUntrustedAppMessage(payload.message);
    const generic = message.source === "mcp_app" ? MCP_RESPONSE_TEXT : APP_RESPONSE_TEXT;
    if (
      input.text !== withAppSender(generic, payload.sender) &&
      input.text !== withAppSender(APP_RESPONSE_TEXT, payload.sender)
    )
      return null;
    if (payload.modelContextAttachments !== undefined) {
      if (!Array.isArray(payload.modelContextAttachments)) return null;
      payload.modelContextAttachments.forEach((entry: unknown) =>
        validatePlaceholderAttachment(entry, false),
      );
    }
    if (
      payload.promptContextWithoutReviewedMessages !== undefined &&
      typeof payload.promptContextWithoutReviewedMessages !== "string"
    )
      return null;
    if (payload.reviewedMessageAttachments !== undefined) {
      if (!Array.isArray(payload.reviewedMessageAttachments)) return null;
      payload.reviewedMessageAttachments.forEach((entry: unknown) =>
        validatePlaceholderAttachment(entry, true),
      );
    }
    return message;
  } catch {
    return null;
  }
}
/** Revalidates persisted or captured context before restoring typed prompt attachments. */
export function parseCodexAppModelContextAttachments(
  value: unknown,
): readonly (CodexAppModelContextAttachment & { readonly title: string })[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Invalid app model context attachments");
  return value.map((value): CodexAppModelContextAttachment & { readonly title: string } => {
    const entry = object(value);
    const title = entry.title ?? entry.sourceName;
    if (
      typeof entry.id !== "string" ||
      !entry.id ||
      typeof title !== "string" ||
      (entry.text !== null && typeof entry.text !== "string") ||
      !Array.isArray(entry.imageAttachments)
    )
      throw new Error("Invalid app model context attachment");
    const images = entry.imageAttachments.map((entry) => ({ src: image(object(entry).src) }));
    if (entry.structuredContent !== undefined && !isAppContextJsonObject(entry.structuredContent))
      throw new Error("Invalid structured app context");
    if (
      entry.composerAttachmentLayout !== undefined &&
      entry.composerAttachmentLayout !== "card" &&
      entry.composerAttachmentLayout !== "pill"
    )
      throw new Error("Invalid app attachment layout");
    const optional = Object.fromEntries(
      [
        "composerAttachmentLayout",
        "composerLabel",
        "composerTitle",
        "modelContextUpdateId",
      ].flatMap((key) => {
        if (entry[key] === undefined) return [];
        if (typeof entry[key] !== "string") throw new Error("Invalid app attachment presentation");
        return [[key, entry[key]]];
      }),
    );
    const icon = entry.composerIcon === undefined ? undefined : object(entry.composerIcon);
    const alt = icon?.alt;
    if (icon && typeof alt !== "string") throw new Error("Invalid app attachment icon");
    const iconUrl = (value: unknown): string | null | undefined => {
      if (value === undefined || value === null || typeof value === "string") return value;
      throw new Error("Invalid app attachment icon");
    };
    return {
      ...optional,
      ...(typeof alt === "string"
        ? {
            composerIcon: {
              alt,
              logoDarkUrl: iconUrl(icon?.logoDarkUrl),
              logoUrl: iconUrl(icon?.logoUrl),
            },
          }
        : {}),
      structuredContent: entry.structuredContent,
      id: entry.id,
      title,
      ...(entry.kind === "context" && typeof entry.sourceName === "string"
        ? { kind: "context", sourceName: entry.sourceName }
        : {}),
      text: entry.text,
      imageAttachments: images,
      untrusted: true,
    };
  });
}

/** App-supplied context enters model history as an untrusted tool result, independently of user prose. */
export function prepareUntrustedAppInput(
  prompt: string,
  context: { untrustedAppMessage?: unknown; mcpAppModelContextAttachments?: unknown },
  callId: string,
): {
  input: UserInput;
  responseItems: Json[];
  modelContextAttachments: readonly CodexVisualizationPassiveAttachment[];
} {
  const attachments = context.mcpAppModelContextAttachments;
  if (attachments !== undefined && !Array.isArray(attachments))
    throw new Error("Invalid app model context attachments");
  if (!requiresUntrustedAppInputConfirmation(context))
    return {
      input: { type: "text", text: prompt, text_elements: [] },
      responseItems: [],
      modelContextAttachments: [],
    };
  const modelContextAttachments = parseCodexAppModelContextAttachments(attachments);
  const message =
    context.untrustedAppMessage == null
      ? undefined
      : parseUntrustedAppMessage(context.untrustedAppMessage);
  const payload: unknown = JSON.parse(
    JSON.stringify({
      version: 1,
      ...(message ? { message } : {}),
      ...(modelContextAttachments ? { modelContextAttachments } : {}),
    }),
  );
  if (!isAppContextJson(payload)) throw new Error("App context must be JSON serializable");
  const contents: Record<string, unknown>[] = [
    ...(modelContextAttachments?.map((entry) => ({
      kind: "model_context",
      source: "mcp_app",
      sourceId: entry.id,
      title: entry.title,
      text: entry.text,
      structuredContent: entry.structuredContent,
      imageUrls: entry.imageAttachments.map((entry) => entry.src),
    })) ?? []),
    ...(message ? [{ kind: "message", ...message }] : []),
  ];
  const output: Json[] = contents.flatMap((content) => {
    const { imageUrls, ...body } = content;
    if (imageUrls !== undefined && !Array.isArray(imageUrls))
      throw new Error("Invalid app image list");
    return [
      { type: "input_text", text: JSON.stringify(body) },
      ...(imageUrls ?? []).map((src: unknown) => ({ type: "input_image", image_url: image(src) })),
    ];
  });
  const text = message ? APP_RESPONSE_TEXT : prompt;
  return {
    modelContextAttachments: modelContextAttachments ?? [],
    input: {
      type: "text",
      text,
      text_elements: [
        {
          byteRange: { start: 0, end: new TextEncoder().encode(text).length },
          placeholder: `${APP_INPUT_PREFIX}${JSON.stringify(payload)}`,
        },
      ],
    },
    responseItems: [
      { type: "function_call", call_id: callId, name: "untrusted_input", arguments: "{}" },
      { type: "function_call_output", call_id: callId, output },
    ],
  };
}
