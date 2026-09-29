import { serializeBrowserAnnotationAttachmentForPrompt } from "./browser-annotation";
import { serializeReviewDiffCommentAttachmentForPrompt } from "./review-diff-comments";
import type { CodexLiveFileAttachment, CodexPromptInput } from "./types";

/** Compile the shared editor's text and local references for a text-capable Agent. */
export async function prepareAgentPrompt(
  prompt: string,
  input: CodexPromptInput | undefined,
  readPastedText: (file: CodexLiveFileAttachment) => Promise<string>,
): Promise<string> {
  if (!input) return prompt;
  if (
    input.images?.length ||
    input.appshots?.length ||
    input.browserAnnotationAttachments?.some((attachment) => attachment.evidence)
  ) {
    throw new Error(
      "This Agent connection does not support image attachments. Remove the images to send this message.",
    );
  }
  if (input.agentConfigs?.length) {
    throw new Error("Use the model and mode menus to configure this Agent.");
  }
  const reference = ({ name, path }: { name: string; path: string }) => `[${name}](${path})`;
  const body =
    input.documentItems
      ?.map((item) => (item.type === "text" ? item.text : reference(item)))
      .join("") ?? input.text;
  // The composer deletes temporary paste files after admission. Read their full contents first.
  const pastedText = await Promise.all(
    (input.textAttachments ?? []).map((attachment) =>
      "text" in attachment ? attachment.text : readPastedText(attachment.file),
    ),
  );
  const context = [
    ...(input.documentItems
      ? []
      : [...(input.mentions ?? []), ...(input.skills ?? [])].map(reference)),
    ...[...(input.fileAttachments ?? []), ...(input.addedFiles ?? [])].map(
      (file) =>
        reference({ name: file.label, path: file.fsPath || file.path }) +
        (file.startLine ? `:${file.startLine}${file.endLine ? `-${file.endLine}` : ""}` : ""),
    ),
    ...pastedText,
    ...(input.commentAttachments ?? []).map(serializeReviewDiffCommentAttachmentForPrompt),
    ...(input.browserAnnotationAttachments ?? []).map(
      serializeBrowserAnnotationAttachmentForPrompt,
    ),
  ];
  return [body, ...new Set(context)].filter(Boolean).join("\n\n");
}
