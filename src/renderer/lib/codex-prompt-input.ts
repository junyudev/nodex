import type {
  CodexPromptAgentConfigInput,
  CodexPromptImageInput,
  CodexPromptInput,
} from "@/lib/types";
import {
  blockNoteToNfm,
  extractPlainText,
  serializeClipboardText,
  serializeInlineContent,
  type NfmBlock,
  type NfmInlineContent,
} from "@/lib/nfm";

export function buildCodexPromptInputFromBlockNoteBlocks(
  blocks: unknown[],
  transformNfmBlocks?: (nfmBlocks: NfmBlock[]) => void,
): CodexPromptInput {
  const nfmBlocks = blockNoteToNfm(blocks);
  transformNfmBlocks?.(nfmBlocks);
  return buildCodexPromptInputFromNfmBlocks(nfmBlocks);
}

export function buildCodexPromptInputFromNfmBlocks(nfmBlocks: NfmBlock[]): CodexPromptInput {
  const images: CodexPromptImageInput[] = [];
  const agentConfigs: CodexPromptAgentConfigInput[] = [];
  const textBlocks = stripPromptSideEffectsFromBlocks(nfmBlocks, images, agentConfigs);

  return {
    text: trimSerializedPromptText(serializeClipboardText(textBlocks)),
    ...(images.length > 0 ? { images } : {}),
    ...(agentConfigs.length > 0 ? { agentConfigs } : {}),
  };
}

function trimSerializedPromptText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function stripPromptSideEffectsFromBlocks(
  blocks: NfmBlock[],
  images: CodexPromptImageInput[],
  agentConfigs: CodexPromptAgentConfigInput[],
): NfmBlock[] {
  const result: NfmBlock[] = [];

  for (const block of blocks) {
    if (block.type === "image") {
      const captionText = extractPlainText(serializeInlineContent(block.caption)).trim();
      const imageNumber = images.length + 1;
      images.push({
        source: block.source,
        ...(captionText ? { caption: captionText } : {}),
      });
      const placeholder = captionText
        ? `[Image #${imageNumber}] (caption: ${captionText})`
        : `[Image #${imageNumber}]`;
      result.push({
        type: "paragraph",
        content: [{ type: "text", text: placeholder, styles: {} }],
        children: [],
      });
      continue;
    }

    const children = stripPromptSideEffectsFromBlocks(block.children ?? [], images, agentConfigs);
    if ("content" in block && Array.isArray(block.content)) {
      result.push({
        ...block,
        content: stripPromptSideEffectsFromInline(block.content, agentConfigs),
        children,
      } as NfmBlock);
      continue;
    }

    result.push({
      ...block,
      children,
    } as NfmBlock);
  }

  return result;
}

function stripPromptSideEffectsFromInline(
  items: NfmInlineContent[],
  agentConfigs: CodexPromptAgentConfigInput[],
): NfmInlineContent[] {
  const result: NfmInlineContent[] = [];

  for (const item of items) {
    if (item.type === "agentConfig") {
      agentConfigs.push({
        ...(item.mode ? { mode: item.mode } : {}),
        ...(item.provider ? { provider: item.provider } : {}),
        ...(item.model ? { model: item.model } : {}),
        ...(item.reasoning ? { reasoning: item.reasoning } : {}),
        ...(item.speed ? { speed: item.speed } : {}),
        ...(item.permission ? { permission: item.permission } : {}),
        ...(item.unknownAttributes?.length ? { unknownAttributes: item.unknownAttributes } : {}),
      });
      continue;
    }
    result.push(item);
  }

  return result;
}
