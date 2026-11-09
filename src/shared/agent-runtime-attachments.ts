export interface AgentRuntimeAttachmentReference {
  readonly sourceThreadId: string;
  readonly itemId: string;
  readonly attachmentId: string;
}

const prefix = "nodex-runtime-image:";
const identity = (value: string) =>
  value.length > 0 &&
  value.length <= 512 &&
  value.trim() === value &&
  !/[\u0000-\u001f]/u.test(value);

/** An image descriptor addresses its recorded native item; it carries no bytes or inferred path. */
export const buildAgentRuntimeAttachmentSource = (
  reference: AgentRuntimeAttachmentReference,
): string =>
  `${prefix}${[reference.sourceThreadId, reference.itemId, reference.attachmentId].map(encodeURIComponent).join("/")}`;

export function parseAgentRuntimeAttachmentSource(
  source: string,
): AgentRuntimeAttachmentReference | null {
  if (!source.startsWith(prefix) || source.length > 16_000) return null;
  const parts = source.slice(prefix.length).split("/");
  if (parts.length !== 3) return null;
  try {
    const [sourceThreadId, itemId, attachmentId] = parts.map(decodeURIComponent);
    if (
      !sourceThreadId ||
      !itemId ||
      !attachmentId ||
      ![sourceThreadId, itemId, attachmentId].every(identity)
    )
      return null;
    return { sourceThreadId, itemId, attachmentId };
  } catch {
    return null;
  }
}

/** The original result-content position is stable even when history omits the image bytes. */
export const buildAgentRuntimeToolResultImageSource = (reference: {
  readonly sourceThreadId: string;
  readonly itemId: string;
  readonly contentIndex: number;
}): string =>
  buildAgentRuntimeAttachmentSource({
    sourceThreadId: reference.sourceThreadId,
    itemId: reference.itemId,
    attachmentId: `tool-result:${reference.contentIndex}`,
  });

const REPLY_PICTURE = "reply-picture:";

/**
 * A picture a reply shows from a file on the machine that ran its chat, named by the address the
 * reply wrote. Only that reply's own pictures are read under it, and only a picture's bytes; an
 * address too long to name is null and shows unavailable.
 */
export const replyPictureAttachmentId = (address: string): string | null => {
  const id = REPLY_PICTURE + address;
  return address.length > 0 && identity(id) ? id : null;
};

export const parseReplyPictureAttachmentId = (attachmentId: string): string | null =>
  attachmentId.startsWith(REPLY_PICTURE) && attachmentId.length > REPLY_PICTURE.length
    ? attachmentId.slice(REPLY_PICTURE.length)
    : null;
