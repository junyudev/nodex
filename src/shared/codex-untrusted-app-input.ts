import type { UserInput } from "@nodex/codex-app-server-protocol/v2";
import type { ClientRequestParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
type Json = ClientRequestParamsByMethod["thread/inject_items"]["items"][number];
const IMAGE =
  /^data:image\/(?:png|jpeg|webp|gif);base64,(?=.+)(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export function isAppContextJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isAppContextJson);
  return (
    typeof value === "object" && Object.values(value).every((entry) => isAppContextJson(entry))
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
/** App-supplied context enters model history as an untrusted tool result, independently of user prose. */
export function prepareUntrustedAppInput(
  prompt: string,
  context: { untrustedAppMessage?: unknown; mcpAppModelContextAttachments?: unknown },
  callId: string,
): { input: UserInput; responseItems: Json[] } {
  const attachments = context.mcpAppModelContextAttachments;
  if (attachments !== undefined && !Array.isArray(attachments))
    throw new Error("Invalid app model context attachments");
  if (context.untrustedAppMessage == null && (!attachments || attachments.length === 0))
    return { input: { type: "text", text: prompt, text_elements: [] }, responseItems: [] };
  const modelContextAttachments = attachments?.map((value) => {
    const entry = object(value);
    if (
      typeof entry.id !== "string" ||
      !entry.id ||
      typeof entry.title !== "string" ||
      (entry.text !== null && typeof entry.text !== "string") ||
      !Array.isArray(entry.imageAttachments)
    )
      throw new Error("Invalid app model context attachment");
    const images = entry.imageAttachments.map((entry) => ({ src: image(object(entry).src) }));
    if (
      entry.structuredContent !== undefined &&
      (entry.structuredContent === null ||
        Array.isArray(entry.structuredContent) ||
        typeof entry.structuredContent !== "object" ||
        !isAppContextJson(entry.structuredContent))
    )
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
    if (
      icon &&
      (typeof icon.alt !== "string" ||
        [icon.logoDarkUrl, icon.logoUrl].some(
          (value) => value !== undefined && value !== null && typeof value !== "string",
        ))
    )
      throw new Error("Invalid app attachment icon");
    return {
      ...optional,
      ...(icon
        ? { composerIcon: { alt: icon.alt, logoDarkUrl: icon.logoDarkUrl, logoUrl: icon.logoUrl } }
        : {}),
      structuredContent: entry.structuredContent,
      id: entry.id,
      title: entry.title,
      text: entry.text,
      imageAttachments: images,
      untrusted: true,
    };
  });
  const message =
    context.untrustedAppMessage == null ? undefined : object(context.untrustedAppMessage);
  if (
    message &&
    ((message.source !== "mcp_app" && message.source !== "visualization") ||
      typeof message.sourceId !== "string" ||
      !message.sourceId ||
      typeof message.text !== "string")
  )
    throw new Error("Invalid untrusted app message");
  if (message?.imageUrls !== undefined) {
    if (!Array.isArray(message.imageUrls)) throw new Error("Invalid app image list");
    message.imageUrls = message.imageUrls.map(image);
  }
  if (
    message?.structuredContent !== undefined &&
    (message.structuredContent === null ||
      Array.isArray(message.structuredContent) ||
      typeof message.structuredContent !== "object" ||
      !isAppContextJson(message.structuredContent))
  )
    throw new Error("Invalid structured app message");
  if (message)
    for (const key of Object.keys(message)) {
      if (!["source", "sourceId", "text", "imageUrls", "structuredContent"].includes(key))
        delete message[key];
    }
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
  const text = message ? "Respond to the user input in the context of our conversation." : prompt;
  return {
    input: {
      type: "text",
      text,
      text_elements: [
        {
          byteRange: { start: 0, end: new TextEncoder().encode(text).length },
          placeholder: `codex-untrusted-app-input:${JSON.stringify(payload)}`,
        },
      ],
    },
    responseItems: [
      { type: "function_call", call_id: callId, name: "untrusted_input", arguments: "{}" },
      { type: "function_call_output", call_id: callId, output },
    ],
  };
}
