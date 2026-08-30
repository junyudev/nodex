import type { UserInput } from "@nodex/codex-app-server-protocol/v2";
import { dedupeCodexLiveFileAttachments } from "./codex-live-file-attachments";
import { parseInlineContent } from "./nfm";
import {
  REVIEW_DIFF_COMMENTS_ADDITIONAL_CONTEXT_KEY,
  serializeReviewDiffCommentAttachmentForPrompt,
  serializeReviewDiffCommentAttachmentsForAdditionalContext,
} from "./review-diff-comments";
import {
  BROWSER_ANNOTATIONS_ADDITIONAL_CONTEXT_KEY,
  BrowserAnnotationAttachmentSchema,
  serializeBrowserAnnotationAttachmentForPrompt,
  serializeBrowserAnnotationAttachmentsForAdditionalContext,
} from "./browser-annotation";
import {
  CODEX_APPSHOTS_ADDITIONAL_CONTEXT_KEY,
  serializeCodexAppshotContextsForPrompt,
} from "./codex-appshot";
import type {
  CodexPreparedPrompt,
  CodexPromptAgentConfigInput,
  CodexPromptInput,
  CodexReviewDiffCommentAttachment,
} from "./types";

export type PreparedCodexPrompt = CodexPreparedPrompt;

export interface PrepareCodexPromptOptions {
  readonly resolveImageInput: (source: string) => UserInput | Promise<UserInput>;
  readonly allowEmptyTextPlaceholder?: boolean;
}

export function createCodexTextUserInput(text: string): UserInput {
  return {
    type: "text",
    text,
    text_elements: [],
  };
}

/** A deliberate userless turn used to continue an interrupted thread. */
export function createEmptyCodexPreparedPrompt(): PreparedCodexPrompt {
  return {
    promptText: "",
    inputItems: [],
    pendingInputItems: [],
    fileAttachments: [],
    addedFiles: [],
    pastedTextAttachments: [],
    commentAttachments: [],
    agentConfigs: [],
  };
}

function parsePromptAgentConfigLine(line: string): CodexPromptAgentConfigInput | null {
  const parsed = parseInlineContent(line.trim());
  if (parsed.length !== 1) return null;

  const [item] = parsed;
  if (item?.type !== "agentConfig") return null;

  return {
    ...(item.mode ? { mode: item.mode } : {}),
    ...(item.provider ? { provider: item.provider } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.reasoning ? { reasoning: item.reasoning } : {}),
    ...(item.speed ? { speed: item.speed } : {}),
    ...(item.permission ? { permission: item.permission } : {}),
    ...(item.unknownAttributes?.length ? { unknownAttributes: item.unknownAttributes } : {}),
  };
}

export function splitCodexPromptAgentConfigLines(prompt: string): {
  readonly text: string;
  readonly agentConfigs: readonly CodexPromptAgentConfigInput[];
} {
  const agentConfigs: CodexPromptAgentConfigInput[] = [];
  const textLines: string[] = [];

  for (const line of prompt.replace(/\r\n/g, "\n").split("\n")) {
    const agentConfig = parsePromptAgentConfigLine(line);
    if (!agentConfig) {
      textLines.push(line);
      continue;
    }
    agentConfigs.push(agentConfig);
  }

  return {
    text: textLines.join("\n"),
    agentConfigs,
  };
}

/** Reads Agent config sidecars without materializing any other prompt inputs. */
export function collectCodexPromptAgentConfigs(
  prompt: string,
  promptInput: CodexPromptInput | undefined,
): readonly CodexPromptAgentConfigInput[] {
  return promptInput
    ? [...(promptInput.agentConfigs ?? [])]
    : splitCodexPromptAgentConfigLines(prompt).agentConfigs;
}

function resolveMentionInput(input: { readonly name: string; readonly path: string }): UserInput {
  const name = input.name.trim();
  const mentionPath = input.path.trim();
  if (!name || !mentionPath) {
    throw new Error("Mention input requires a name and path");
  }
  return { type: "mention", name, path: mentionPath };
}

function resolveSkillInput(input: { readonly name: string; readonly path: string }): UserInput {
  const name = input.name.trim();
  const skillPath = input.path.trim();
  if (!name || !skillPath) {
    throw new Error("Skill input requires a name and path");
  }
  return { type: "skill", name, path: skillPath };
}

function resolveDocumentInput(
  input: NonNullable<CodexPromptInput["documentItems"]>[number],
): UserInput {
  switch (input.type) {
    case "text":
      return createCodexTextUserInput(input.text);
    case "mention":
      return resolveMentionInput(input);
    case "skill":
      return resolveSkillInput(input);
  }
}

function buildReviewDiffCommentAdditionalContext(
  commentAttachments: readonly CodexReviewDiffCommentAttachment[],
): CodexPreparedPrompt["additionalContext"] {
  if (commentAttachments.length === 0) return undefined;

  return {
    [REVIEW_DIFF_COMMENTS_ADDITIONAL_CONTEXT_KEY]: {
      kind: "application",
      value: serializeReviewDiffCommentAttachmentsForAdditionalContext(commentAttachments),
    },
  };
}

