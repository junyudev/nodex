import type { CodexUserAttachment } from "./types";
import { parseAgentRuntimeAttachmentSource } from "./agent-runtime-attachments";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function normalizeTypeName(type: string): string {
  return type.replace(/[_\-\s]/g, "").toLowerCase();
}

function isType(type: string, accepted: readonly string[]): boolean {
  const normalized = normalizeTypeName(type);
  return accepted.some((candidate) => normalizeTypeName(candidate) === normalized);
}

function getString(
  candidate: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = candidate[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function buildUserAttachmentId(itemId: string, kind: string, index: number): string {
  return `${itemId}:attachment:${kind}:${index}`;
}

function normalizeRemotePointerSource(value: string): string {
  return /^(?:file-service|sediment):\/\//u.test(value) ? value : `file-service://${value}`;
}

export function buildCodexUserAttachmentsFromContent(
  content: readonly unknown[],
  itemId: string,
): CodexUserAttachment[] {
  const fileAttachments: CodexUserAttachment[] = [];
  const imageAttachments: CodexUserAttachment[] = [];

  content.forEach((entry, index) => {
    const input = asRecord(entry);
    if (!input) return;

    const type = getString(input, ["type"]) ?? "";
    if (isType(type, ["image"])) {
      const fileId = getString(input, ["fileId"]);
      const source = getString(input, ["url", "source"]);
      const imageSource = source || fileId;
      if (!imageSource) return;
      imageAttachments.push({
        type: "image",
        id: buildUserAttachmentId(itemId, "image", index),
        source: source || normalizeRemotePointerSource(imageSource),
        sourceKind:
          source && !parseAgentRuntimeAttachmentSource(source) ? "inline-image" : "remote-pointer",
        caption: getString(input, ["caption", "name"]),
      });
      return;
    }

    if (isType(type, ["localImage"])) {
      const source = getString(input, ["path", "source"]);
      if (!source) return;
      imageAttachments.push({
        type: "image",
        id: buildUserAttachmentId(itemId, "local-image", index),
        source,
        sourceKind: "local-image",
        caption: getString(input, ["caption", "name"]),
      });
      return;
    }

    if (isType(type, ["image_asset_pointer", "imageAssetPointer", "assetPointer"])) {
      const pointer = getString(input, [
        "asset_pointer",
        "assetPointer",
        "pointer",
        "file_id",
        "fileId",
      ]);
      if (!pointer) return;
      imageAttachments.push({
        type: "image",
        id: buildUserAttachmentId(itemId, "remote-image", index),
        source: normalizeRemotePointerSource(pointer),
        sourceKind: "remote-pointer",
        caption: getString(input, ["caption", "name"]),
      });
      return;
    }

    if (!isType(type, ["mention", "skill"])) return;
    const name = getString(input, ["name"])?.trim();
    const attachmentPath = getString(input, ["path"])?.trim();
    if (!name || !attachmentPath) return;
    fileAttachments.push({
      type: "file",
      id: buildUserAttachmentId(itemId, normalizeTypeName(type), index),
      label: name,
      path: attachmentPath,
      sourceKind: isType(type, ["skill"]) ? "skill" : "mention",
    });
  });

  return [...fileAttachments, ...imageAttachments];
}

function buildSidecarUserAttachments(
  attachments: unknown,
  itemId: string,
  content: readonly unknown[],
  contentAttachments: readonly CodexUserAttachment[],
): CodexUserAttachment[] {
  if (!Array.isArray(attachments)) return [];

  const contentPaths = new Set([
    ...contentAttachments.flatMap((attachment) =>
      attachment.type === "file" ? [attachment.path] : [],
    ),
    ...content.flatMap((entry) => {
      const candidate = asRecord(entry);
      if (!candidate || !isType(getString(candidate, ["type"]) ?? "", ["localImage"])) {
        return [];
      }
      const path = getString(candidate, ["path"])?.trim();
      return path ? [path] : [];
    }),
  ]);

  return attachments.flatMap((attachment, index): CodexUserAttachment[] => {
    const candidate = asRecord(attachment);
    const attachmentPath = getString(candidate ?? {}, ["path", "fsPath"])?.trim();
    const attachmentFsPath = getString(candidate ?? {}, ["fsPath", "path"])?.trim();
    if (!attachmentPath || !attachmentFsPath || contentPaths.has(attachmentFsPath)) {
      return [];
    }

    return [
      {
        type: "file",
        id: buildUserAttachmentId(itemId, "file", index),
        label: getString(candidate ?? {}, ["label", "name"])?.trim() || attachmentPath,
        path: attachmentPath,
        sourceKind: "mention",
      },
    ];
  });
}

/** Projects app-owned attachment sidecars together with generated user input. */
export function buildCodexUserAttachmentsFromInput(
  content: readonly unknown[],
  attachments: unknown,
  itemId: string,
): CodexUserAttachment[] {
  const contentAttachments = buildCodexUserAttachmentsFromContent(content, itemId);
  const sidecarAttachments = buildSidecarUserAttachments(
    attachments,
    itemId,
    content,
    contentAttachments,
  );
  return [...sidecarAttachments, ...contentAttachments];
}
