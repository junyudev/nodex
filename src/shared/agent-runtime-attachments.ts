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