function buildApplicationAdditionalContext(input: {
  readonly commentAttachments: readonly CodexReviewDiffCommentAttachment[];
  readonly browserAnnotationAttachments: NonNullable<
    CodexPromptInput["browserAnnotationAttachments"]
  >;
  readonly appshots: NonNullable<CodexPromptInput["appshots"]>;
}): NonNullable<CodexPreparedPrompt["additionalContext"]> {
  const context: NonNullable<CodexPreparedPrompt["additionalContext"]> = {
    ...(buildReviewDiffCommentAdditionalContext(input.commentAttachments) ?? {}),
  };
  if (input.browserAnnotationAttachments.length > 0) {
    context[BROWSER_ANNOTATIONS_ADDITIONAL_CONTEXT_KEY] = {
      kind: "application",
      value: serializeBrowserAnnotationAttachmentsForAdditionalContext(
        input.browserAnnotationAttachments,
      ),
    };
  }
  if (input.appshots.length > 0) {
    context[CODEX_APPSHOTS_ADDITIONAL_CONTEXT_KEY] = {
      kind: "application",
      value: serializeCodexAppshotContextsForPrompt(input.appshots),
    };
  }
  return context;
}

/**
 * Compiles one app-owned prompt into the exact app-server input used by both the
 * optimistic mutation and the transport request. Environment and permission
 * policy remain outside this function and are resolved by the main-process
 * command boundary.
 */
export async function prepareCodexPrompt(
  prompt: string,
  promptInput: CodexPromptInput | undefined,
  options: PrepareCodexPromptOptions,
): Promise<PreparedCodexPrompt> {
  const parsedPrompt = promptInput
    ? {
        text: promptInput.text,
        agentConfigs: promptInput.agentConfigs ?? [],
      }
    : splitCodexPromptAgentConfigLines(prompt);
  const promptText = parsedPrompt.text;
  const pastedTextAttachments: CodexPromptInput["textAttachments"] = (
    promptInput?.textAttachments ?? []
  ).map((attachment) => ({
    ...attachment,
    ...(attachment.file === undefined ? {} : { file: { ...attachment.file } }),
  }));
  const imageItems = await Promise.all(
    (promptInput?.images ?? []).map((image) => options.resolveImageInput(image.source)),
  );
  const appshots = (promptInput?.appshots ?? []).map((appshot) => ({
    ...appshot,
  }));
  const appshotImageItems = await Promise.all(
    appshots.map((appshot) => options.resolveImageInput(appshot.imageDataUrl)),
  );
  const skillItems = (promptInput?.skills ?? []).map(resolveSkillInput);
  const explicitMentionItems = (promptInput?.mentions ?? []).map(resolveMentionInput);
  const documentItems = promptInput?.documentItems?.map(resolveDocumentInput);
  const explicitFileAttachments = dedupeCodexLiveFileAttachments(
    promptInput?.fileAttachments ?? [],
  );
  const fileAttachments = explicitFileAttachments;
  const addedFiles = dedupeCodexLiveFileAttachments(promptInput?.addedFiles ?? []);
  const ordinaryMentionPaths = new Set<string>();
  const mentionItems = [...fileAttachments, ...addedFiles].flatMap((attachment) => {
    if (ordinaryMentionPaths.has(attachment.path)) return [];
    ordinaryMentionPaths.add(attachment.path);
    return [resolveMentionInput({ name: attachment.label, path: attachment.path })];
  });
  const commentAttachments = (promptInput?.commentAttachments ?? []).filter((attachment) =>
    attachment.content.some((part) => part.content_type === "text" && part.text.trim().length > 0),
  );
  const commentItems = commentAttachments.map((attachment) =>
    createCodexTextUserInput(serializeReviewDiffCommentAttachmentForPrompt(attachment)),
  );
  const browserAnnotationAttachments = (promptInput?.browserAnnotationAttachments ?? []).map(
    (attachment) => BrowserAnnotationAttachmentSchema.parse(attachment),
  );
  const browserAnnotationItems = browserAnnotationAttachments.map((attachment) =>
    createCodexTextUserInput(serializeBrowserAnnotationAttachmentForPrompt(attachment)),
  );
  const browserAnnotationEvidenceItems = await Promise.all(
    browserAnnotationAttachments.flatMap((attachment) =>
      attachment.evidence ? [options.resolveImageInput(attachment.evidence.source)] : [],
    ),
  );
  const additionalContext = buildApplicationAdditionalContext({
    commentAttachments,
    browserAnnotationAttachments,
    appshots,
  });
  const primaryTextItems = promptText ? [createCodexTextUserInput(promptText)] : [];
  const primaryDocumentItems = documentItems ?? primaryTextItems;
  const inputItems: UserInput[] = [
    ...primaryDocumentItems,
    ...commentItems,
    ...browserAnnotationItems,
    ...browserAnnotationEvidenceItems,
    ...appshotImageItems,
    ...imageItems,
    ...(documentItems === undefined ? explicitMentionItems : []),
    ...mentionItems,
    ...(documentItems === undefined ? skillItems : []),
  ];
  const pendingInputItems: UserInput[] = [
    ...primaryDocumentItems,
    ...commentItems,
    ...browserAnnotationItems,
    ...browserAnnotationEvidenceItems,
    ...appshotImageItems,
    ...imageItems,
    ...(documentItems === undefined ? explicitMentionItems : []),
    ...(documentItems === undefined ? skillItems : []),
  ];

  if (options.allowEmptyTextPlaceholder === true && promptText.length === 0) {
    inputItems.unshift(createCodexTextUserInput(""));
    pendingInputItems.unshift(createCodexTextUserInput(""));
  }
  if (inputItems.length === 0 && pastedTextAttachments.length === 0) {
    throw new Error("Prompt requires non-empty text or at least one image");
  }

  return {
    promptText,
    inputItems,
    pendingInputItems,
    fileAttachments,
    addedFiles,
    pastedTextAttachments,
    ...(Object.keys(additionalContext).length > 0 ? { additionalContext } : {}),
    commentAttachments,
    agentConfigs: [...parsedPrompt.agentConfigs],
  };
}
