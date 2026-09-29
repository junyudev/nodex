import { serializeBrowserAnnotationAttachmentForPrompt } from "./browser-annotation";
import { serializeReviewDiffCommentAttachmentForPrompt } from "./review-diff-comments";
import type { CodexLiveFileAttachment, CodexPromptInput } from "./types";

/** Compile the shared editor's text and local references for a text-capable Agent. */
export async function prepareAgentPrompt(
  prompt: string,
  input: CodexPromptInput | undefined,
  readPastedText: (file: CodexLiveFileAttachment) => Promise<string>,
  capabilities?: { readonly images?: boolean; readonly nativeSkills?: boolean },
): Promise<string> {
  if (!input) return prompt;
  if (
    !capabilities?.images &&
    (input.images?.length ||
      input.appshots?.length ||
      input.browserAnnotationAttachments?.some((attachment) => attachment.evidence))
  ) {
    throw new Error(
      "This Agent connection does not support image attachments. Remove the images to send this message.",
    );
  }
  if (input.agentConfigs?.length) {
    throw new Error("Use the model and mode menus to configure this Agent.");
  }
  const reference = ({ name, path }: { name: string; path: string }) => `[${name}](${path})`;
  const nativeSkills = capabilities?.nativeSkills
    ? (input.documentItems?.filter((item) => item.type === "skill") ?? input.skills ?? [])
    : [];
  const invocation = nativeSkills.at(-1);
  if (invocation && !/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/u.test(invocation.name))
    throw new Error("The selected skill has an invalid command name");
  const skill = (value: { name: string; path: string }) => {
    if (!capabilities?.nativeSkills) return reference(value);
    return value === invocation ? "" : `/${value.name}`;
  };
  const body =
    input.documentItems
      ?.map((item) =>
        item.type === "text" ? item.text : item.type === "skill" ? skill(item) : reference(item),
      )
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
      : [...(input.mentions ?? []).map(reference), ...(input.skills ?? []).map(skill)]),
    ...(input.appshots ?? []).map(
      (appshot) =>
        `${appshot.appName}${appshot.windowTitle ? ` — ${appshot.windowTitle}` : ""}\n${appshot.axTree}`,
    ),
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
  const text = [body, ...new Set(context)].filter(Boolean).join("\n\n");
  // Claude expands one invocation at the start of its final text block; all prose remains arguments.
  return invocation ? `/${invocation.name}${text.trim() ? ` ${text.trim()}` : ""}` : text;
}
